# il-school-mcp — Agent Instructions

This repository implements an Israeli school portal MCP server (**Mashov / משו״ב** and **Webtop / SmartSchool**) packaged as a cross-platform desktop plugin for **Claude**, **Antigravity**, and **ChatGPT / Codex**.

## Running the MCP Server

### 1. Default `stdio` mode (Claude Desktop, Antigravity, Cursor, Claude Code, Codex)
```bash
node scripts/launch-mcp.mjs
# or directly after build:
node dist/index.js
```
- Uses `stdin`/`stdout` exclusively for JSON-RPC MCP messages.
- `scripts/launch-mcp.mjs` automatically runs `npm install` and `npm run build` (sending build logs to `stderr`) if `node_modules/` or `dist/` are missing after a fresh clone.

### 2. Streamable HTTP mode (ChatGPT Desktop standard chat via local tunnel)
```bash
node dist/index.js --http --host 127.0.0.1 --port 3333 --token "<secret-token>"
```
- Endpoint: `http://127.0.0.1:3333/mcp` (`GET /health` returns `{ "ok": true, "server": "il-school-mcp" }`).
- If `--token` (or `IL_SCHOOL_HTTP_TOKEN`) is set, all `/mcp` requests require `Authorization: Bearer <token>`.

## Setup & Reconfiguration

* **First-time setup or modifying existing config:**
  ```bash
  node scripts/launch-mcp.mjs setup
  # or: npm run setup
  ```
* **Verify live connectivity and discovered students:**
  ```bash
  node scripts/launch-mcp.mjs doctor
  ```

## Configuration & Storage
* **Config file:** `~/.config/il-school-mcp/config.json` (or `IL_SCHOOL_CONFIG` env var, permissions `0600`).
* **Session cache:** `~/.config/il-school-mcp/cache/school_sessions.json` (12-hour TTL + 30m/2h circuit breaker to prevent parent SMS login spam).
* **Env-var overrides (single account):** `MASHOV_USERNAME`, `MASHOV_PASSWORD`, `MASHOV_SEMEL`, `WEBTOP_USERNAME`, `WEBTOP_PASSWORD`, `IL_SCHOOL_TIMEZONE`, `IL_SCHOOL_CACHE_MINUTES`.

## Development & Verification
```bash
npm run build
npm test
agy plugin validate --strict .
```

## Non-Negotiable Operational Rules
1. **Never ask parents to paste school passwords into LLM chat.** Always direct them to run `setup` locally in a terminal.
2. **Never log secrets** or print non-JSON-RPC text to `stdout` when running in `stdio` MCP mode.
3. **Never bypass the session store or circuit breaker** when querying Mashov or Webtop.
