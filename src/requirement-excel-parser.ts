import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";

export interface TicketRequirementComponent {
    itemNumber: number;
    componentName: string;
    fieldControlType?: string;
    dataSource?: string;
    displayLogic?: string;
    validationRules?: string;
    relatedComponents: number[];
}

export interface TicketRequirementAction {
    itemNumber: number;
    actionType: string;
    trigger?: string;
    handlerLogic?: string;
    apiFunction?: string;
    parametersPassed?: string;
    responseHandling?: string;
    errorHandling?: string;
    relatedItems: number[];
}

export interface TicketRequirementWorkbook {
    source: string;
    loadedAt: Date;
    components: TicketRequirementComponent[];
    actions: TicketRequirementAction[];
    warnings: string[];
}

const COMPONENT_SHEET_NAMES = [
    "Giải thích hạng mục",
    "Component Explanation",
    "Components",
    "Component",
];

const ACTION_SHEET_NAMES = [
    "Chi tiết xử lý action",
    "Action Details",
    "Actions",
    "Action",
];

const COMPONENT_ITEM_KEYS = [
    "item",
    "itemnumber",
    "itemid",
    "hangmuc",
    "hangmucso",
];

const COMPONENT_NAME_KEYS = [
    "componentname",
    "component",
    "name",
    "tenhangmuc",
    "tencomponent",
];

const COMPONENT_TYPE_KEYS = [
    "fieldcontroltype",
    "fieldtype",
    "controltype",
    "loaicontrol",
];

const COMPONENT_DATA_SOURCE_KEYS = ["datasource", "nguondulieu", "source"];
const COMPONENT_DISPLAY_KEYS = ["displaylogic", "display", "hienthi", "dieukienhienthi"];
const COMPONENT_VALIDATION_KEYS = ["validationrules", "validation", "rules", "rangsoc"];
const COMPONENT_RELATED_KEYS = ["relatedcomponents", "relateditems", "related", "lienquanhangmuc"];

const ACTION_ITEM_KEYS = ["item", "itemnumber", "itemid", "hangmuc", "hangmucso"];
const ACTION_TYPE_KEYS = ["actiontype", "loaiaction", "type"];
const ACTION_TRIGGER_KEYS = ["trigger", "kichhoat"];
const ACTION_HANDLER_KEYS = ["handlerlogic", "handler", "logic", "xuly", "hanhvi"];
const ACTION_API_KEYS = ["apifunction", "api", "function", "endpoint"];
const ACTION_PARAM_KEYS = ["parameterspassed", "parameters", "params", "thamso"];
const ACTION_RESPONSE_KEYS = ["responsehandling", "response", "xulyresponse"];
const ACTION_ERROR_KEYS = ["errorhandling", "error", "xulyloi"];
const ACTION_RELATED_KEYS = ["relateditems", "relatedcomponents", "related", "lienquanhangmuc"];

