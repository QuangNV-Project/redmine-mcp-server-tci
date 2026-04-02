import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import express from "express";
import { RedmineClient } from "./redmine-client.js";
import {
  buildBranchName,
  createBranch,
  isGitRepo,
} from "./git-helper.js";
import { connectMongo, disconnectMongo } from "./mongo-client.js";
import * as mongo from "./mongo-client.js";
import {
  createCorsMiddleware,
  createHelmetMiddleware,
  createRequestTracingMiddleware,
  createRateLimiter,
} from "./middleware.js";
import { validateNoPathTraversal, validatePositiveInt } from "./types.js";
import type { RepoTarget } from "./types.js";
import { loadWorkflowFromExcel } from "./excel-parser.js";
import { credentialSessionManager, startSessionCleanup } from "./credential-session.js";
import { createWorkflowEngine } from "./workflow-engine.js";
import type { WorkflowDefinition } from "./types.js";
import {
  parseRequirementExcelFromBase64,
  parseRequirementExcelFromPath,
} from "./requirement-excel-parser.js";
import { logger } from "./logger.js";

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const TRANSPORT = (process.env.TRANSPORT || "stdio") as "stdio" | "sse";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MONGODB_URI = process.env.MONGODB_URI_MCP_TCI || "";
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "";

const REDMINE_URL = process.env.REDMINE_TCI_URL || "";
const REDMINE_COOKIE = process.env.REDMINE_COOKIE || "";
const VALIDATE_SSE_CREDENTIALS = process.env.VALIDATE_SSE_CREDENTIALS === "true";
const BRANCH_FORMAT =
  (process.env.BRANCH_FORMAT as "ticket-id" | "ticket-id-title") || "ticket-id-title";

// Workflow configuration
const WORKFLOW_EXCEL_PATH = process.env.WORKFLOW_EXCEL_PATH || "./workflow.xlsx";

if (!REDMINE_URL) {
  logger.error("startup", "Missing required Redmine URL environment variable", {
    expectedVariables: ["REDMINE_TCI_URL"],
  });
  process.exit(1);
}

