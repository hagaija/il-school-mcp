---
name: il-school-setup
description: >-
  Onboard or reconfigure Mashov and Webtop school portal accounts for il-school-mcp.
  Use when school_list_students reports needsSetup=true, when no students are
  configured, or when the user asks to connect, add, update, or remove a school account.
---

# Israeli School Setup & Reconfiguration

## Security Rule (Non-Negotiable)
**Never ask the user to type Mashov or Webtop passwords into chat.** Credentials must only be entered locally in the interactive terminal setup wizard so they stay on the user's machine (`~/.config/il-school-mcp/config.json`, mode `0600`) and never enter LLM conversation logs.

## When to Trigger
- `school_list_students` returns `needsSetup: true` or reports no configured accounts.
- The user says things like: "connect my Mashov/Webtop account", "add another child/school", "change my school password", "add an exam calendar URL", or "configure quiet hours".

## Guided Onboarding / Modification Steps
1. Explain that setup runs locally in their terminal so their school passwords stay private on their computer.
2. Provide the exact command to run (prefer the repo launcher if cloned/installed as a plugin, or `npx il-school-mcp setup`):
   ```bash
   node <PLUGIN_ROOT>/scripts/launch-mcp.mjs setup
   ```
   *(If they are already in the repository folder, `npm run setup` works too.)*
3. Summarize what the interactive `setup` wizard lets them do:
   - **First run:** Choose `mashov` (with built-in school-name search to find the 6-digit `semel`) or `webtop`, enter credentials, test login live, and verify auto-discovered children.
   - **Re-running `setup`:** Opens a menu to **Add account**, **Edit existing account** (password, `semel`, label), **Manage student overrides** (nicknames/aliases, Google Exam Calendar `.ics` URL, grade, class number, tracks), **Remove account**, or **Edit general settings** (timezone, cache TTL, quiet hours 22:00–06:00).
4. Once the user confirms they finished `setup`, call `school_list_students` with `refresh: true` to confirm all children are discovered and ready.
