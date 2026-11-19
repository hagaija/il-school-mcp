# il-school-mcp

Local-first, read-only **agentic plugin & MCP server** for Israeli school portals (**Mashov / משו״ב** and **Webtop / SmartSchool**), packaged to install cleanly in **Claude**, **Antigravity**, and **ChatGPT / Codex**.

## Features
- **Cross-Platform Plugin Structure:** Includes native manifests and skills for Claude Code / Marketplace (`.claude-plugin/` + `.mcp.json`), Claude Desktop (`manifest.json`), Antigravity (`.antigravity-plugin/` + `mcp_config.json` + `rules/AGENTS.md`), and ChatGPT / OpenAI Agent Plugins & Codex (`plugin.json` + `mcp.json` + `.codex-plugin/`), sharing portable `skills/`.
- **Zero-Redundant-Login Session Store:** Persists Mashov (`X-Csrf-Token` + cookies) and Webtop (`webToken`) sessions for 12 hours, re-authenticates once on expiration, and enforces a 30-minute / 2-hour circuit breaker on failures so parents don't get spammed with login SMS alerts.
- **Multi-Account & Auto-Discovery:** Supports any combination of Mashov and Webtop parent/student accounts and automatically discovers linked children, grades, and classes.
- **Smart Enrichment:**
  - Infers missing homework due dates from the child's weekly timetable (skipping Shabbat).
  - Classifies behavior & attendance events (`positive`, `negative`, `attendance`, `note`).
  - Downloads and extracts text from `.pdf` and `.docx` message attachments and links study materials to upcoming exams.
  - Optional per-student public Google Exam Calendar `.ics` filtering by grade, class, and tracks.

---

## Installing as a Plugin

### 1. Claude (Claude Code / Claude Marketplace / Claude Desktop)
* **Claude Code (GitHub marketplace):**
  ```text
  /plugin marketplace add hagaija/il-school-mcp
  /plugin install il-school@il-school-marketplace
  ```
* **Manual MCP entry (`claude_desktop_config.json`):**
  ```json
  {
    "mcpServers": {
      "il-school": {
        "command": "node",
        "args": ["/ABS/PATH/TO/il-school-mcp/scripts/launch-mcp.mjs"]
      }
    }
  }
  ```

### 2. Antigravity
Clone and install directly via CLI:
```bash
git clone https://github.com/hagaija/il-school-mcp.git
agy plugin install ./il-school-mcp
```
Restart Antigravity after installing a new plugin directory, then ask one of the starter prompts or invoke `/il-school-assistant` / `/il-school-setup`.

### 3. ChatGPT / OpenAI Agent Plugins & Codex
* **Codex / Agent Plugin marketplace:**
  Uses root `plugin.json` + `mcp.json`, `.agents/plugins/marketplace.json`, and `.codex-plugin/plugin.json` + `.mcp.json`:
  ```bash
  codex marketplace add hagaija/il-school-mcp
  ```
  Or manually in `~/.codex/config.toml`:
  ```toml
  [mcp_servers.il-school]
  command = "node"
  args = ["/ABS/PATH/TO/il-school-mcp/scripts/launch-mcp.mjs"]
  ```
* **Standard ChatGPT Desktop chat mode:** Requires a remote HTTPS MCP endpoint. Run the built-in Streamable HTTP server locally with a bearer token and expose it privately over Tailscale Funnel or Cloudflare Tunnel:
  ```bash
  node /ABS/PATH/TO/il-school-mcp/dist/index.js --http --port 3333 --token "your-secret-token"
  ```
  Endpoint: `https://<your-tunnel-host>/mcp`

---

## First-Time Setup & Modifying Config

Credentials are kept **strictly local** in `~/.config/il-school-mcp/config.json` (`0600`) and are never entered into LLM chat.

```bash
node scripts/launch-mcp.mjs setup
```
- **On first run (no config yet):** Launches the onboarding flow to search Mashov schools by name (or enter `semel`), add Mashov/Webtop credentials, test login live, and show discovered students.
- **When run again:** Opens a reconfiguration menu to **add**, **edit** (update password/`semel`/label), or **remove** accounts, configure **student overrides** (nicknames, aliases, exam `.ics` calendar URLs, tracks), and adjust **general settings** (timezone, cache TTL, quiet hours, attachment downloads).

Verify connectivity anytime:
```bash
node scripts/launch-mcp.mjs doctor
```

---

## Bundled Skills & Agent Guide
* `AGENTS.md`: Instructions for running, configuring, and testing the MCP server.
* `skills/il-school-assistant/SKILL.md`: Daily briefings, schedules, homework, exam prep, and behavior reporting rules.
* `skills/il-school-setup/SKILL.md`: First-time onboarding & reconfiguration workflow when `needsSetup: true` is detected.
* `rules/AGENTS.md`: Always-on Antigravity plugin rules.

## Available MCP Tools
1. `school_list_students` — Lists auto-discovered children, classes, and portals (or `needsSetup: true` before initial setup).
2. `school_get_schedule` — Timetable for `today`, `tomorrow`, weekday name, `YYYY-MM-DD`, or `week`.
3. `school_get_homework` — Homework assignments (with `dueDateInferred` estimation).
4. `school_get_behavior` — Behavior & attendance events (`positive`, `negative`, `attendance`, `note`).
5. `school_get_exams` — Upcoming exams + linked study materials (`provided` vs. `missing`).
6. `school_get_messages` — School inbox messages + extracted PDF/DOCX attachment text.
7. `school_get_digest` — Consolidated daily/tomorrow family briefing.

---

## Acknowledgments, Disclaimer & License
- **Credits:** Webtop (SmartSchool) API endpoint integration was informed by Tomer Klein's open-source [`pywebtop`](https://github.com/t0mer/pywebtop) (MIT License) as well as community-documented Mashov API conventions.
- **Disclaimer:** This project is an unofficial, independent read-only client and is not affiliated with, endorsed by, or supported by Mashov or SmartSchool/Webtop.
- **License:** [MIT](LICENSE) © 2026 Hagai Jacobson.

