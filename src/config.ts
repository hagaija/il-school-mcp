import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountConfig, AppConfig } from "./types.js";

export function getConfigDir(): string {
  if (process.env.IL_SCHOOL_HOME) {
    return path.resolve(process.env.IL_SCHOOL_HOME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "il-school-mcp");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "il-school-mcp");
  }
  return path.join(os.homedir(), ".config", "il-school-mcp");
}

export function getConfigPath(): string {
  if (process.env.IL_SCHOOL_CONFIG) {
    return path.resolve(process.env.IL_SCHOOL_CONFIG);
  }
  return path.join(getConfigDir(), "config.json");
}

export function getCacheDir(): string {
  if (process.env.IL_SCHOOL_CACHE_DIR) {
    return path.resolve(process.env.IL_SCHOOL_CACHE_DIR);
  }
  return path.join(getConfigDir(), "cache");
}

export function getDefaultConfig(): AppConfig {
  return {
    version: 1,
    timezone: "Asia/Jerusalem",
    cacheMinutes: 30,
    quietHoursEnabled: true,
    quietHoursStart: 22,
    quietHoursEnd: 6,
    downloadAttachments: true,
    accounts: [],
  };
}

function accountsFromEnv(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  const mashovUser = process.env.MASHOV_USERNAME?.trim();
  const mashovPass = process.env.MASHOV_PASSWORD?.trim();
  const mashovSemelRaw = process.env.MASHOV_SEMEL?.trim();
  if (mashovUser && mashovPass && mashovSemelRaw) {
    const semel = Number(mashovSemelRaw);
    if (Number.isFinite(semel) && semel > 0) {
      accounts.push({
        id: `mashov-${semel}-${mashovUser}`,
        system: "mashov",
        username: mashovUser,
        password: mashovPass,
        semel,
      });
    }
  }

  const webtopUser = process.env.WEBTOP_USERNAME?.trim();
  const webtopPass = process.env.WEBTOP_PASSWORD?.trim();
  if (webtopUser && webtopPass) {
    accounts.push({
      id: `webtop-${webtopUser}`,
      system: "webtop",
      username: webtopUser,
      password: webtopPass,
    });
  }

  return accounts;
}

export function loadConfig(): AppConfig {
  const cfgPath = getConfigPath();
  const base = getDefaultConfig();

  let fileData: Partial<AppConfig> = {};
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    fileData = parsed ?? {};
  }

  const envAccounts = accountsFromEnv();
  const fileAccounts = Array.isArray(fileData.accounts) ? fileData.accounts : [];

  const mergedAccounts = [...fileAccounts];
  for (const envAcc of envAccounts) {
    if (!mergedAccounts.some((a) => a.id === envAcc.id)) {
      mergedAccounts.push(envAcc);
    }
  }

  return {
    ...base,
    ...fileData,
    timezone: process.env.IL_SCHOOL_TIMEZONE?.trim() || fileData.timezone || base.timezone,
    cacheMinutes: process.env.IL_SCHOOL_CACHE_MINUTES
      ? Number(process.env.IL_SCHOOL_CACHE_MINUTES)
      : (fileData.cacheMinutes ?? base.cacheMinutes),
    accounts: mergedAccounts,
  };
}

export function saveConfig(config: AppConfig, targetPath?: string): string {
  const cfgPath = targetPath ? path.resolve(targetPath) : getConfigPath();
  const dir = path.dirname(cfgPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmpPath = `${cfgPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, cfgPath);
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch {
    // Ignore on platforms that do not support POSIX chmod
  }
  return cfgPath;
}
