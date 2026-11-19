import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { getCacheDir, getConfigPath, loadConfig, saveConfig } from "../config.js";
import { SchoolManager } from "../manager.js";
import { MashovClient, searchMashovSchools } from "../providers/mashov.js";
import { WebtopClient } from "../providers/webtop.js";
import { SchoolSessionStore } from "../session-store.js";
import type {
  AccountConfig,
  AppConfig,
  SchoolSystem,
  StudentOverrideConfig,
} from "../types.js";

export function upsertAccount(config: AppConfig, account: AccountConfig): AppConfig {
  const accounts = [...config.accounts];
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    const existingOverrides = accounts[idx].students;
    accounts[idx] = {
      ...account,
      students: account.students ?? existingOverrides,
    };
  } else {
    accounts.push(account);
  }
  return { ...config, accounts };
}

export function removeAccount(config: AppConfig, accountId: string): AppConfig {
  return {
    ...config,
    accounts: config.accounts.filter((a) => a.id !== accountId),
  };
}

export function upsertStudentOverride(
  config: AppConfig,
  accountId: string,
  override: StudentOverrideConfig
): AppConfig {
  const accounts = config.accounts.map((acc) => {
    if (acc.id !== accountId) return acc;
    const students = [...(acc.students ?? [])];
    const targetMatch = override.match.trim().toLowerCase();
    const idx = students.findIndex((s) => s.match.trim().toLowerCase() === targetMatch);
    if (idx >= 0) {
      students[idx] = { ...students[idx], ...override };
    } else {
      students.push(override);
    }
    return { ...acc, students };
  });
  return { ...config, accounts };
}

export function updateGeneralSettings(
  config: AppConfig,
  patch: Partial<
    Pick<
      AppConfig,
      | "timezone"
      | "schoolYear"
      | "cacheMinutes"
      | "quietHoursEnabled"
      | "quietHoursStart"
      | "quietHoursEnd"
      | "downloadAttachments"
    >
  >
): AppConfig {
  return { ...config, ...patch };
}

async function promptLine(
  rl: readline.Interface,
  q: string,
  defaultVal?: string
): Promise<string> {
  const suffix = defaultVal !== undefined && defaultVal !== "" ? ` [${defaultVal}]` : "";
  const ans = (await rl.question(`${q}${suffix}: `)).trim();
  return ans || defaultVal || "";
}

