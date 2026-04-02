import { randomUUID } from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
type LogFormat = "json" | "spring";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_LOG_FORMAT: LogFormat = "spring";
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 1000;
const REDACTED = "[REDACTED]";
const sensitiveKeyPattern = /(password|passwd|token|authorization|secret|api[_-]?key|cookie)/i;

const normalizeLevel = (rawLevel: string | undefined): LogLevel => {
    if (!rawLevel) return DEFAULT_LOG_LEVEL;

    const normalized = rawLevel.toLowerCase();
    if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }

    return DEFAULT_LOG_LEVEL;
};

const normalizeFormat = (rawFormat: string | undefined): LogFormat => {
    if (!rawFormat) return DEFAULT_LOG_FORMAT;

    const normalized = rawFormat.toLowerCase();
    if (normalized === "json" || normalized === "spring") {
        return normalized;
    }

    return DEFAULT_LOG_FORMAT;
};

const activeLogLevel = normalizeLevel(process.env.LOG_LEVEL);
const activeLogFormat = normalizeFormat(process.env.LOG_FORMAT);
const activeThreadName = process.env.LOG_THREAD_NAME || "main";
const splitStreams = process.env.LOG_SPLIT_STREAMS === "true";

const shouldLog = (level: LogLevel): boolean => {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[activeLogLevel];
};

const truncateString = (value: string): string => {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated:${value.length}]`;
};

const padNumber = (value: number, width: number): string => value.toString().padStart(width, "0");

const formatClockTimestamp = (date: Date): string => {
    const hours = padNumber(date.getHours(), 2);
    const minutes = padNumber(date.getMinutes(), 2);
    const seconds = padNumber(date.getSeconds(), 2);
    const milliseconds = padNumber(date.getMilliseconds(), 3);
    return `${hours}:${minutes}:${seconds}.${milliseconds}`;
};

const formatSpringLine = (
    level: LogLevel,
    scope: string,
    message: string,
    context: unknown,
    timestamp: Date
): string => {
    const levelText = level.toUpperCase().padEnd(5, " ");
    const contextText = context === undefined ? "" : ` ${JSON.stringify(context)}`;
    return `${formatClockTimestamp(timestamp)} ${levelText} ${process.pid} --- [${activeThreadName}] ${scope} : ${message}${contextText}\n`;
};

export const sanitizeForLog = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_DEPTH) {
        return "[MaxDepthReached]";
    }

    if (value === null || value === undefined) {
        return value;
    }

    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack ? truncateString(value.stack) : undefined,
        };
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (typeof value === "string") {
        return truncateString(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForLog(item, depth + 1));
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        const sanitized: Record<string, unknown> = {};

        entries.forEach(([key, entryValue]) => {
            if (sensitiveKeyPattern.test(key)) {
                sanitized[key] = REDACTED;
            } else {
                sanitized[key] = sanitizeForLog(entryValue, depth + 1);
            }
        });

        return sanitized;
    }

    return String(value);
};

const writeLog = (level: LogLevel, scope: string, message: string, context?: unknown): void => {
    if (!shouldLog(level)) {
        return;
    }

    const now = new Date();
    const sanitizedContext = context === undefined ? undefined : sanitizeForLog(context);

    const payload = {
        timestamp: now.toISOString(),
        level,
        scope,
        message,
        context: sanitizedContext,
    };

    const line =
        activeLogFormat === "json"
            ? `${JSON.stringify(payload)}\n`
            : formatSpringLine(level, scope, message, sanitizedContext, now);

    if (splitStreams && (level === "warn" || level === "error")) {
        process.stderr.write(line);
        return;
    }

    process.stdout.write(line);
};

export const logger = {
    debug: (scope: string, message: string, context?: unknown) => {
        writeLog("debug", scope, message, context);
    },
    info: (scope: string, message: string, context?: unknown) => {
        writeLog("info", scope, message, context);
    },
    warn: (scope: string, message: string, context?: unknown) => {
        writeLog("warn", scope, message, context);
    },
    error: (scope: string, message: string, context?: unknown) => {
        writeLog("error", scope, message, context);
    },
};

export const createRequestId = (): string => randomUUID();
