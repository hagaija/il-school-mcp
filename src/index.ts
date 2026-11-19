#!/usr/bin/env node
import { runDoctor, runSetupWizard } from "./cli/setup.js";
import { SchoolManager } from "./manager.js";
import { runHttpServer, runStdioServer } from "./server.js";

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "setup") {
    await runSetupWizard();
    return;
  }

  if (cmd === "doctor") {
    await runDoctor();
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(`il-school-mcp — Local MCP server for Mashov & Webtop

Usage:
  il-school-mcp                  Start MCP server over stdio (Claude Desktop, Antigravity, Cursor, Codex)
  il-school-mcp --http           Start Streamable HTTP MCP server (for local tunnel / ChatGPT Desktop)
    --host <host>                Bind address (default 127.0.0.1)
    --port <port>                Listen port (default 3333)
    --token <bearer>             Optional Bearer token (or set IL_SCHOOL_HTTP_TOKEN)
  il-school-mcp setup            Interactive setup wizard (school search + login test)
  il-school-mcp doctor           Verify live connectivity and discovered students
`);
    return;
  }

  const manager = new SchoolManager();

  if (args.includes("--http")) {
    const host = parseArg(args, "--host") ?? "127.0.0.1";
    const port = Number(parseArg(args, "--port") ?? "3333");
    const bearerToken = parseArg(args, "--token") ?? process.env.IL_SCHOOL_HTTP_TOKEN;
    await runHttpServer(manager, { host, port, bearerToken });
    console.error(`il-school-mcp HTTP server listening on http://${host}:${port}/mcp`);
    return;
  }

  await runStdioServer(manager);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
