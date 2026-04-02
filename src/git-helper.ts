import { execSync } from "child_process";
import type { ExecSyncOptions } from "child_process";
import * as path from "path";

export interface BranchResult {
  success: boolean;
  branchName: string;
  message: string;
  alreadyExists?: boolean;
}

/**
 * Converts a ticket subject into a URL-safe branch name segment
 * e.g. "Fix login bug on mobile" => "fix-login-bug-on-mobile"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD") // decompose unicode
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[^a-z0-9\s-]/g, "") // keep alphanumeric, spaces, hyphens
    .trim()
    .replace(/\s+/g, "-") // spaces → hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .slice(0, 60); // max 60 chars for title segment
}

/**
 * Build branch name from ticket info
 * Formats:
 *   "ticket-id"        => feature/123
 *   "ticket-id-title"  => feature/123-fix-login-bug-on-mobile
 */
export function buildBranchName(
  issueId: number,
  subject: string,
  format: "ticket-id" | "ticket-id-title" = "ticket-id-title",
  prefix = "feature"
): string {
  if (format === "ticket-id") {
    return `${prefix}/${issueId}`;
  }
  const slug = slugify(subject);
  return `${prefix}/${issueId}-${slug}`;
}

function exec(cmd: string, repoPath: string): string {
  const opts: ExecSyncOptions = {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  };
  return (execSync(cmd, opts) as unknown as string).trim();
}

/**
 * Create and checkout a new git branch
 */
export function createBranch(
  branchName: string,
  repoPath: string,
  baseBranch = "main"
): BranchResult {
  try {
    // Check if already exists locally
    const localBranches = exec("git branch --list", repoPath);
    const exists = localBranches
      .split("\n")
      .map((b) => b.replace(/^\*?\s+/, "").trim())
      .includes(branchName);

    if (exists) {
      exec(`git checkout ${branchName}`, repoPath);
      return {
        success: true,
        branchName,
        message: `Branch '${branchName}' already exists. Switched to it.`,
        alreadyExists: true,
      };
    }

    // Fetch latest base branch
    try {
      exec(`git fetch origin ${baseBranch}`, repoPath);
      exec(`git checkout -b ${branchName} origin/${baseBranch}`, repoPath);
    } catch {
      // If no remote, branch from local base
      exec(`git checkout ${baseBranch}`, repoPath);
      exec(`git checkout -b ${branchName}`, repoPath);
    }

    return {
      success: true,
      branchName,
      message: `Branch '${branchName}' created and checked out from '${baseBranch}'.`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      branchName,
      message: `Failed to create branch: ${message}`,
    };
  }
}

/**
 * Get current git branch
 */
export function getCurrentBranch(repoPath: string): string {
  try {
    return exec("git branch --show-current", repoPath);
  } catch {
    return "unknown";
  }
}

/**
 * List all local branches
 */
export function listBranches(repoPath: string): string[] {
  try {
    const output = exec("git branch --list", repoPath);
    return output
      .split("\n")
      .map((b) => b.replace(/^\*?\s+/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Validate that a path is a git repo
 */
export function isGitRepo(repoPath: string): boolean {
  try {
    exec("git rev-parse --git-dir", repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve repo path: explicit path, env var, or cwd
 */
export function resolveRepoPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.GIT_REPO_PATH) return path.resolve(process.env.GIT_REPO_PATH);
  return process.cwd();
}
