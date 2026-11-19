---
name: il-school-setup
description: >-
  Onboard or reconfigure Mashov and Webtop school portal accounts for il-school-mcp.
  Use when school_list_students reports needsSetup=true, when no students are
  configured, or when the user asks to connect, add, update, or remove a school account.
---

# Israeli School Setup & Reconfiguration

## Security Rule (Non-Negotiable)
**Never ask the user to type Mashov or Webtop passwords into chat.** Credentials must only be entered locally on the user's own computer so they stay in `~/.config/il-school-mcp/config.json` (mode `0600`) and never enter LLM conversation logs.

## When to Trigger
- Any `school_*` tool returns `needsSetup: true` or `setupUrl`.
- The user asks to connect Mashov/Webtop, add a child/school, update a password, or change settings.

## Guided Onboarding / Modification Steps
1. Call `school_open_setup` (or use the `setupUrl` returned by `school_list_students` / `school_get_digest`).
2. Share the clickable localhost URL (`http://127.0.0.1:<port>/setup?token=...`) with the user. Explain that it opens a local setup page on their own computer where they can:
   - Search for their Mashov school by name (to find the 6-digit `semel`) or enter a `semel` directly,
   - Add/update Mashov and/or Webtop credentials and test login immediately,
   - Remove accounts or update general settings (timezone, cache, quiet hours, attachment downloads).
3. If the user prefers a terminal instead of a browser, they can also run:
   ```bash
   node <PLUGIN_ROOT>/scripts/launch-mcp.mjs setup
   ```
4. Once the user confirms they saved their accounts, call `school_list_students` with `refresh: true` to confirm all children are discovered and answer their original question.
