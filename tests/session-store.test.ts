import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSessionValid, SchoolSessionStore } from "../src/session-store.js";

test("SchoolSessionStore saves, reloads, validates TTL, and enforces circuit breaker", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-sess-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const now = 1_780_000_000_000;

  const store = new SchoolSessionStore(storePath);
  assert.equal(store.canAttemptLogin("mashov", "123456:user1", undefined, now), true);

  store.saveSession(
    "mashov",
    "123456:user1",
    {
      providerType: "mashov",
      accountKey: "123456:user1",
      csrfToken: "csrf-abc",
      cookies: { "Csrf-Token": "csrf-abc" },
      childMetadata: { children: [{ childGuid: "g1", privateName: "נועה" }] },
      lastLoginTs: now,
      expiresAt: now + 12 * 3600 * 1000,
      consecutiveFailures: 0,
      lastFailureTs: 0,
    },
    now
  );

  // Reload from disk in fresh instance
  const reloaded = new SchoolSessionStore(storePath);
  const sess = reloaded.getSession("mashov", "123456:user1");
  assert.ok(sess);
  assert.equal(isSessionValid(sess, now + 60_000), true);
  assert.equal(isSessionValid(sess, now + 13 * 3600 * 1000), false);

  // First failure -> 30-minute cooldown
  reloaded.recordLoginFailure("mashov", "123456:user1", now);
  assert.equal(reloaded.canAttemptLogin("mashov", "123456:user1", 1800_000, now + 60_000), false);
  assert.equal(reloaded.canAttemptLogin("mashov", "123456:user1", 1800_000, now + 1801_000), true);

  // Second failure -> 2-hour lockout
  reloaded.recordLoginFailure("mashov", "123456:user1", now + 2000_000);
  assert.equal(
    reloaded.canAttemptLogin("mashov", "123456:user1", 1800_000, now + 2000_000 + 3600_000),
    false
  );
  assert.equal(
    reloaded.canAttemptLogin("mashov", "123456:user1", 1800_000, now + 2000_000 + 7201_000),
    true
  );

  // Success resets failure counter
  reloaded.recordLoginSuccess("mashov", "123456:user1");
  assert.equal(reloaded.canAttemptLogin("mashov", "123456:user1", 1800_000, now + 2000_000), true);
});