// Load workflow definition if available
let workflowDef: WorkflowDefinition | null = null;
if (WORKFLOW_EXCEL_PATH && fs.existsSync(WORKFLOW_EXCEL_PATH)) {
  try {
    workflowDef = await loadWorkflowFromExcel(WORKFLOW_EXCEL_PATH);
    logger.info("startup", "Workflow definition loaded", {
      rules: workflowDef.rules.length,
      filePath: WORKFLOW_EXCEL_PATH,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("startup", "Failed to load workflow definition", {
      filePath: WORKFLOW_EXCEL_PATH,
      error: message,
    });
    if (process.env.ENFORCE_STRICT_WORKFLOW === "true") {
      process.exit(1);
    }
  }
}

logger.info("startup", "Configuration loaded", {
  transport: TRANSPORT,
  port: PORT,
  mongoEnabled: !!MONGODB_URI,
  workflowConfigured: !!workflowDef,
  hasFallbackRedmineCookie: !!REDMINE_COOKIE,
  validateSseCredentialsOnConnect: VALIDATE_SSE_CREDENTIALS,
});

// Create default RedmineClient (fallback for static credentials)
const defaultRedmine = new RedmineClient(REDMINE_URL, {
  redmineCookie: REDMINE_COOKIE,
});

const readSingleHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const summarizeToolArgs = (args: unknown): unknown => {
  if (!args || typeof args !== "object") {
    return args;
  }

  const mapped = { ...(args as Record<string, unknown>) };
  if (typeof mapped.excel_base64 === "string") {
    mapped.excel_base64 = `[base64 length=${mapped.excel_base64.length}]`;
  }

  return mapped;
};

// ─── MCP Server ───────────────────────────────────────────────────────────────

const createMcpServer = () =>
  new Server(
    { name: "redmine-mcp-tci", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const registerServerHandlers = (server: Server, defaultCredentialSessionId: string | null = null) => {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ── Redmine tools ──
      {
        name: "get_issue",
        description:
          "Get full details of a Redmine issue/ticket by its ID, including description, status, assignee, and comment history.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "number", description: "The Redmine issue ID (e.g. 1234)" },
            include_journals: {
              type: "boolean",
              description: "Include comment history (default: true)",
            },
            session_id: {
              type: "string",
              description: "Credential session ID (supports cookie-based Redmine access)",
            },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "create_branch_for_issue",
        description:
          'Create and checkout a git branch for a Redmine issue. Auto-detects the correct repo from MongoDB if a project is registered. Use "target" to pick fe or be repo.',
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "number", description: "The Redmine issue ID to create a branch for" },
            target: {
              type: "string",
              enum: ["fe", "be"],
              description: 'Which repo to create the branch in: "fe" or "be"',
            },
            repo_path: {
              type: "string",
              description:
                "Explicit path to git repo (overrides MongoDB lookup). Falls back to GIT_REPO_PATH env.",
            },
            base_branch: {
              type: "string",
              description:
                "Base branch to create from (auto-detected from project config if omitted)",
            },
            prefix: {
              type: "string",
              description: 'Branch prefix (default: "feature"). Use "fix", "hotfix", "chore" etc.',
            },
            session_id: {
              type: "string",
              description: "Credential session ID (supports cookie-based Redmine access)",
            },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "analyze_ticket_with_excel",
        description:
          "Build a coding-ready brief by combining Redmine ticket details with an uploaded/local Excel requirement file.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "number", description: "The Redmine issue ID" },
            excel_path: {
              type: "string",
              description:
                "Path to requirement Excel file (.xlsx) on the MCP server machine. Use either excel_path or excel_base64.",
            },
            excel_base64: {
              type: "string",
              description:
                "Base64 encoded Excel content (.xlsx). Supports raw base64 or data URI format.",
            },
            excel_file_name: {
              type: "string",
              description: "Optional file name label for excel_base64 content.",
            },
            include_journals: {
              type: "boolean",
              description: "Include recent comment history from ticket (default: false)",
            },
            session_id: {
              type: "string",
              description: "Session ID for credential-based access (optional)",
            },
          },
          required: ["issue_id"],
        },
      },

      // ── Workflow tools ──
      {
        name: "validate_ticket_transition",
        description:
          "Validate if a ticket can transition to a new status based on workflow rules. Returns validation errors and available actions.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "number", description: "The Redmine issue ID" },
            to_status_id: {
              type: "number",
              description: "Target status ID to validate transition to",
            },
            session_id: {
              type: "string",
              description: "Session ID for credential-based access (optional)",
            },
          },
          required: ["issue_id", "to_status_id"],
        },
      },
      {
        name: "get_available_transitions",
        description: "Get all valid status transitions available for a ticket based on workflow rules.",
        inputSchema: {
          type: "object",
          properties: {
            issue_id: { type: "number", description: "The Redmine issue ID" },
            session_id: {
              type: "string",
              description: "Session ID for credential-based access (optional)",
            },
          },
          required: ["issue_id"],
        },
      },
      {
        name: "get_ticket_workflow_rules",
        description: "Get workflow rules for a specific tracker type.",
        inputSchema: {
          type: "object",
          properties: {
            tracker_name: {
              type: "string",
              description: 'Tracker name (e.g. "Bug", "Task", "Feature")',
            },
          },
          required: ["tracker_name"],
        },
      },
    ],
  }));

  // ─── Tool Handlers ────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();
    let caughtError: string | null = null;

    logger.info("tool", "Tool call received", {
      tool: name,
      hasDefaultCredentialSession: !!defaultCredentialSessionId,
      args: summarizeToolArgs(args),
    });

    try {
      // Get RedmineClient (with session credentials if provided)
      const getRedmineClient = (sessionId?: string): RedmineClient => {
        const resolvedSessionId =
          sessionId && sessionId.length > 0 ? sessionId : defaultCredentialSessionId || undefined;

        if (resolvedSessionId && resolvedSessionId.length > 0) {
          const creds = credentialSessionManager.getCredentials(resolvedSessionId);
          if (creds) {
            logger.debug("auth", "Using credential session for Redmine client", {
              tool: name,
              sessionId: resolvedSessionId,
              authMode: "cookie",
            });

            const client = new RedmineClient(REDMINE_URL, { redmineCookie: creds.redmineCookie });
            return client;
          }

          logger.warn("auth", "Credential session missing or expired; fallback credentials will be used", {
            tool: name,
            sessionId: resolvedSessionId,
          });
        }

        logger.debug("auth", "Using fallback Redmine credentials", {
          tool: name,
          hasFallbackCookie: !!REDMINE_COOKIE,
          authMode: REDMINE_COOKIE ? "cookie" : "none",
        });
        return defaultRedmine;
      };

      switch (name) {
        // ── get_issue ──
        case "get_issue": {
          const issueId = args?.issue_id as number;
          const err = validatePositiveInt(issueId, "issue_id");
          if (err)
            return {
              content: [{ type: "text", text: `Validation error: ${err.message}` }],
              isError: true,
            };

          const sessionId = args?.session_id as string | undefined;
          const redmine = getRedmineClient(sessionId);
          const includeJournals = args?.include_journals !== false;
          const issue = await redmine.getIssue(issueId, includeJournals);

          const journalsSection =
            issue.journals && issue.journals.length > 0
              ? "\n\n### Comment History\n" +
              issue.journals
                .filter((j) => j.notes)
                .map(
                  (j) =>
                    `**${j.user.name}** (${new Date(j.created_on).toLocaleDateString("vi-VN")}):\n${j.notes}`
                )
                .join("\n\n---\n\n")
              : "";

          const childrenSection =
            issue.children && issue.children.length > 0
              ? "\n\n### Sub-tasks\n" +
              issue.children.map((c) => `- #${c.id}: ${c.subject}`).join("\n")
              : "";

          const content = `# [#${issue.id}] ${issue.subject}

**Project:** ${issue.project.name} (${issue.project.id})
**Tracker:** ${issue.tracker.name}
**Status:** ${issue.status.name}
**Priority:** ${issue.priority.name}
**Author:** ${issue.author.name}
**Assigned to:** ${issue.assigned_to?.name || "Unassigned"}
**Progress:** ${issue.done_ratio}%
**Created:** ${new Date(issue.created_on).toLocaleDateString("vi-VN")}
**Updated:** ${new Date(issue.updated_on).toLocaleDateString("vi-VN")}
${issue.due_date ? `**Due date:** ${issue.due_date}` : ""}

## Description
${issue.description || "_No description provided._"}
${childrenSection}${journalsSection}`;

          return { content: [{ type: "text", text: content }] };
        }

        // ── create_branch_for_issue ──
        case "create_branch_for_issue": {
          const issueId = args?.issue_id as number;
          const err = validatePositiveInt(issueId, "issue_id");
          if (err)
            return {
              content: [{ type: "text", text: `Validation error: ${err.message}` }],
              isError: true,
            };

          const sessionId = args?.session_id as string | undefined;
          const redmine = getRedmineClient(sessionId);
          const target = args?.target as RepoTarget | undefined;
          const prefix = (args?.prefix as string) || "feature";
          const issue = await redmine.getIssue(issueId, false);

          let repoPath: string;
          let baseBranch: string;

          const explicitPath = args?.repo_path as string | undefined;
          const pathErr = validateNoPathTraversal(explicitPath, "repo_path");
          if (pathErr)
            return {
              content: [{ type: "text", text: `Validation error: ${pathErr.message}` }],
              isError: true,
            };

          if (explicitPath) {
            repoPath = explicitPath;
            baseBranch = (args?.base_branch as string) || "main";
          } else if (MONGODB_URI) {
            let projectConfig = await mongo.findProjectByRedmine(
              issue.project.name,
              issue.project.id
            );

            if (!projectConfig) {
              try {
                const redmineProject = await redmine.getProject(String(issue.project.id));
                projectConfig = await mongo.getProjectByRedmineId(redmineProject.identifier);
              } catch {
                /* Redmine project lookup failed, continue to fallback */
              }
            }

            if (projectConfig && target) {
              const repoConfig = projectConfig.repos[target];
              if (!repoConfig) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `No ${target} repo configured for project "${projectConfig.name}". Use register_project to add it.`,
                    },
                  ],
                  isError: true,
                };
              }
              repoPath = repoConfig.path;
              baseBranch = (args?.base_branch as string) || repoConfig.base_branch;
            } else if (projectConfig && !target) {
              const available = Object.keys(projectConfig.repos).join(", ");
              return {
                content: [
                  {
                    type: "text",
                    text: `Project "${projectConfig.name}" has repos: ${available}. Please specify target ("fe" or "be").`,
                  },
                ],
                isError: true,
              };
            } else {
              repoPath = process.env.GIT_REPO_PATH || process.cwd();
              baseBranch = (args?.base_branch as string) || "main";
            }
          } else {
            repoPath = process.env.GIT_REPO_PATH || process.cwd();
            baseBranch = (args?.base_branch as string) || "main";
          }

          if (!isGitRepo(repoPath)) {
            return {
              content: [{ type: "text", text: `Not a git repository: \`${repoPath}\`` }],
              isError: true,
            };
          }

          const branchName = buildBranchName(issueId, issue.subject, BRANCH_FORMAT, prefix);
          const result = createBranch(branchName, repoPath, baseBranch);

          const text = `${result.success ? "**Branch created successfully**" : "**Failed to create branch**"}

**Issue:** #${issue.id} — ${issue.subject}
**Status:** ${issue.status.name} | **Priority:** ${issue.priority.name}
**Assigned to:** ${issue.assigned_to?.name || "Unassigned"}
**Branch:** \`${branchName}\`
**Repo:** \`${repoPath}\`
**Base:** \`${baseBranch}\`
${result.alreadyExists ? "_(Branch already existed, switched to it)_" : ""}

---
${issue.description ? issue.description.slice(0, 500) + (issue.description.length > 500 ? "..." : "") : "_No description._"}`;

          return { content: [{ type: "text", text }], isError: !result.success };
        }

        // ── analyze_ticket_with_excel ──
        case "analyze_ticket_with_excel": {
          const issueId = args?.issue_id as number;
          const issueErr = validatePositiveInt(issueId, "issue_id");
          if (issueErr)
            return {
              content: [{ type: "text", text: `Validation error: ${issueErr.message}` }],
              isError: true,
            };

          const excelPath = args?.excel_path as string | undefined;
          const excelBase64 = args?.excel_base64 as string | undefined;
          const excelFileName = (args?.excel_file_name as string | undefined) || "uploaded.xlsx";
          const includeJournals = args?.include_journals === true;
          const sessionId = args?.session_id as string | undefined;

          if (!!excelPath === !!excelBase64) {
            return {
              content: [
                {
                  type: "text",
                  text: "Validation error: provide exactly one of excel_path or excel_base64.",
                },
              ],
              isError: true,
            };
          }

          const pathErr = validateNoPathTraversal(excelPath, "excel_path");
          if (pathErr)
            return {
              content: [{ type: "text", text: `Validation error: ${pathErr.message}` }],
              isError: true,
            };

          const redmine = getRedmineClient(sessionId);
          const issue = await redmine.getIssue(issueId, includeJournals);

          let parsedRequirements;
          try {
            if (excelBase64) {
              parsedRequirements = parseRequirementExcelFromBase64(excelBase64, excelFileName);
            } else {
              parsedRequirements = parseRequirementExcelFromPath(path.resolve(excelPath as string));
            }
          } catch (parseErr: unknown) {
            const message = parseErr instanceof Error ? parseErr.message : String(parseErr);
            return {
              content: [{ type: "text", text: `Failed to parse requirement Excel: ${message}` }],
              isError: true,
            };
          }

          const actionsByItem = new Map<number, typeof parsedRequirements.actions>();
          parsedRequirements.actions.forEach((action) => {
            const existing = actionsByItem.get(action.itemNumber) || [];
            existing.push(action);
            actionsByItem.set(action.itemNumber, existing);
          });

          const componentBlocks = parsedRequirements.components
            .map((component) => {
              const componentActions = actionsByItem.get(component.itemNumber) || [];
              const logicParts: string[] = [];

              if (component.fieldControlType) logicParts.push(`Type=${component.fieldControlType}`);
              if (component.dataSource) logicParts.push(`Data=${component.dataSource}`);
              if (component.displayLogic) logicParts.push(`Display=${component.displayLogic}`);
              if (component.validationRules) logicParts.push(`Validation=${component.validationRules}`);

              const logicLine =
                logicParts.length > 0 ? logicParts.join(" | ") : "No logic details provided";

              const actionDetails =
                componentActions.length > 0
                  ? componentActions
                    .map((action) => {
                      const pieces = [`Type: ${action.actionType}`];
                      if (action.trigger) pieces.push(`Trigger: ${action.trigger}`);
                      if (action.handlerLogic) pieces.push(`Logic: ${action.handlerLogic}`);
                      if (action.apiFunction) pieces.push(`API: ${action.apiFunction}`);
                      if (action.parametersPassed) pieces.push(`Params: ${action.parametersPassed}`);
                      if (action.responseHandling) pieces.push(`Response: ${action.responseHandling}`);
                      if (action.errorHandling) pieces.push(`Error: ${action.errorHandling}`);
                      return `  - ${pieces.join(" | ")}`;
                    })
                    .join("\n")
                  : "  - No action details";

              const relatedItems = Array.from(
                new Set([
                  ...component.relatedComponents,
                  ...componentActions.flatMap((action) => action.relatedItems),
                ])
              ).sort((a, b) => a - b);

              return `**Item #${component.itemNumber}: ${component.componentName}**\n- Logic: ${logicLine}\n- Actions:\n${actionDetails}\n- Related: ${relatedItems.length > 0 ? relatedItems.join(", ") : "-"}`;
            })
            .join("\n\n");

          const apiEndpoints = Array.from(
            new Set(
              parsedRequirements.actions
                .map((action) => action.apiFunction)
                .filter((value): value is string => typeof value === "string" && value.length > 0)
            )
          );

          const journalLines =
            includeJournals && issue.journals && issue.journals.length > 0
              ? issue.journals
                .filter((journal) => journal.notes)
                .slice(-5)
                .map(
                  (journal) =>
                    `- ${new Date(journal.created_on).toLocaleDateString("vi-VN")} | ${journal.user.name}: ${journal.notes}`
                )
                .join("\n")
              : "- Not included";

          const warningSection =
            parsedRequirements.warnings.length > 0
              ? `## Parse Warnings\n${parsedRequirements.warnings.map((warning) => `- ${warning}`).join("\n")}\n\n`
              : "";

          const text = `# Coding Brief: Ticket #${issue.id}

## Ticket Summary
- Subject: ${issue.subject}
- Project: ${issue.project.name}
- Tracker: ${issue.tracker.name}
- Status: ${issue.status.name}
- Priority: ${issue.priority.name}
- Assignee: ${issue.assigned_to?.name || "Unassigned"}
- Excel Source: ${parsedRequirements.source}
- Parsed At: ${parsedRequirements.loadedAt.toISOString()}

## Ticket Description
${issue.description || "_No description provided._"}

## Recent Comments
${journalLines}

## Component Listing
${componentBlocks}

## API Candidates From Excel
${apiEndpoints.length > 0 ? apiEndpoints.map((endpoint) => `- ${endpoint}`).join("\n") : "- None"}

${warningSection}## Suggested Coding Plan
1. Create module and UI/component structure mapped by Item #.
2. Implement action handlers per component with trigger and handler logic.
3. Add API integration for listed endpoints and map request parameters.
4. Implement validation and display logic from component definitions.
5. Add response and error handling from action definitions.
6. Add tests for critical paths and API failure cases.`;

          return { content: [{ type: "text", text }] };
        }

        // ── validate_ticket_transition ──
        case "validate_ticket_transition": {
          if (!workflowDef) {
            return {
              content: [{ type: "text", text: "Workflow definition not loaded. No validation available." }],
              isError: true,
            };
          }

          const issueId = args?.issue_id as number;
          const toStatusId = args?.to_status_id as number;
          const sessionId = args?.session_id as string | undefined;

          const issueErr = validatePositiveInt(issueId, "issue_id");
          const statusErr = validatePositiveInt(toStatusId, "to_status_id");
          if (issueErr || statusErr) {
            const msg = [issueErr, statusErr]
              .filter(Boolean)
              .map((e) => e!.message)
              .join("; ");
            return { content: [{ type: "text", text: `Validation error: ${msg}` }], isError: true };
          }

          const redmine = getRedmineClient(sessionId);
          const issue = await redmine.getIssue(issueId, false);
          const statuses = await redmine.getIssueStatuses();

          const workflowEngine = createWorkflowEngine(workflowDef);
          const result = await workflowEngine.validateTransition(issue, toStatusId, statuses);

          const statusName = statuses.find((s) => s.id === toStatusId)?.name || "Unknown";
          const text = `# Transition Validation: #${issueId}

**Current Status:** ${issue.status.name}
**Target Status:** ${statusName}
**Allowed:** ${result.allowed ? "✅ Yes" : "❌ No"}

${result.errors.length > 0
              ? `## Errors\n${result.errors.map((e) => `- **${e.field}**: ${e.message}`).join("\n")}\n\n`
              : ""
            }${result.warnings && result.warnings.length > 0
              ? `## Warnings\n${result.warnings.map((w) => `- ${w}`).join("\n")}\n\n`
              : ""
            }${result.availableActions && result.availableActions.length > 0
              ? `## Available Actions\n${result.availableActions.map((a) => `- ${a.action_type}`).join("\n")}`
              : ""
            }`;

          return { content: [{ type: "text", text }], isError: !result.allowed };
        }

        // ── get_available_transitions ──
        case "get_available_transitions": {
          if (!workflowDef) {
            return {
              content: [{ type: "text", text: "Workflow definition not loaded. No transitions available." }],
              isError: true,
            };
          }

          const issueId = args?.issue_id as number;
          const sessionId = args?.session_id as string | undefined;

          const err = validatePositiveInt(issueId, "issue_id");
          if (err)
            return {
              content: [{ type: "text", text: `Validation error: ${err.message}` }],
              isError: true,
            };

          const redmine = getRedmineClient(sessionId);
          const issue = await redmine.getIssue(issueId, false);
          const statuses = await redmine.getIssueStatuses();

          const workflowEngine = createWorkflowEngine(workflowDef);
          const availableTransitions = workflowEngine.getAvailableTransitions(issue, statuses);

          const text = `# Available Transitions for #${issueId}

