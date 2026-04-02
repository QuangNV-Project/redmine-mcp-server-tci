import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createRequestId, logger } from "./logger.js";

export function createAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health" || req.path === "/sse") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      logger.warn("auth", "Rejected request with invalid bearer token", {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({ error: "Unauthorized: invalid or missing Bearer token" });
      return;
    }
    next();
  };
}

/**
 * Validate Redmine credentials from Authorization header (Basic Auth format)
 * Does NOT store credentials, just validates they're in proper format
 */
export function createCredentialValidationMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health") {
      next();
      return;
    }

    // For /sse endpoint, credentials will be in request body, so skip
    if (req.path === "/sse" && req.method === "GET") {
      next();
      return;
    }

    // For other authenticated endpoints, check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      // We don't strictly require auth on all endpoints in credential mode
      // Auth happens at /sse level
    }

    next();
  };
}

export function createRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 200,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    skip: (req) => req.path === "/sse" || req.path === "/health",
  });
}

export function createRequestTracingMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inboundRequestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined;
    const requestId = inboundRequestId || createRequestId();
    const startedAt = Date.now();

    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    logger.info("http", "Incoming request", {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    res.on("finish", () => {
      logger.info("http", "Request completed", {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
}

export function createCorsMiddleware(allowedOrigins: string) {
  const origins = allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return cors({
    origin: origins.length > 0 ? origins : "*",
    methods: ["GET", "POST"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-redmine-cookie",
      "x-request-id",
    ],
  });
}

export function createHelmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
  });
}
