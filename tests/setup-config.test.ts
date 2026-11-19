import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  removeAccount,
  updateGeneralSettings,
  upsertAccount,
  upsertStudentOverride,
} from "../src/cli/setup.js";
import { getDefaultConfig, loadConfig, saveConfig } from "../src/config.js";

test("setup config helpers support first-time creation, editing, student overrides, and removal", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const prevEnv = process.env.IL_SCHOOL_CONFIG;
  process.env.IL_SCHOOL_CONFIG = cfgPath;

  try {
    let cfg = getDefaultConfig();
    assert.equal(cfg.accounts.length, 0);

    // 1. Add initial Mashov & Webtop accounts
    cfg = upsertAccount(cfg, {
      id: "mashov-540123-u1",
      system: "mashov",
      username: "u1",
      password: "pw1",
      semel: 540123,
      label: "Middle",
    });
    cfg = upsertAccount(cfg, {
      id: "webtop-u2",
      system: "webtop",
      username: "u2",
      password: "pw2",
      label: "Elementary",
    });
    assert.equal(cfg.accounts.length, 2);

    // 2. Add student override & verify modifying account preserves overrides
    cfg = upsertStudentOverride(cfg, "mashov-540123-u1", {
      match: "כרמל",
      displayName: "כרמל",
      grade: "ט",
      classNumber: 4,
      tracks: ['עמ"ט'],
      examIcalUrl: "https://example.com/cal.ics",
    });
    cfg = upsertAccount(cfg, {
      id: "mashov-540123-u1",
      system: "mashov",
      username: "u1",
      password: "new-password",
      semel: 540123,
      label: "Updated Middle",
    });
    assert.equal(cfg.accounts[0].password, "new-password");
    assert.equal(cfg.accounts[0].students?.length, 1);
    assert.equal(cfg.accounts[0].students?.[0].examIcalUrl, "https://example.com/cal.ics");

    // 3. Update general settings & remove second account
    cfg = updateGeneralSettings(cfg, {
      cacheMinutes: 45,
      quietHoursEnabled: false,
      downloadAttachments: false,
    });
    cfg = removeAccount(cfg, "webtop-u2");

    saveConfig(cfg, cfgPath);
    const reloaded = loadConfig();
    assert.equal(reloaded.accounts.length, 1);
    assert.equal(reloaded.accounts[0].label, "Updated Middle");
    assert.equal(reloaded.cacheMinutes, 45);
    assert.equal(reloaded.quietHoursEnabled, false);
    assert.equal(reloaded.downloadAttachments, false);

    const mode = fs.statSync(cfgPath).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    if (prevEnv === undefined) {
      delete process.env.IL_SCHOOL_CONFIG;
    } else {
      process.env.IL_SCHOOL_CONFIG = prevEnv;
    }
  }
});