**Current Status:** ${issue.status.name}
**Tracker:** ${issue.tracker.name}

## Valid Target Statuses
${availableTransitions.map((t) => `- ${t}`).join("\n")}

_Use \`validate_ticket_transition\` to check if a specific transition is allowed and see any required fields._`;

          return { content: [{ type: "text", text }] };
        }

        // ── get_ticket_workflow_rules ──
        case "get_ticket_workflow_rules": {
          if (!workflowDef) {
            return {
              content: [{ type: "text", text: "Workflow definition not loaded." }],
              isError: true,
            };
          }

          const trackerName = args?.tracker_name as string;
          if (!trackerName) {
            return {
              content: [{ type: "text", text: "Tracker name is required." }],
              isError: true,
            };
          }

          const workflowEngine = createWorkflowEngine(workflowDef);
          const rules = workflowEngine.getRulesForTracker(trackerName);

          if (rules.length === 0) {
            return {
              content: [{ type: "text", text: `No workflow rules defined for tracker: ${trackerName}` }],
            };
          }

          let text = `# Workflow Rules for ${trackerName} Tracker\n\n`;
          rules.forEach((rule, idx) => {
            text += `## Rule ${idx + 1}\n`;
            text += `**Transition:** ${rule.status_from || "Any"} → ${rule.status_to}\n`;
            if (rule.required_fields.length > 0) {
              text += `**Required Fields:** ${rule.required_fields.join(", ")}\n`;
            }
            if (rule.validators.length > 0) {
              text += `**Validators:** ${rule.validators.map((v) => v.validator_name).join(", ")}\n`;
            }
            if (rule.actions.length > 0) {
              text += `**Actions:** ${rule.actions.map((a) => a.action_type).join(", ")}\n`;
            }
            text += "\n";
          });

          return { content: [{ type: "text", text }] };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      caughtError = message;
      logger.error("tool", "Tool call failed", {
        tool: name,
        error: message,
      });
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    } finally {
      logger.info("tool", "Tool call completed", {
        tool: name,
        durationMs: Date.now() - startedAt,
        caughtError,
      });
    }
  });
};

