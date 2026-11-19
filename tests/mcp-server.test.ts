import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SchoolManager } from "../src/manager.js";
import { createSchoolMcpServer, runHttpServer } from "../src/server.js";
import { SchoolSessionStore } from "../src/session-store.js";

function createTestManager(tmpDir: string): SchoolManager {
  const store = new SchoolSessionStore(path.join(tmpDir, "sessions.json"));
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/login")) {
      return new Response(
        JSON.stringify({
          accessToken: {
            children: [{ childGuid: "g-1", privateName: "נועה", familyName: "כהן", grade: "ח", classNum: 3 }],
          },
        }),
        { status: 200, headers: { "X-Csrf-Token": "tok-1" } }
      );
    }
    if (url.includes("/timetable")) {
      return new Response(
        JSON.stringify([
          { timeTable: { day: 1, lesson: 1 }, groupDetails: { subjectName: "מתמטיקה" } },
        ]),
        { status: 200 }
      );
    }
    if (url.includes("/homework")) {
      return new Response(
        JSON.stringify([
          { homeworkId: 1, subject: "חשבון", homework: "דף עבודה", lessonDate: "2026-11-19T08:00:00" },
        ]),
        { status: 200 }
      );
    }
    if (url.includes("/exams")) {
      const tomorrow = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
      return new Response(
        JSON.stringify([{ examId: 2, subject: "אנגלית", name: "מבחן באנגלית", examDate: tomorrow }]),
        { status: 200 }
      );
    }
    if (url.includes("/behave")) {
      return new Response(
        JSON.stringify([{ lessonId: 3, achvaName: "מילה טובה", timestamp: new Date().toISOString() }]),
        { status: 200 }
      );
    }
    if (url.includes("/api/mail/inbox/conversations")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };

  return new SchoolManager({
    config: {
      version: 1,
      timezone: "Asia/Jerusalem",
      cacheMinutes: 30,
      quietHoursEnabled: false,
      quietHoursStart: 22,
      quietHoursEnd: 6,
      downloadAttachments: false,
      accounts: [{ id: "m1", system: "mashov", username: "u1", password: "p1", semel: 123456 }],
    },
    sessionStore: store,
    attachmentsDir: path.join(tmpDir, "att"),
    fetchImpl: mockFetch,
  });
}

test("MCP server exposes all 8 tools and executes them end-to-end via InMemoryTransport", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-mcp-"));
  const manager = createTestManager(tmpDir);
  const server = createSchoolMcpServer(manager);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  await client.connect(clientTransport);

  const toolsList = await client.listTools();
  const toolNames = toolsList.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, [
    "school_get_behavior",
    "school_get_digest",
    "school_get_exams",
    "school_get_homework",
    "school_get_messages",
    "school_get_schedule",
    "school_list_students",
    "school_open_setup",
  ]);

  const studentsRes = await client.callTool({ name: "school_list_students", arguments: {} });
  const studentsJson = JSON.parse((studentsRes.content as Array<{ text: string }>)[0].text);
  assert.equal(studentsJson.needsSetup, false);
  assert.equal(studentsJson.count, 1);
  assert.equal(studentsJson.students[0].displayName, "נועה");

  const hwRes = await client.callTool({ name: "school_get_homework", arguments: { kid: "נועה", include_past_days: 30 } });
  const hwJson = JSON.parse((hwRes.content as Array<{ text: string }>)[0].text);
  assert.equal(hwJson.count, 1);
  assert.equal(hwJson.homework[0].dueDateInferred, true);

  const examsRes = await client.callTool({ name: "school_get_exams", arguments: {} });
  const examsJson = JSON.parse((examsRes.content as Array<{ text: string }>)[0].text);
  assert.equal(examsJson.missingMaterialCount, 1);

  const digestRes = await client.callTool({ name: "school_get_digest", arguments: {} });
  const digestJson = JSON.parse((digestRes.content as Array<{ text: string }>)[0].text);
  assert.deepEqual(digestJson.students, ["נועה"]);

  await client.close();
  await server.close();
});

test("MCP server reports needsSetup=true when no accounts are configured", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-empty-"));
  const manager = new SchoolManager({
    config: {
      version: 1,
      timezone: "Asia/Jerusalem",
      cacheMinutes: 30,
      quietHoursEnabled: false,
      quietHoursStart: 22,
      quietHoursEnd: 6,
      downloadAttachments: false,
      accounts: [],
    },
    sessionStore: new SchoolSessionStore(path.join(tmpDir, "sessions.json")),
    attachmentsDir: path.join(tmpDir, "att"),
  });
  const server = createSchoolMcpServer(manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-empty-client", version: "0.1.0" });
  await client.connect(clientTransport);

  const studentsRes = await client.callTool({ name: "school_list_students", arguments: {} });
  const studentsJson = JSON.parse((studentsRes.content as Array<{ text: string }>)[0].text);
  assert.equal(studentsJson.needsSetup, true);
  assert.equal(studentsJson.count, 0);
  assert.ok(String(studentsJson.setupUrl).startsWith("http://127.0.0.1:"));
  assert.ok(String(studentsJson.setupCommand).includes("setup"));

  const openRes = await client.callTool({
    name: "school_open_setup",
    arguments: { open_browser: false },
  });
  const openJson = JSON.parse((openRes.content as Array<{ text: string }>)[0].text);
  assert.equal(openJson.setupUrl, studentsJson.setupUrl);

  // Verify the local setup web UI serves HTML with valid token and rejects missing token
  const unauthSetup = await fetch(String(openJson.setupUrl).split("?")[0]);
  assert.equal(unauthSetup.status, 403);
  const setupHtmlRes = await fetch(openJson.setupUrl);
  assert.equal(setupHtmlRes.status, 200);
  const html = await setupHtmlRes.text();
  assert.ok(html.includes("il-school-mcp Setup"));

  await client.close();
  await server.close();
});

test("Streamable HTTP server enforces optional bearer token and serves /health", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-http-"));
  const manager = createTestManager(tmpDir);
  const httpServer = await runHttpServer(manager, {
    host: "127.0.0.1",
    port: 0,
    bearerToken: "secret-xyz",
  });

  try {
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const healthResp = await fetch(`${baseUrl}/health`);
    assert.equal(healthResp.status, 200);

    const unauthResp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(unauthResp.status, 401);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