async function promptMashovSemel(
  rl: readline.Interface,
  defaultSemel?: number
): Promise<number | undefined> {
  const schoolInput = await promptLine(
    rl,
    "Mashov school code (semel) OR school name to search",
    defaultSemel ? String(defaultSemel) : undefined
  );
  if (/^\d{4,7}$/.test(schoolInput)) {
    return Number(schoolInput);
  }
  if (schoolInput) {
    console.log(`Searching Mashov schools for "${schoolInput}"...`);
    try {
      const matches = await searchMashovSchools(schoolInput);
      if (matches.length === 0) {
        console.log("No matching schools found. Enter the 6-digit school code (semel) manually.");
      } else {
        matches.slice(0, 12).forEach((m, idx) => {
          console.log(`  [${idx + 1}] ${m.semel} — ${m.name}${m.city ? ` (${m.city})` : ""}`);
        });
        const pick = await promptLine(rl, "Choose number (1..N) or enter semel directly", "1");
        const pickIdx = Number(pick) - 1;
        if (Number.isInteger(pickIdx) && pickIdx >= 0 && pickIdx < matches.length) {
          return matches[pickIdx].semel;
        }
        if (/^\d+$/.test(pick)) {
          return Number(pick);
        }
      }
    } catch (err) {
      console.log(`School lookup failed (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
  const manual = await promptLine(rl, "Enter Mashov school code (semel)");
  const parsed = Number(manual);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function verifyAccountLogin(
  account: AccountConfig,
  config: AppConfig,
  store: SchoolSessionStore,
  attachmentsDir: string
): Promise<boolean> {
  console.log(`\nTesting ${account.system} login for ${account.username}...`);
  try {
    const client =
      account.system === "mashov"
        ? new MashovClient({
            account,
            sessionStore: store,
            attachmentsDir,
            schoolYear: config.schoolYear,
          })
        : new WebtopClient({
            account,
            sessionStore: store,
            attachmentsDir,
            schoolYear: config.schoolYear,
          });
    // Invalidate previous session when verifying updated credentials
    store.invalidateSession(account.system, client.accountKey);
    const session = await client.login();
    const students = client.discoverStudentsFromSession(session);
    console.log(`Login succeeded! Discovered ${students.length} student(s):`);
    for (const st of students) {
      const cls = st.grade ? ` (${st.grade}${st.classNumber ? `-${st.classNumber}` : ""})` : "";
      console.log(`  - ${st.displayName}${cls} [${st.studentId}]`);
    }
    return true;
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function addAccountFlow(
  rl: readline.Interface,
  config: AppConfig,
  store: SchoolSessionStore,
  attachmentsDir: string
): Promise<AppConfig> {
  const sysRaw = (await promptLine(rl, "School portal (mashov / webtop)", "mashov")).toLowerCase();
  const system: SchoolSystem = sysRaw === "webtop" ? "webtop" : "mashov";
  const semel = system === "mashov" ? await promptMashovSemel(rl) : undefined;
  const username = await promptLine(rl, `${system.toUpperCase()} username / ID`);
  const password = await promptLine(rl, `${system.toUpperCase()} password`);
  const label = await promptLine(rl, "Optional account label (e.g. Middle School)", system);

  const account: AccountConfig = {
    id: system === "mashov" ? `mashov-${semel ?? 0}-${username}` : `webtop-${username}`,
    system,
    username,
    password,
    semel,
    label,
  };

  const ok = await verifyAccountLogin(account, config, store, attachmentsDir);
  if (!ok) {
    const saveAnyway = (await promptLine(rl, "Save account anyway? (y/N)", "n")).toLowerCase();
    if (saveAnyway !== "y" && saveAnyway !== "yes") {
      console.log("Account was NOT saved.");
      return config;
    }
  }
  return upsertAccount(config, account);
}

async function editAccountFlow(
  rl: readline.Interface,
  config: AppConfig,
  store: SchoolSessionStore,
  attachmentsDir: string
): Promise<AppConfig> {
  if (config.accounts.length === 0) {
    console.log("No accounts to edit.");
    return config;
  }
  config.accounts.forEach((acc, idx) => {
    console.log(
      `  [${idx + 1}] ${acc.id} (${acc.system}, user=${acc.username}${acc.semel ? `, semel=${acc.semel}` : ""})`
    );
  });
  const pick = Number(await promptLine(rl, "Select account number to edit", "1")) - 1;
  if (!Number.isInteger(pick) || pick < 0 || pick >= config.accounts.length) {
    console.log("Invalid selection.");
    return config;
  }

  const current = config.accounts[pick];
  const semel =
    current.system === "mashov" ? await promptMashovSemel(rl, current.semel) : undefined;
  const username = await promptLine(rl, "Username / ID", current.username);
  const newPassInput = await promptLine(rl, "New password (leave blank to keep existing)");
  const password = newPassInput || current.password;
  const label = await promptLine(rl, "Account label", current.label ?? current.system);

  const updated: AccountConfig = {
    ...current,
    username,
    password,
    semel,
    label,
  };

  const ok = await verifyAccountLogin(updated, config, store, attachmentsDir);
  if (!ok) {
    const keep = (await promptLine(rl, "Save updated account anyway? (y/N)", "n")).toLowerCase();
    if (keep !== "y" && keep !== "yes") {
      return config;
    }
  }
  return upsertAccount(config, updated);
}

async function editStudentOverridesFlow(
  rl: readline.Interface,
  config: AppConfig
): Promise<AppConfig> {
  if (config.accounts.length === 0) {
    console.log("No accounts configured.");
    return config;
  }
  config.accounts.forEach((acc, idx) => {
    console.log(`  [${idx + 1}] ${acc.id} (${acc.system}, user=${acc.username})`);
  });
  const pick = Number(await promptLine(rl, "Select account number", "1")) - 1;
  if (!Number.isInteger(pick) || pick < 0 || pick >= config.accounts.length) {
    console.log("Invalid selection.");
    return config;
  }
  const acc = config.accounts[pick];
  if (acc.students && acc.students.length > 0) {
    console.log("Current overrides:");
    acc.students.forEach((st) => {
      console.log(
        `  - match="${st.match}" displayName="${st.displayName ?? ""}" grade="${st.grade ?? ""}-${st.classNumber ?? ""}" ical=${st.examIcalUrl ? "set" : "none"}`
      );
    });
  }

  const match = await promptLine(rl, "Student first name or ID to match");
  if (!match) return config;

  const existing = acc.students?.find((s) => s.match.toLowerCase() === match.toLowerCase());
  const displayName = await promptLine(
    rl,
    "Display name override (leave blank to keep portal name)",
    existing?.displayName
  );
  const aliasesRaw = await promptLine(
    rl,
    "Comma-separated aliases (e.g. Noa,נועה)",
    existing?.aliases?.join(", ")
  );
  const grade = await promptLine(rl, "Grade letter for exam calendar (e.g. ח, ט)", existing?.grade);
  const classNumRaw = await promptLine(
    rl,
    "Class number for exam calendar (e.g. 3)",
    existing?.classNumber !== undefined ? String(existing.classNumber) : undefined
  );
  const tracksRaw = await promptLine(
    rl,
    "Comma-separated track keywords (e.g. מוזיקה, עמ\"ט)",
    existing?.tracks?.join(", ")
  );
  const examIcalUrl = await promptLine(
    rl,
    "Public Google Exam Calendar .ics URL (optional)",
    existing?.examIcalUrl
  );

  const override: StudentOverrideConfig = {
    match,
    displayName: displayName || undefined,
    aliases: aliasesRaw
      ? aliasesRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    grade: grade || undefined,
    classNumber: classNumRaw ? Number(classNumRaw) : undefined,
    tracks: tracksRaw
      ? tracksRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    examIcalUrl: examIcalUrl || undefined,
    fallbackTimetable: existing?.fallbackTimetable,
  };

  return upsertStudentOverride(config, acc.id, override);
}

async function removeAccountFlow(rl: readline.Interface, config: AppConfig): Promise<AppConfig> {
  if (config.accounts.length === 0) {
    console.log("No accounts to remove.");
    return config;
  }
  config.accounts.forEach((acc, idx) => {
    console.log(`  [${idx + 1}] ${acc.id} (${acc.system}, user=${acc.username})`);
  });
  const pick = Number(await promptLine(rl, "Select account number to remove")) - 1;
  if (!Number.isInteger(pick) || pick < 0 || pick >= config.accounts.length) {
    console.log("Cancelled.");
    return config;
  }
  const target = config.accounts[pick];
  const confirm = (await promptLine(rl, `Remove ${target.id}? (y/N)`, "n")).toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    return config;
  }
  return removeAccount(config, target.id);
}

async function editGeneralSettingsFlow(
  rl: readline.Interface,
  config: AppConfig
): Promise<AppConfig> {
  const timezone = await promptLine(rl, "Timezone", config.timezone);
  const cacheMinutes = Number(
    await promptLine(rl, "Cache TTL (minutes)", String(config.cacheMinutes))
  );
  const quietRaw = (
    await promptLine(
      rl,
      "Enable nocturnal quiet hours (y/n)",
      config.quietHoursEnabled ? "y" : "n"
    )
  ).toLowerCase();
  const quietHoursEnabled = quietRaw === "y" || quietRaw === "yes";
  const quietHoursStart = Number(
    await promptLine(rl, "Quiet hours start (0-23)", String(config.quietHoursStart))
  );
  const quietHoursEnd = Number(
    await promptLine(rl, "Quiet hours end (0-23)", String(config.quietHoursEnd))
  );
  const dlRaw = (
    await promptLine(
      rl,
      "Download & parse message attachments (y/n)",
      config.downloadAttachments ? "y" : "n"
    )
  ).toLowerCase();
  const downloadAttachments = dlRaw === "y" || dlRaw === "yes";

  return updateGeneralSettings(config, {
    timezone,
    cacheMinutes: Number.isFinite(cacheMinutes) && cacheMinutes > 0 ? cacheMinutes : config.cacheMinutes,
    quietHoursEnabled,
    quietHoursStart: Number.isFinite(quietHoursStart) ? quietHoursStart : config.quietHoursStart,
    quietHoursEnd: Number.isFinite(quietHoursEnd) ? quietHoursEnd : config.quietHoursEnd,
    downloadAttachments,
  });
}

function printConfigSummary(config: AppConfig): void {
  console.log(`Configured accounts (${config.accounts.length}):`);
  for (const acc of config.accounts) {
    const ovCount = acc.students?.length ?? 0;
    console.log(
      `  - ${acc.id} [${acc.system}] user=${acc.username}${acc.semel ? ` semel=${acc.semel}` : ""}${ovCount ? ` (${ovCount} student override(s))` : ""}`
    );
  }
  console.log(
    `Settings: tz=${config.timezone}, cache=${config.cacheMinutes}m, quietHours=${config.quietHoursEnabled ? `${config.quietHoursStart}:00-${config.quietHoursEnd}:00` : "off"}, attachments=${config.downloadAttachments ? "on" : "off"}\n`
  );
}

export async function runSetupWizard(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("\n=== il-school-mcp Setup & Configuration (Mashov & Webtop) ===");
    console.log(`Config file: ${getConfigPath()}\n`);

    let config = loadConfig();
    const cacheDir = getCacheDir();
    const store = new SchoolSessionStore(path.join(cacheDir, "school_sessions.json"));
    const attachmentsDir = path.join(cacheDir, "attachments");

    // First-run onboarding flow
    if (config.accounts.length === 0) {
      let addMore = true;
      while (addMore) {
        config = await addAccountFlow(rl, config, store, attachmentsDir);
        const again = (await promptLine(rl, "Add another account? (y/N)", "n")).toLowerCase();
        addMore = again === "y" || again === "yes";
      }
    } else {
      // Reconfiguration menu for existing setups
      let done = false;
      while (!done) {
        printConfigSummary(config);
        console.log("Choose an action:");
        console.log("  [1] Add account (Mashov / Webtop)");
        console.log("  [2] Edit existing account (password / semel / label)");
        console.log("  [3] Manage student overrides (nickname / exam calendar / class / tracks)");
        console.log("  [4] Remove account");
        console.log("  [5] Edit general settings (timezone / cache / quiet hours / attachments)");
        console.log("  [6] Save & exit");

        const choice = await promptLine(rl, "Action", "6");
        switch (choice) {
          case "1":
            config = await addAccountFlow(rl, config, store, attachmentsDir);
            break;
          case "2":
            config = await editAccountFlow(rl, config, store, attachmentsDir);
            break;
          case "3":
            config = await editStudentOverridesFlow(rl, config);
            break;
          case "4":
            config = await removeAccountFlow(rl, config);
            break;
          case "5":
            config = await editGeneralSettingsFlow(rl, config);
            break;
          case "6":
          default:
            done = true;
            break;
        }
        console.log("");
      }
    }

    const savedPath = saveConfig(config);
    console.log(`Saved configuration to ${savedPath} (permissions 0600).`);
    console.log("\nPlugin / MCP client ready. You can verify live data anytime with:");
    console.log("  node scripts/launch-mcp.mjs doctor");
  } finally {
    rl.close();
  }
}

export async function runDoctor(): Promise<void> {
  const config = loadConfig();
  console.log(`Config path: ${getConfigPath()}`);
  console.log(`Configured accounts: ${config.accounts.length}`);
  if (config.accounts.length === 0) {
    console.log("No accounts configured. Run `node scripts/launch-mcp.mjs setup` first.");
    process.exitCode = 1;
    return;
  }

  const manager = new SchoolManager({ config });
  const state = await manager.getFullState(true);
  console.log(`Students discovered: ${state.students.length}`);
  for (const st of state.students) {
    const lessonsCount = Object.values(state.timetables[st.displayName] ?? {}).reduce(
      (acc, arr) => acc + arr.length,
      0
    );
    console.log(`  - ${st.displayName} (${st.system}) | timetable lessons: ${lessonsCount}`);
  }
  console.log(
    `Homework: ${state.homework.length}, Exams: ${state.exams.length}, Behavior: ${state.behaviorEvents.length}, Messages: ${state.messages.length}`
  );
  if (state.errors.length > 0) {
    console.error("Errors:", state.errors);
    process.exitCode = 1;
  }
}
