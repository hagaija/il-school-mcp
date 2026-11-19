import fs from "node:fs";
import path from "node:path";
import type { SchoolSession, SchoolSystem } from "./types.js";

export const DEFAULT_SESSION_TTL_MS = 12 * 3600 * 1000; // 12 hours
export const DEFAULT_MIN_COOLDOWN_MS = 1800 * 1000; // 30 minutes

export function isSessionValid(session: SchoolSession, nowMs: number = Date.now()): boolean {
  if (nowMs >= session.expiresAt) {
    return false;
  }
  const hasCookies = Object.keys(session.cookies ?? {}).length > 0;
  return Boolean(session.csrfToken || session.webToken || hasCookies);
}

/**
 * Persistent session store with rate-limiting circuit breaker for Mashov & Webtop.
 * Implements the Zero-Redundant-Login pattern to avoid triggering parent SMS alerts
 * or portal IP lockouts.
 */
export class SchoolSessionStore {
  private readonly filePath: string;
  private sessions: Map<string, SchoolSession> = new Map();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.loadFromDisk();
  }

  private sessionKey(providerType: SchoolSystem, accountKey: string): string {
    return `${providerType.toLowerCase().trim()}:${accountKey.trim()}`;
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, Partial<SchoolSession>>;
      if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (!val || typeof val !== "object") continue;
          this.sessions.set(key, {
            providerType: (val.providerType as SchoolSystem) || "mashov",
            accountKey: val.accountKey || "",
            csrfToken: val.csrfToken,
            webToken: val.webToken,
            cookies: val.cookies ?? {},
            childMetadata: val.childMetadata ?? {},
            lastLoginTs: Number(val.lastLoginTs ?? 0),
            expiresAt: Number(val.expiresAt ?? 0),
            consecutiveFailures: Number(val.consecutiveFailures ?? 0),
            lastFailureTs: Number(val.lastFailureTs ?? 0),
          });
        }
      }
    } catch {
      this.sessions.clear();
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const data: Record<string, SchoolSession> = {};
      for (const [k, v] of this.sessions.entries()) {
        data[k] = v;
      }
      const tmp = `${this.filePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Ignore on Windows
      }
    } catch {
      // Non-fatal persistence error
    }
  }

  getSession(providerType: SchoolSystem, accountKey: string): SchoolSession | undefined {
    return this.sessions.get(this.sessionKey(providerType, accountKey));
  }

  saveSession(
    providerType: SchoolSystem,
    accountKey: string,
    session: SchoolSession,
    nowMs: number = Date.now()
  ): void {
    const lastLoginTs = session.lastLoginTs > 0 ? session.lastLoginTs : nowMs;
    const expiresAt = session.expiresAt > 0 ? session.expiresAt : lastLoginTs + DEFAULT_SESSION_TTL_MS;
    this.sessions.set(this.sessionKey(providerType, accountKey), {
      ...session,
      lastLoginTs,
      expiresAt,
    });
    this.saveToDisk();
  }

  invalidateSession(providerType: SchoolSystem, accountKey: string): void {
    const key = this.sessionKey(providerType, accountKey);
    const existing = this.sessions.get(key);
    if (!existing) return;
    existing.csrfToken = undefined;
    existing.webToken = undefined;
    existing.cookies = {};
    existing.expiresAt = 0;
    this.saveToDisk();
  }

  recordLoginFailure(
    providerType: SchoolSystem,
    accountKey: string,
    nowMs: number = Date.now()
  ): void {
    const key = this.sessionKey(providerType, accountKey);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        providerType,
        accountKey,
        cookies: {},
        childMetadata: {},
        lastLoginTs: 0,
        expiresAt: 0,
        consecutiveFailures: 0,
        lastFailureTs: 0,
      };
      this.sessions.set(key, session);
    }
    session.consecutiveFailures += 1;
    session.lastFailureTs = nowMs;
    session.csrfToken = undefined;
    session.webToken = undefined;
    session.cookies = {};
    session.expiresAt = 0;
    this.saveToDisk();
  }

  recordLoginSuccess(providerType: SchoolSystem, accountKey: string): void {
    const key = this.sessionKey(providerType, accountKey);
    const session = this.sessions.get(key);
    if (!session) return;
    session.consecutiveFailures = 0;
    session.lastFailureTs = 0;
    this.saveToDisk();
  }

  /**
   * Circuit breaker rules:
   * - 0 failures: allowed immediately
   * - 1 failure: 30 minutes cooldown
   * - 2+ failures: 2 hours cooldown
   */
  canAttemptLogin(
    providerType: SchoolSystem,
    accountKey: string,
    minCooldownMs: number = DEFAULT_MIN_COOLDOWN_MS,
    nowMs: number = Date.now()
  ): boolean {
    const session = this.getSession(providerType, accountKey);
    if (!session || session.consecutiveFailures === 0) {
      return true;
    }
    const elapsed = nowMs - session.lastFailureTs;
    if (session.consecutiveFailures === 1) {
      return elapsed >= minCooldownMs;
    }
    const lockoutMs = Math.max(minCooldownMs * 4, 7200 * 1000);
    return elapsed >= lockoutMs;
  }
}
