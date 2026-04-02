import crypto from "crypto";
import type { SessionCredentials } from "./types.js";

const ENCRYPTION_KEY = (process.env.CREDENTIAL_ENCRYPTION_KEY || "default-insecure-key-change-in-production").slice(0, 32).padEnd(32, "0");
const ENCRYPTION_IV_LENGTH = 16;

/**
 * Session storage for user credentials
 * Credentials are encrypted at rest and cleared on session close
 */
class CredentialSessionManager {
  private sessions: Map<string, {
    credentials: SessionCredentials;
    encrypted: string;
  }> = new Map();

  /**
   * Create a new session with credentials
   */
  generateSession(username: string, password: string): string {
    const sessionId = crypto.randomUUID();
    const credentials: SessionCredentials = {
      username,
      password,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };

    const encrypted = this.encrypt(JSON.stringify(credentials));

    this.sessions.set(sessionId, {
      credentials,
      encrypted,
    });

    return sessionId;
  }

  /**
   * Retrieve credentials from session
   */
  getCredentials(sessionId: string): SessionCredentials | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check if session has expired
    if (session.credentials.expiresAt && session.credentials.expiresAt < new Date()) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session.credentials;
  }

  /**
   * Close a session and clear its credentials
   */
  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Get all active session IDs (for debugging/monitoring)
   */
  getActiveSessions(): string[] {
    const active: string[] = [];
    const now = new Date();

    this.sessions.forEach((session, sessionId) => {
      if (!session.credentials.expiresAt || session.credentials.expiresAt > now) {
        active.push(sessionId);
      } else {
        this.sessions.delete(sessionId);
      }
    });

    return active;
  }

  /**
   * Clear expired sessions (periodic cleanup)
   */
  clearExpiredSessions(): number {
    let cleared = 0;
    const now = new Date();

    this.sessions.forEach((session, sessionId) => {
      if (session.credentials.expiresAt && session.credentials.expiresAt < now) {
        this.sessions.delete(sessionId);
        cleared++;
      }
    });

    return cleared;
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text, "utf-8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  private decrypt(encryptedText: string): string {
    const [ivHex, encrypted] = encryptedText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encrypted, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }
}

export const credentialSessionManager = new CredentialSessionManager();

/**
 * Periodic cleanup of expired sessions (run every hour)
 */
export function startSessionCleanup(intervalMinutes = 60): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const cleared = credentialSessionManager.clearExpiredSessions();
    if (cleared > 0) {
      console.error(`[CredentialSession] Cleared ${cleared} expired sessions`);
    }
  }, intervalMinutes * 60 * 1000);
}

/**
 * Stop the cleanup interval
 */
export function stopSessionCleanup(timer: ReturnType<typeof setInterval>): void {
  clearInterval(timer);
}
