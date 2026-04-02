import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import type {
  TicketWorkflowRule,
  FieldValidator,
  WorkflowAction,
  WorkflowDefinition,
} from "./types.js";
import { logger } from "./logger.js";

export interface RawWorkflowRule {
  tracker?: string;
  status_from?: string;
  status_to: string;
  required_fields?: string;
  validators?: string;
  actions?: string;
}

/**
 * Parse Excel workflow definition file
 * Expected format:
 *   Sheet 1 "Rules": tracker | status_from | status_to | required_fields | validators | actions
 *   Sheet 2 "Validators": validator_name | field | rule_type | value | error_message
 *   Sheet 3 "Actions": action_type | parameters (JSON)
 */
export async function loadWorkflowFromExcel(filePath: string): Promise<WorkflowDefinition> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  const workbookBuffer = fs.readFileSync(filePath);
  const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
  const rulesSheet = workbook.Sheets["Rules"];
  const validatorsSheet = workbook.Sheets["Validators"];
  const actionsSheet = workbook.Sheets["Actions"];

  if (!rulesSheet) {
    throw new Error('Excel file must contain a "Rules" sheet');
  }

  // Parse rules
  const rawRules = XLSX.utils.sheet_to_json<RawWorkflowRule>(rulesSheet);
  const validators = validatorsSheet
    ? parseValidatorsSheet(validatorsSheet)
    : new Map<string, FieldValidator[]>();

  const actions = actionsSheet ? parseActionsSheet(actionsSheet) : new Map<string, WorkflowAction[]>();

  const rules: TicketWorkflowRule[] = rawRules
    .filter((r) => r.status_to) // Skip empty rows
    .map((rule) => {
      const required_fields = rule.required_fields
        ? rule.required_fields
          .split(/[,;]/)
          .map((f) => f.trim())
          .filter(Boolean)
        : [];

      const validator_names = rule.validators
        ? rule.validators
          .split(/[,;]/)
          .map((v) => v.trim())
          .filter(Boolean)
        : [];

      const action_names = rule.actions
        ? rule.actions
          .split(/[,;]/)
          .map((a) => a.trim())
          .filter(Boolean)
        : [];

      return {
        tracker_id: rule.tracker || undefined,
        status_from: rule.status_from || undefined,
        status_to: rule.status_to,
        required_fields,
        validators: validator_names
          .flatMap((name) => validators.get(name) || [])
          .filter((v) => v !== undefined),
        actions: action_names
          .flatMap((name) => actions.get(name) || [])
          .filter((a) => a !== undefined),
      };
    });

  return {
    rules,
    filePath: path.resolve(filePath),
    loadedAt: new Date(),
  };
}

function parseValidatorsSheet(
  sheet: XLSX.WorkSheet
): Map<string, FieldValidator[]> {
  const rawValidators = XLSX.utils.sheet_to_json<{
    validator_name?: string;
    field?: string;
    rule_type?: string;
    value?: string;
    error_message?: string;
  }>(sheet);

  const map = new Map<string, FieldValidator[]>();

  rawValidators.forEach((raw) => {
    if (!raw.validator_name || !raw.field || !raw.rule_type) {
      return; // Skip invalid rows
    }

    const validator: FieldValidator = {
      validator_name: raw.validator_name,
      field: raw.field,
      rule_type: raw.rule_type,
      value: raw.value || "",
      error_message: raw.error_message || `Validation failed for ${raw.field}`,
    };

    const existing = map.get(raw.validator_name) || [];
    map.set(raw.validator_name, [...existing, validator]);
  });

  return map;
}

function parseActionsSheet(sheet: XLSX.WorkSheet): Map<string, WorkflowAction[]> {
  const rawActions = XLSX.utils.sheet_to_json<{
    action_name?: string;
    action_type?: string;
    parameters?: string;
  }>(sheet);

  const map = new Map<string, WorkflowAction[]>();

  rawActions.forEach((raw) => {
    if (!raw.action_type) {
      return; // Skip invalid rows
    }

    const action_name = raw.action_name || raw.action_type;
    let parameters: Record<string, unknown> = {};

    // Try to parse JSON parameters
    if (raw.parameters) {
      try {
        parameters = JSON.parse(raw.parameters);
      } catch {
        logger.warn("workflow-excel-parser", "Failed to parse action parameters as JSON", {
          actionType: raw.action_type,
          rawParameters: raw.parameters,
        });
        parameters = { raw: raw.parameters };
      }
    }

    const action: WorkflowAction = {
      action_type: raw.action_type,
      parameters,
    };

    const existing = map.get(action_name) || [];
    map.set(action_name, [...existing, action]);
  });

  return map;
}

/**
 * Validate that an Excel file has the correct structure
 */
export function validateWorkflowExcelStructure(filePath: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: [`File not found: ${filePath}`] };
  }

  try {
    const workbookBuffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(workbookBuffer, { type: "buffer" });

    if (!workbook.Sheets["Rules"]) {
      errors.push('Missing required sheet: "Rules"');
    }

    // Validate Rules sheet structure
    const rulesSheet = workbook.Sheets["Rules"];
    if (rulesSheet) {
      const firstRow = XLSX.utils.sheet_to_json(rulesSheet, { header: 1 })[0] as string[];
      const requiredColumns = ["status_to"];
      const missingColumns = requiredColumns.filter((col) => !firstRow?.includes(col));
      if (missingColumns.length > 0) {
        errors.push(
          `"Rules" sheet missing columns: ${missingColumns.join(", ")}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`Failed to read Excel file: ${message}`],
    };
  }
}
