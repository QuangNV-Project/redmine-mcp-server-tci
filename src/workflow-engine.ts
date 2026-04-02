import Joi from "joi";
import type {
  TicketWorkflowRule,
  TransitionValidationResult,
  ValidationError,
  WorkflowDefinition,
} from "./types.js";
import type { RedmineIssue } from "./redmine-client.js";

export class WorkflowEngine {
  private workflowDef: WorkflowDefinition;

  constructor(workflowDef: WorkflowDefinition) {
    this.workflowDef = workflowDef;
  }

  /**
   * Validate if a ticket can transition from current status to target status
   */
  async validateTransition(
    issue: RedmineIssue,
    toStatusId: number | string,
    availableStatuses: Array<{ id: number; name: string }>
  ): Promise<TransitionValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: string[] = [];
    const toStatusName = this.getStatusNameById(toStatusId, availableStatuses);

    if (!toStatusName) {
      errors.push({
        field: "status",
        message: `Unknown status ID: ${toStatusId}`,
      });
      return { allowed: false, errors };
    }

    // Find applicable rules for this transition
    const applicableRules = this.getApplicableRules(
      issue.tracker.name,
      issue.status.name,
      toStatusName
    );

    let hasAnyRule = applicableRules.length > 0;

    // Check required fields
    for (const rule of applicableRules) {
      const fieldErrors = this.checkRequiredFields(issue, rule);
      if (fieldErrors.length > 0) {
        errors.push(...fieldErrors);
      }

      // Check validators
      for (const validator of rule.validators) {
        const validationError = this.runValidator(issue, validator);
        if (validationError) {
          errors.push(validationError);
        }
      }
    }

    // If no rules are explicitly defined for this transition, allow it by default
    // (unless ENFORCE_STRICT_WORKFLOW is set)
    if (!hasAnyRule && process.env.ENFORCE_STRICT_WORKFLOW !== "true") {
      warnings.push(
        `No explicit workflow rule defined for ${issue.tracker.name} from ${issue.status.name} to ${toStatusName}. Allowing by default.`
      );
    }

    return {
      allowed: errors.length === 0,
      errors,
      warnings,
      availableActions: applicableRules.length > 0 ? applicableRules[0]?.actions : undefined,
    };
  }

  /**
   * Get available transition targets for a ticket given its current status
   */
  getAvailableTransitions(
    issue: RedmineIssue,
    allStatuses: Array<{ id: number; name: string }>
  ): string[] {
    const available = new Set<string>();

    // Find all rules that could apply from current status
    const applicableRules = this.workflowDef.rules.filter((rule) => {
      const trackerMatches = !rule.tracker_id || rule.tracker_id === issue.tracker.id.toString() || rule.tracker_id === issue.tracker.name;
      const statusMatches =
        !rule.status_from ||
        rule.status_from === issue.status.name ||
        (Array.isArray(rule.status_from) && rule.status_from.includes(issue.status.name));

      return trackerMatches && statusMatches;
    });

    // Get all possible target statuses from rules
    applicableRules.forEach((rule) => {
      available.add(rule.status_to);
    });

    // If no rules, allow transitions to any status
    if (available.size === 0 && process.env.ENFORCE_STRICT_WORKFLOW !== "true") {
      allStatuses.forEach((s) => available.add(s.name));
    }

    return Array.from(available);
  }

  /**
   * Get workflow rules for a specific tracker
   */
  getRulesForTracker(trackerName: string): TicketWorkflowRule[] {
    return this.workflowDef.rules.filter(
      (rule) =>
        !rule.tracker_id || rule.tracker_id === trackerName
    );
  }

  private getApplicableRules(
    trackerName: string,
    fromStatusName: string,
    toStatusName: string
  ): TicketWorkflowRule[] {
    return this.workflowDef.rules.filter((rule) => {
      const trackerMatches = !rule.tracker_id || rule.tracker_id === trackerName;
      const statusToMatches = rule.status_to === toStatusName;
      const statusFromMatches =
        !rule.status_from ||
        rule.status_from === fromStatusName ||
        (Array.isArray(rule.status_from) && rule.status_from.includes(fromStatusName));

      return trackerMatches && statusToMatches && statusFromMatches;
    });
  }

  private checkRequiredFields(issue: RedmineIssue, rule: TicketWorkflowRule): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const fieldName of rule.required_fields) {
      const fieldValue = this.getIssueFieldValue(issue, fieldName);
      if (fieldValue === null || fieldValue === undefined || fieldValue === "") {
        errors.push({
          field: fieldName,
          message: `${fieldName} is required for transition to ${rule.status_to}`,
        });
      }
    }

    return errors;
  }

  private runValidator(
    issue: RedmineIssue,
    validator: any
  ): ValidationError | null {
    try {
      const fieldValue = this.getIssueFieldValue(issue, validator.field);

      switch (validator.rule_type) {
        case "min_length": {
          const minLength = parseInt(validator.value, 10);
          if (fieldValue && String(fieldValue).length < minLength) {
            return {
              field: validator.field,
              message: validator.error_message || `${validator.field} must be at least ${minLength} characters`,
            };
          }
          break;
        }

        case "max_length": {
          const maxLength = parseInt(validator.value, 10);
          if (fieldValue && String(fieldValue).length > maxLength) {
            return {
              field: validator.field,
              message: validator.error_message || `${validator.field} must be at most ${maxLength} characters`,
            };
          }
          break;
        }

        case "regex": {
          const regex = new RegExp(validator.value);
          if (fieldValue && !regex.test(String(fieldValue))) {
            return {
              field: validator.field,
              message: validator.error_message || `${validator.field} format is invalid`,
            };
          }
          break;
        }

        case "enum": {
          const allowedValues = validator.value.split(",").map((v: string) => v.trim());
          if (fieldValue && !allowedValues.includes(String(fieldValue))) {
            return {
              field: validator.field,
              message: validator.error_message || `${validator.field} must be one of: ${allowedValues.join(", ")}`,
            };
          }
          break;
        }

        default:
          // Unknown validator type, skip
          break;
      }

      return null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        field: validator.field,
        message: `Validation error: ${message}`,
      };
    }
  }

  private getIssueFieldValue(issue: RedmineIssue, fieldName: string): unknown {
    const field = fieldName.toLowerCase();

    switch (field) {
      case "assignee":
        return issue.assigned_to?.name || null;
      case "assigned_to":
        return issue.assigned_to?.id || null;
      case "description":
        return issue.description || null;
      case "due_date":
        return issue.due_date || null;
      case "start_date":
        return issue.start_date || null;
      case "priority":
        return issue.priority?.name || null;
      case "status":
        return issue.status?.name || null;
      case "done_ratio":
        return issue.done_ratio || 0;
      case "subject":
        return issue.subject || null;
      default:
        return null;
    }
  }

  private getStatusNameById(
    statusId: number | string,
    availableStatuses: Array<{ id: number; name: string }>
  ): string | null {
    const id = typeof statusId === "string" ? parseInt(statusId, 10) : statusId;
    return availableStatuses.find((s) => s.id === id)?.name || null;
  }
}

export function createWorkflowEngine(workflowDef: WorkflowDefinition): WorkflowEngine {
  return new WorkflowEngine(workflowDef);
}
