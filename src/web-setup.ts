import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { removeAccount, updateGeneralSettings, upsertAccount } from "./cli/setup.js";
import { getCacheDir, getConfigPath, loadConfig, saveConfig } from "./config.js";
import { SchoolManager } from "./manager.js";
import { MashovClient, searchMashovSchools } from "./providers/mashov.js";
import { WebtopClient } from "./providers/webtop.js";
import { SchoolSessionStore } from "./session-store.js";
import type { AccountConfig, AppConfig, SchoolSystem } from "./types.js";

export interface LocalSetupHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

const activeServers = new WeakMap<SchoolManager, Promise<LocalSetupHandle>>();

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSetupHtml(token: string, configPath: string): string {
  const safeToken = escapeHtml(token);
  const safeCfgPath = escapeHtml(configPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>il-school-mcp Setup (Mashov &amp; Webtop)</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; }
    body { max-width: 760px; margin: 24px auto; padding: 0 16px; line-height: 1.5; }
    h1 { font-size: 1.45rem; margin-bottom: 4px; }
    .muted { opacity: 0.75; font-size: 0.9rem; }
    .card { border: 1px solid #8884; border-radius: 12px; padding: 16px; margin: 16px 0; }
    label { display: block; font-weight: 600; margin-top: 10px; font-size: 0.92rem; }
    input, select { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-top: 4px; border-radius: 8px; border: 1px solid #8886; font-size: 0.95rem; }
    button { margin-top: 12px; padding: 9px 14px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; font-weight: 600; cursor: pointer; }
    button.secondary { background: #475569; }
    button.danger { background: #dc2626; padding: 5px 10px; margin-top: 0; font-size: 0.85rem; }
    .row { display: flex; gap: 10px; align-items: end; }
    .row > * { flex: 1; }
    .row > button { flex: 0 0 auto; }
    .acc { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #8883; }
    .acc:last-child { border-bottom: 0; }
    .status { margin-top: 12px; padding: 10px 12px; border-radius: 8px; display: none; white-space: pre-wrap; }
    .status.ok { display: block; background: #16a34a22; border: 1px solid #16a34a88; }
    .status.err { display: block; background: #dc262622; border: 1px solid #dc262688; }
    .school-list { margin-top: 8px; max-height: 180px; overflow: auto; border: 1px solid #8884; border-radius: 8px; display: none; }
    .school-item { padding: 7px 10px; cursor: pointer; border-bottom: 1px solid #8882; }
    .school-item:hover { background: #2563eb22; }
  </style>
</head>
<body>
  <h1>il-school-mcp Setup (Mashov &amp; Webtop)</h1>
  <div class="muted">Local-only configuration saved directly on your machine at <code>${safeCfgPath}</code> (mode 0600). Passwords are never sent to AI chat.</div>

  <div class="card">
    <h2 style="margin-top:0;font-size:1.1rem">Configured Accounts</h2>
    <div id="accounts-list" class="muted">Loading...</div>
  </div>

  <div class="card">
    <h2 style="margin-top:0;font-size:1.1rem">Add or Update School Account</h2>
    <label for="system">Portal System</label>
    <select id="system">
      <option value="mashov">Mashov (משו״ב)</option>
      <option value="webtop">Webtop (SmartSchool)</option>
    </select>

    <div id="mashov-fields">
      <label for="school-search">Find Mashov School Code (סמל מוסד)</label>
      <div class="row">
        <input id="school-search" placeholder="Type school name or city (e.g. בן גוריון הרצליה)..." />
        <button type="button" class="secondary" id="search-btn">Search</button>
      </div>
      <div id="school-results" class="school-list"></div>

      <label for="semel">Mashov School Code (semel)</label>
      <input id="semel" type="number" placeholder="6-digit school code" />
    </div>

    <label for="username">Username / ID</label>
    <input id="username" autocomplete="username" />

    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" />

    <label for="label">Optional Label (e.g. Middle School)</label>
    <input id="label" placeholder="Optional" />

    <button type="button" id="save-acc-btn">Test Login &amp; Save Account</button>
    <div id="acc-status" class="status"></div>
  </div>

  <div class="card">
    <h2 style="margin-top:0;font-size:1.1rem">General Settings</h2>
    <div class="row">
      <div>
        <label for="tz">Timezone</label>
        <input id="tz" value="Asia/Jerusalem" />
      </div>
      <div>
        <label for="cache">Cache TTL (minutes)</label>
        <input id="cache" type="number" min="1" value="30" />
      </div>
    </div>
    <div class="row">
      <div>
        <label for="quiet">Quiet Hours (22:00–06:00)</label>
        <select id="quiet">
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </div>
      <div>
        <label for="att">Download &amp; Parse PDF/DOCX</label>
        <select id="att">
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </div>
    </div>
    <button type="button" class="secondary" id="save-settings-btn">Save General Settings</button>
    <div id="settings-status" class="status"></div>
  </div>

  <script>
    const TOKEN = ${JSON.stringify(safeToken)};
    const api = (path, opts) => fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN), opts);

    const sysEl = document.getElementById('system');
    const mashovFields = document.getElementById('mashov-fields');
    sysEl.addEventListener('change', () => {
      mashovFields.style.display = sysEl.value === 'mashov' ? 'block' : 'none';
    });

    function showStatus(el, ok, msg) {
      el.className = 'status ' + (ok ? 'ok' : 'err');
      el.textContent = msg;
    }

    async function loadState() {
      const res = await api('/api/state');
      const data = await res.json();
      const listEl = document.getElementById('accounts-list');
      if (!data.accounts.length) {
        listEl.textContent = 'No accounts configured yet.';
      } else {
        listEl.innerHTML = '';
        for (const acc of data.accounts) {
          const row = document.createElement('div');
          row.className = 'acc';
          const info = document.createElement('div');
          info.textContent = acc.id + ' [' + acc.system + '] user=' + acc.username + (acc.semel ? ' semel=' + acc.semel : '');
          const btn = document.createElement('button');
          btn.className = 'danger';
          btn.textContent = 'Remove';
          btn.onclick = async () => {
            await api('/api/accounts/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: acc.id })
            });
            loadState();
          };
          row.appendChild(info);
          row.appendChild(btn);
          listEl.appendChild(row);
        }
      }
      document.getElementById('tz').value = data.timezone || 'Asia/Jerusalem';
      document.getElementById('cache').value = String(data.cacheMinutes ?? 30);
      document.getElementById('quiet').value = String(Boolean(data.quietHoursEnabled));
      document.getElementById('att').value = String(Boolean(data.downloadAttachments));
    }

    document.getElementById('search-btn').onclick = async () => {
      const q = document.getElementById('school-search').value.trim();
      const box = document.getElementById('school-results');
      box.style.display = 'block';
      box.textContent = 'Searching...';
      const res = await api('/api/schools?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (!data.schools || !data.schools.length) {
        box.textContent = 'No matching schools found.';
        return;
      }
      box.innerHTML = '';
      for (const s of data.schools) {
        const div = document.createElement('div');
        div.className = 'school-item';
        div.textContent = s.semel + ' — ' + s.name + (s.city ? ' (' + s.city + ')' : '');
        div.onclick = () => {
          document.getElementById('semel').value = String(s.semel);
          box.style.display = 'none';
        };
        box.appendChild(div);
      }
    };

    document.getElementById('save-acc-btn').onclick = async () => {
      const st = document.getElementById('acc-status');
      showStatus(st, true, 'Testing login...');
      const body = {
        system: sysEl.value,
        semel: document.getElementById('semel').value ? Number(document.getElementById('semel').value) : undefined,
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        label: document.getElementById('label').value.trim() || undefined,
      };
      const res = await api('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        showStatus(st, false, data.error || 'Failed to save account.');
        return;
      }
      document.getElementById('password').value = '';
      const kids = (data.students || []).map(k => k.displayName + (k.grade ? ' (' + k.grade + (k.classNumber ? '-' + k.classNumber : '') + ')' : '')).join(', ');
      showStatus(st, true, 'Connected and saved! Discovered student(s): ' + (kids || 'none') + '\\nYou can now return to your AI chat and ask your question.');
      loadState();
    };

    document.getElementById('save-settings-btn').onclick = async () => {
      const st = document.getElementById('settings-status');
      const res = await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone: document.getElementById('tz').value.trim(),
          cacheMinutes: Number(document.getElementById('cache').value),
          quietHoursEnabled: document.getElementById('quiet').value === 'true',
          downloadAttachments: document.getElementById('att').value === 'true',
        })
      });
      if (res.ok) {
        showStatus(st, true, 'General settings saved.');
      } else {
        showStatus(st, false, 'Failed to save settings.');
      }
    };

    loadState();
  </script>
</body>
</html>`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function openUrlInBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort browser launch
  }
}

export async function startLocalSetupServer(
  manager: SchoolManager,
  opts?: { port?: number }
): Promise<LocalSetupHandle> {
  const token = crypto.randomBytes(20).toString("hex");
  const cacheDir = getCacheDir();
  const store = new SchoolSessionStore(path.join(cacheDir, "school_sessions.json"));
  const attachmentsDir = path.join(cacheDir, "attachments");

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const providedToken = reqUrl.searchParams.get("token") ?? req.headers["x-setup-token"];
      if (providedToken !== token) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: invalid setup token" }));
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/setup") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderSetupHtml(token, getConfigPath()));
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/api/state") {
        const cfg = loadConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            timezone: cfg.timezone,
            cacheMinutes: cfg.cacheMinutes,
            quietHoursEnabled: cfg.quietHoursEnabled,
            downloadAttachments: cfg.downloadAttachments,
            accounts: cfg.accounts.map((a) => ({
              id: a.id,
              system: a.system,
              username: a.username,
              semel: a.semel,
              label: a.label,
            })),
          })
        );
        return;
      }

      if (req.method === "GET" && reqUrl.pathname === "/api/schools") {
        const q = reqUrl.searchParams.get("q") ?? "";
        const schools = await searchMashovSchools(q);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schools }));
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/api/accounts") {
        const body = await readJsonBody(req);
        const system: SchoolSystem = body.system === "webtop" ? "webtop" : "mashov";
        const username = String(body.username ?? "").trim();
        const password = String(body.password ?? "");
        const semel = body.semel ? Number(body.semel) : undefined;
        const label = body.label ? String(body.label).trim() : undefined;

        if (!username || !password) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Username and password are required." }));
          return;
        }
        if (system === "mashov" && (!semel || !Number.isFinite(semel))) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Mashov school code (semel) is required." }));
          return;
        }

        const account: AccountConfig = {
          id: system === "mashov" ? `mashov-${semel}-${username}` : `webtop-${username}`,
          system,
          username,
          password,
          semel,
          label,
        };

        let cfg: AppConfig = loadConfig();
        const client =
          system === "mashov"
            ? new MashovClient({ account, sessionStore: store, attachmentsDir, schoolYear: cfg.schoolYear })
            : new WebtopClient({ account, sessionStore: store, attachmentsDir, schoolYear: cfg.schoolYear });
        store.invalidateSession(system, client.accountKey);
        const session = await client.login();
        const students = client.discoverStudentsFromSession(session);

        cfg = upsertAccount(cfg, account);
        saveConfig(cfg);
        manager.reloadConfig();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, students }));
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/api/accounts/delete") {
        const body = await readJsonBody(req);
        const id = String(body.id ?? "");
        const cfg = removeAccount(loadConfig(), id);
        saveConfig(cfg);
        manager.reloadConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && reqUrl.pathname === "/api/settings") {
        const body = await readJsonBody(req);
        const current = loadConfig();
        const updated = updateGeneralSettings(current, {
          timezone: typeof body.timezone === "string" && body.timezone ? body.timezone : current.timezone,
          cacheMinutes:
            typeof body.cacheMinutes === "number" && body.cacheMinutes > 0
              ? body.cacheMinutes
              : current.cacheMinutes,
          quietHoursEnabled:
            typeof body.quietHoursEnabled === "boolean"
              ? body.quietHoursEnabled
              : current.quietHoursEnabled,
          downloadAttachments:
            typeof body.downloadAttachments === "boolean"
              ? body.downloadAttachments
              : current.downloadAttachments,
        });
        saveConfig(updated);
        manager.reloadConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      );
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(opts?.port ?? 0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/setup?token=${token}`;

  return {
    url,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export function ensureLocalSetupServer(manager: SchoolManager): Promise<LocalSetupHandle> {
  const existing = activeServers.get(manager);
  if (existing) return existing;
  const created = startLocalSetupServer(manager);
  activeServers.set(manager, created);
  return created;
}
