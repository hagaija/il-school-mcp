#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const distEntry = path.join(rootDir, "dist", "index.js");
const nodeModulesDir = path.join(rootDir, "node_modules");

function ensureBuilt() {
  const needsInstall = !fs.existsSync(nodeModulesDir);
  const needsBuild = !fs.existsSync(distEntry);
  if (!needsInstall && !needsBuild) {
    return;
  }

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (needsInstall) {
    console.error("[il-school-mcp] Installing dependencies...");
    const installRes = spawnSync(npmCmd, ["install", "--no-audit", "--no-fund"], {
      cwd: rootDir,
      stdio: ["ignore", 2, 2],
    });
    if (installRes.status !== 0) {
      process.exit(installRes.status ?? 1);
    }
  }

  if (needsBuild || !fs.existsSync(distEntry)) {
    console.error("[il-school-mcp] Building TypeScript server...");
    const buildRes = spawnSync(npmCmd, ["run", "build"], {
      cwd: rootDir,
      stdio: ["ignore", 2, 2],
    });
    if (buildRes.status !== 0) {
      process.exit(buildRes.status ?? 1);
    }
  }
}

ensureBuilt();
await import(pathToFileURL(distEntry).href);