export function parseRequirementExcelFromPath(filePath: string): TicketRequirementWorkbook {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Excel file not found: ${filePath}`);
    }

    const workbookBuffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
    return parseWorkbook(workbook, path.resolve(filePath));
}

export function parseRequirementExcelFromBase64(
    excelBase64: string,
    fileName = "uploaded.xlsx"
): TicketRequirementWorkbook {
    const cleaned = excelBase64.includes(",") ? excelBase64.split(",").pop() || "" : excelBase64;
    const buffer = Buffer.from(cleaned, "base64");

    if (buffer.length === 0) {
        throw new Error("excel_base64 is empty or invalid");
    }

    const maxSizeBytes = 15 * 1024 * 1024;
    if (buffer.length > maxSizeBytes) {
        throw new Error("excel_base64 is too large (max 15MB)");
    }

    const workbook = XLSX.read(buffer, { type: "buffer" });
    return parseWorkbook(workbook, fileName);
}

function parseWorkbook(workbook: XLSX.WorkBook, source: string): TicketRequirementWorkbook {
    const warnings: string[] = [];

    const componentSheet = findSheetByNames(workbook, COMPONENT_SHEET_NAMES);
    if (!componentSheet) {
        throw new Error(
            "Excel must contain a component sheet (Giải thích hạng mục / Component Explanation)"
        );
    }

    const actionSheet = findSheetByNames(workbook, ACTION_SHEET_NAMES);
    if (!actionSheet) {
        warnings.push(
            "Action sheet not found (Chi tiết xử lý action / Action Details). Output will include only component logic."
        );
    }

    const componentRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(componentSheet, {
        defval: "",
    });

    const components = parseComponents(componentRows, warnings);
    if (components.length === 0) {
        throw new Error("No valid component rows found in component sheet");
    }

    const actions = actionSheet
        ? parseActions(
            XLSX.utils.sheet_to_json<Record<string, unknown>>(actionSheet, { defval: "" }),
            warnings
        )
        : [];

    return {
        source,
        loadedAt: new Date(),
        components,
        actions,
        warnings,
    };
}

function parseComponents(
    rows: Array<Record<string, unknown>>,
    warnings: string[]
): TicketRequirementComponent[] {
    const components: TicketRequirementComponent[] = [];

    rows.forEach((row, index) => {
        const normalizedRow = normalizeRow(row);
        const itemRaw = pickField(normalizedRow, COMPONENT_ITEM_KEYS);
        const nameRaw = pickField(normalizedRow, COMPONENT_NAME_KEYS);

        const itemNumber = parseItemNumber(itemRaw);
        const componentName = toText(nameRaw);

        if (!itemNumber || !componentName) {
            return;
        }

        components.push({
            itemNumber,
            componentName,
            fieldControlType: toOptionalText(pickField(normalizedRow, COMPONENT_TYPE_KEYS)),
            dataSource: toOptionalText(pickField(normalizedRow, COMPONENT_DATA_SOURCE_KEYS)),
            displayLogic: toOptionalText(pickField(normalizedRow, COMPONENT_DISPLAY_KEYS)),
            validationRules: toOptionalText(pickField(normalizedRow, COMPONENT_VALIDATION_KEYS)),
            relatedComponents: parseNumberList(pickField(normalizedRow, COMPONENT_RELATED_KEYS)),
        });

        if (!itemRaw || !nameRaw) {
            warnings.push(`Skipped incomplete component row ${index + 2}`);
        }
    });

    return dedupeComponents(components).sort((a, b) => a.itemNumber - b.itemNumber);
}

function parseActions(
    rows: Array<Record<string, unknown>>,
    warnings: string[]
): TicketRequirementAction[] {
    const actions: TicketRequirementAction[] = [];

    rows.forEach((row, index) => {
        const normalizedRow = normalizeRow(row);
        const itemNumber = parseItemNumber(pickField(normalizedRow, ACTION_ITEM_KEYS));
        const actionType = toText(pickField(normalizedRow, ACTION_TYPE_KEYS));

        if (!itemNumber || !actionType) {
            return;
        }

        actions.push({
            itemNumber,
            actionType,
            trigger: toOptionalText(pickField(normalizedRow, ACTION_TRIGGER_KEYS)),
            handlerLogic: toOptionalText(pickField(normalizedRow, ACTION_HANDLER_KEYS)),
            apiFunction: toOptionalText(pickField(normalizedRow, ACTION_API_KEYS)),
            parametersPassed: toOptionalText(pickField(normalizedRow, ACTION_PARAM_KEYS)),
            responseHandling: toOptionalText(pickField(normalizedRow, ACTION_RESPONSE_KEYS)),
            errorHandling: toOptionalText(pickField(normalizedRow, ACTION_ERROR_KEYS)),
            relatedItems: parseNumberList(pickField(normalizedRow, ACTION_RELATED_KEYS)),
        });

        if (!actionType) {
            warnings.push(`Skipped incomplete action row ${index + 2}`);
        }
    });

    return actions;
}

function dedupeComponents(components: TicketRequirementComponent[]): TicketRequirementComponent[] {
    const map = new Map<number, TicketRequirementComponent>();

    components.forEach((component) => {
        const existing = map.get(component.itemNumber);
        if (!existing) {
            map.set(component.itemNumber, component);
            return;
        }

        map.set(component.itemNumber, {
            itemNumber: component.itemNumber,
            componentName: existing.componentName || component.componentName,
            fieldControlType: existing.fieldControlType || component.fieldControlType,
            dataSource: existing.dataSource || component.dataSource,
            displayLogic: existing.displayLogic || component.displayLogic,
            validationRules: existing.validationRules || component.validationRules,
            relatedComponents: Array.from(new Set([...existing.relatedComponents, ...component.relatedComponents])),
        });
    });

    return Array.from(map.values());
}

function findSheetByNames(workbook: XLSX.WorkBook, candidates: string[]): XLSX.WorkSheet | null {
    const normalizedCandidates = new Set(candidates.map((name) => normalizeText(name)));

    for (const sheetName of workbook.SheetNames) {
        if (normalizedCandidates.has(normalizeText(sheetName))) {
            return workbook.Sheets[sheetName] || null;
        }
    }

    return null;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    Object.entries(row).forEach(([key, value]) => {
        normalized[normalizeText(key)] = value;
    });

    return normalized;
}

function pickField(row: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (key in row) {
            return row[key];
        }
    }
    return undefined;
}

function parseItemNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        const num = Math.trunc(value);
        return num > 0 ? num : null;
    }

    const text = toText(value);
    if (!text) return null;

    const match = text.match(/\d+/);
    if (!match) return null;

    const num = parseInt(match[0], 10);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function parseNumberList(value: unknown): number[] {
    const text = toText(value);
    if (!text) return [];

    const numbers = text.match(/\d+/g) || [];
    const parsed = numbers
        .map((valuePart) => parseInt(valuePart, 10))
        .filter((num) => Number.isFinite(num) && num > 0);

    return Array.from(new Set(parsed));
}

function toOptionalText(value: unknown): string | undefined {
    const text = toText(value);
    return text || undefined;
}

function toText(value: unknown): string {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function normalizeText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}