const server = createMcpServer();
registerServerHandlers(server);

// ─── Start ────────────────────────────────────────────────────────────────────

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("startup", "Redmine MCP Server running on stdio transport");
}

async function startSSE() {
  const app = express();
  const sessions = new Map<
    string,
    {
      transport: SSEServerTransport;
      server: Server;
      credentialSessionId: string | null;
    }
  >();
  let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

  const closeAllSessions = async () => {
    const activeSessions = Array.from(sessions.entries());
    sessions.clear();

    logger.info("sse", "Closing all active SSE sessions", {
      sessions: activeSessions.length,
    });

    await Promise.all(
      activeSessions.map(async ([sessionId, session]) => {
        if (session.credentialSessionId) {
          credentialSessionManager.closeSession(session.credentialSessionId);
        }

        try {
          await session.server.close();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("sse", "Failed to close session", {
            sessionId,
            error: message,
          });
        }
      })
    );
  };

  app.use(createRequestTracingMiddleware());

  const jsonParser = express.json();
  app.use((req, res, next) => {
    // MCP SDK reads the raw stream on /messages, so skip JSON body parsing here.
    if (req.path === "/messages") {
      next();
      return;
    }

    jsonParser(req, res, next);
  });
  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware(ALLOWED_ORIGINS));
  app.use(createRateLimiter());

  // Start credential session cleanup (every hour)
  sessionCleanupTimer = startSessionCleanup(60);

  // Handle initial connection with credentials
  app.get("/sse", async (req, res) => {
    const queryRedmineCookie = req.query.redmine_cookie as string | undefined;
    const headerRedmineCookie = readSingleHeader(
      req.headers["x-redmine-cookie"] as string | string[] | undefined
    );
    const cookieHeader = readSingleHeader(req.headers.cookie as string | string[] | undefined);
    const redmineCookie = queryRedmineCookie || headerRedmineCookie || cookieHeader;

    const hasCookieCredentials = typeof redmineCookie === "string" && redmineCookie.trim().length > 0;

    const credentialSource = queryRedmineCookie
      ? "query-cookie"
      : headerRedmineCookie
        ? "header-cookie"
        : cookieHeader
          ? "cookie-header"
          : "fallback";

    let credentialSessionId: string | null = null;
    let credentialsValidated = false;

    // If credentials provided, create a session for this connection.
    // Optional strict validation can be enabled with VALIDATE_SSE_CREDENTIALS=true.
    if (hasCookieCredentials) {
      const normalizedCookie = redmineCookie?.trim() || "";
      const authCredentials = {
        redmineCookie: normalizedCookie,
      };

      logger.info("sse", "Received per-user Redmine cookie", {
        credentialSource,
        strictValidation: VALIDATE_SSE_CREDENTIALS,
      });

      credentialSessionId = credentialSessionManager.generateSession(normalizedCookie);

      if (VALIDATE_SSE_CREDENTIALS) {
        try {
          const testClient = new RedmineClient(REDMINE_URL, authCredentials);
          await testClient.validateConnection();
          credentialsValidated = true;
          logger.info("sse", "Validated Redmine cookie for SSE connection", {
            credentialSource,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.info("sse", "Redmine cookie validation failed", {
            credentialSource,
            error: message,
          });
          logger.warn("sse", "Failed to validate Redmine cookie for SSE connection", {
            credentialSource,
            error: message,
          });
          if (credentialSessionId) {
            credentialSessionManager.closeSession(credentialSessionId);
            credentialSessionId = null;
          }
          res.status(401).json({ error: `Failed to validate credentials: ${message}` });
          return;
        }
      } else {
        logger.info("sse", "Accepted Redmine cookie without connect-time validation", {
          credentialSource,
        });

        // Validate in background for observability without breaking SSE handshake.
        void (async () => {
          try {
            const testClient = new RedmineClient(REDMINE_URL, authCredentials);
            await testClient.validateConnection();
            logger.info("sse", "Background cookie check succeeded", {
              credentialSource,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.info("sse", "Background cookie check failed", {
              credentialSource,
              error: message,
            });
            logger.warn("sse", "Background cookie check failed", {
              credentialSource,
              error: message,
            });
          }
        })();
      }
    } else {
      logger.warn("sse", "SSE connection without per-user cookie; fallback cookie will be used", {
        credentialSource,
        hasFallbackCookie: !!REDMINE_COOKIE,
      });
    }

    const transport = new SSEServerTransport("/messages", res);
    const sessionServer = createMcpServer();
    registerServerHandlers(sessionServer, credentialSessionId);

    const sessionId = transport.sessionId;
    sessions.set(sessionId, {
      transport,
      server: sessionServer,
      credentialSessionId,
    });

    logger.info("sse", "SSE session created", {
      sessionId,
      hasCredentialSession: !!credentialSessionId,
      activeSessions: sessions.size,
    });

    res.on("close", () => {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }

      sessions.delete(sessionId);
      if (session.credentialSessionId) {
        credentialSessionManager.closeSession(session.credentialSessionId);
      }

      void session.server.close().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("sse", "Failed to close server on disconnect", {
          sessionId,
          error: message,
        });
      });

      logger.info("sse", "SSE session closed", {
        sessionId,
        activeSessions: sessions.size,
      });
    });

    try {
      await sessionServer.connect(transport);

      // Send connection info after transport is connected to avoid header write conflicts.
      res.write(
        `data: ${JSON.stringify({
          type: "connection_info",
          sessionId,
          credentialsValid: !!credentialSessionId,
          credentialsValidatedOnConnect: credentialsValidated,
          credentialSessionId,
        })}\n\n`
      );
    } catch (err: unknown) {
      sessions.delete(sessionId);
      if (credentialSessionId) {
        credentialSessionManager.closeSession(credentialSessionId);
      }

      void sessionServer.close().catch((closeErr: unknown) => {
        const message = closeErr instanceof Error ? closeErr.message : String(closeErr);
        logger.error("sse", "Failed to close server after connect error", {
          sessionId,
          error: message,
        });
      });

      const message = err instanceof Error ? err.message : String(err);
      logger.error("sse", "Failed to connect SSE transport", {
        sessionId,
        error: message,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to establish SSE transport: ${message}` });
      } else {
        res.end();
      }
    }
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sessions.get(sessionId);
    if (!session) {
      logger.warn("sse", "Received message for invalid or expired session", {
        sessionId,
      });
      res.status(400).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      await session.transport.handlePostMessage(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("sse", "Failed to handle MCP message", {
        sessionId,
        error: message,
      });

      if (!res.headersSent) {
        res.status(500).json({ error: `Failed to handle MCP message: ${message}` });
      }
    }
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      transport: "sse",
      version: "1.0.0",
      mongo: !!MONGODB_URI,
      workflow: !!workflowDef,
      workflowRules: workflowDef?.rules.length || 0,
    });
  });

  app.listen(PORT, () => {
    logger.info("startup", "Redmine MCP Server running on SSE transport", {
      baseUrl: `http://localhost:${PORT}`,
      sseEndpoint: `http://localhost:${PORT}/sse`,
      healthEndpoint: `http://localhost:${PORT}/health`,
      mongo: MONGODB_URI ? "connected" : "disabled",
      workflow: workflowDef ? `loaded (${workflowDef.rules.length} rules)` : "disabled",
    });
  });

  process.on("SIGINT", () => {
    if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
    logger.info("shutdown", "Received SIGINT, closing sessions");
    void closeAllSessions();
  });
  process.on("SIGTERM", () => {
    if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
    logger.info("shutdown", "Received SIGTERM, closing sessions");
    void closeAllSessions();
  });
}

async function main() {
  if (MONGODB_URI) {
    try {
      await connectMongo(MONGODB_URI);
    } catch (err) {
      logger.warn("startup", "MongoDB connection failed. Multi-repo features disabled", {
        error: err instanceof Error ? err.message : err,
      });
    }
  }

  switch (TRANSPORT) {
    case "sse":
      await startSSE();
      break;
    case "stdio":
      await startStdio();
      break;
    default: {
      const _exhaustive: never = TRANSPORT;
      logger.error("startup", "Unknown transport configured", {
        transport: _exhaustive,
      });
      process.exit(1);
    }
  }
}

main().catch(async (err) => {
  logger.error("startup", "Fatal error", {
    error: err,
  });
  await disconnectMongo();
  process.exit(1);
});
