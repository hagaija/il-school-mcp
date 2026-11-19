import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getZonedDateParts, HEBREW_DAY_NAMES, resolveDayQuery } from "./intelligence.js";
import { SchoolManager } from "./manager.js";
import { ensureLocalSetupServer, openUrlInBrowser } from "./web-setup.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

async function maybeAttachSetupPayload(
  manager: SchoolManager,
  needsSetup: boolean | undefined
): Promise<Record<string, unknown>> {
  if (!needsSetup) return {};
  const handle = await ensureLocalSetupServer(manager);
  return {
    needsSetup: true,
    setupUrl: handle.url,
    setupCommand: "node scripts/launch-mcp.mjs setup",
    setupNote:
      "No accounts configured yet. Share the setupUrl link with the user so they can enter Mashov/Webtop credentials locally in their browser (never ask for passwords in chat), then call school_list_students with refresh=true.",
  };
}

export function createSchoolMcpServer(manager: SchoolManager): McpServer {
  const server = new McpServer(
    {
      name: "il-school-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "Read-only assistant for Israeli school portals (Mashov & Webtop). " +
        "Call school_list_students first if you need to discover the family's children, classes, or systems. " +
        "If needsSetup is true (or the user asks to configure/modify accounts), call school_open_setup and share the localhost setupUrl link (never ask for passwords in chat). " +
        "When homework has dueDateInferred=true, explicitly note that the due date is estimated from inferredFromLesson. " +
        "When exams have studyMaterialStatus='missing', explicitly highlight that no study material was provided yet. " +
        "For behavior events, clearly distinguish positive ('positive'), negative ('negative'), and attendance events.",
    }
  );

  server.registerTool(
    "school_open_setup",
    {
      title: "Open Local School Setup Page",
      description:
        "Start (or reuse) a local-only 127.0.0.1 browser setup page so the user can add, test, or modify Mashov/Webtop accounts safely without typing passwords into chat.",
      inputSchema: {
        open_browser: z
          .boolean()
          .optional()
          .describe("Whether to attempt opening the default browser automatically (default true)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ open_browser }) => {
      const handle = await ensureLocalSetupServer(manager);
      if (open_browser !== false) {
        openUrlInBrowser(handle.url);
      }
      return jsonResult({
        setupUrl: handle.url,
        note: "Open this local 127.0.0.1 URL in your browser to add/test/update Mashov or Webtop accounts. Credentials stay on your computer and never enter chat.",
      });
    }
  );

  server.registerTool(
    "school_list_students",
    {
      title: "List School Students",
      description:
        "List all auto-discovered students across configured Mashov and Webtop accounts, including their display names, grades, classes, and portals.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Force a live refresh from Mashov/Webtop."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ refresh }) => {
      const state = await manager.getFullState(Boolean(refresh));
      const setupPayload = await maybeAttachSetupPayload(manager, state.needsSetup);
      return jsonResult({
        updatedAt: state.updatedAt,
        needsSetup: Boolean(state.needsSetup),
        ...setupPayload,
        count: state.students.length,
        students: state.students.map((s) => ({
          displayName: s.displayName,
          firstName: s.firstName,
          lastName: s.lastName,
          system: s.system,
          grade: s.grade,
          classNumber: s.classNumber,
          semel: s.semel,
          aliases: s.aliases,
          hasTimetable: Object.keys(state.timetables[s.displayName] ?? {}).length > 0,
        })),
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_schedule",
    {
      title: "Get School Schedule",
      description:
        "Get the lesson timetable (מערכת שעות) for one or all students for 'today', 'tomorrow', a Hebrew/English weekday (e.g. 'ראשון', 'tuesday'), a YYYY-MM-DD date, or 'week'.",
      inputSchema: {
        kid: z.string().optional().describe("Optional student name/alias. Omit for all students."),
        date_or_day: z
          .string()
          .optional()
          .describe("Target day: 'today', 'tomorrow', weekday name, 'YYYY-MM-DD', or 'week'. Defaults to 'today'."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kid, date_or_day }) => {
      const state = await manager.getFullState();
      if (state.needsSetup) {
        return jsonResult(await maybeAttachSetupPayload(manager, true));
      }
      const targetKid = manager.resolveStudentName(kid, state.students);
      const resolved = resolveDayQuery(date_or_day, state.timezone);
      const kids = targetKid ? [targetKid] : state.students.map((s) => s.displayName);

      if (resolved.mode === "week") {
        const schedules: Record<string, Record<string, unknown[]>> = {};
        for (const k of kids) {
          const tt = state.timetables[k] ?? {};
          schedules[k] = {};
          for (const dayStr of Object.keys(tt).sort((a, b) => Number(a) - Number(b))) {
            const d = Number(dayStr);
            schedules[k][HEBREW_DAY_NAMES[d] ?? dayStr] = tt[d] ?? [];
          }
        }
        return jsonResult({ mode: "week", schedules, updatedAt: state.updatedAt, errors: state.errors });
      }

      const schedules: Record<string, unknown[]> = {};
      for (const k of kids) {
        schedules[k] = state.timetables[k]?.[resolved.dayNum] ?? [];
      }
      return jsonResult({
        mode: "day",
        dayNum: resolved.dayNum,
        dayName: resolved.dayName,
        date: resolved.date,
        isShabbat: resolved.dayNum === 7,
        schedules,
        updatedAt: state.updatedAt,
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_homework",
    {
      title: "Get Homework Assignments",
      description:
        "Get homework assignments and due dates from Mashov/Webtop. If dueDateInferred is true, tell the parent the due date is estimated from inferredFromLesson.",
      inputSchema: {
        kid: z.string().optional().describe("Optional student name/alias. Omit for all students."),
        include_past_days: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("How many past days of assignments to include (default 3)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kid, include_past_days }) => {
      const state = await manager.getFullState();
      const targetKid = manager.resolveStudentName(kid, state.students);
      const days = include_past_days ?? 3;
      const cutoffIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);

      const items = state.homework.filter((hw) => {
        if (targetKid && hw.kid !== targetKid) return false;
        const refDay = (hw.dueDate ?? hw.assignedDate)?.slice(0, 10);
        if (refDay && refDay < cutoffIso) return false;
        return true;
      });

      return jsonResult({
        count: items.length,
        homework: items,
        updatedAt: state.updatedAt,
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_behavior",
    {
      title: "Get Behavior & Attendance Events",
      description:
        "Get school behavior and attendance logs from Mashov/Webtop. Clearly report whether each event is 'positive' (e.g. מילה טובה), 'negative' (e.g. אי הכנת ש.ב), 'attendance', or 'note'.",
      inputSchema: {
        kid: z.string().optional().describe("Optional student name/alias."),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Lookback window in days (default 14)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kid, days }) => {
      const state = await manager.getFullState();
      const targetKid = manager.resolveStudentName(kid, state.students);
      const lookback = days ?? 14;
      const cutoffIso = new Date(Date.now() - lookback * 24 * 3600 * 1000).toISOString();

      const events = state.behaviorEvents.filter(
        (ev) => (!targetKid || ev.kid === targetKid) && ev.eventDate >= cutoffIso
      );

      return jsonResult({
        count: events.length,
        days: lookback,
        events,
        updatedAt: state.updatedAt,
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_exams",
    {
      title: "Get Upcoming Exams & Study Material",
      description:
        "Get upcoming exams and quizzes from Mashov, teacher messages, and optional school Google Exam Calendars, with linked study materials (including PDF/DOCX attachments). Always flag when studyMaterialStatus is 'missing'.",
      inputSchema: {
        kid: z.string().optional().describe("Optional student name/alias."),
        days_ahead: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Days ahead to search (default 30)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kid, days_ahead }) => {
      const state = await manager.getFullState();
      const targetKid = manager.resolveStudentName(kid, state.students);
      const horizon = days_ahead ?? 30;
      const todayIso = getZonedDateParts(new Date(), state.timezone).isoDate;
      const endIso = getZonedDateParts(
        new Date(Date.now() + horizon * 24 * 3600 * 1000),
        state.timezone
      ).isoDate;

      const exams = state.exams.filter((ex) => {
        if (targetKid && ex.kid !== targetKid) return false;
        const d = ex.examDate.slice(0, 10);
        return d >= todayIso && d <= endIso;
      });

      const missingMaterialCount = exams.filter((e) => e.studyMaterialStatus === "missing").length;
      return jsonResult({
        count: exams.length,
        missingMaterialCount,
        exams,
        updatedAt: state.updatedAt,
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_messages",
    {
      title: "Get School Inbox Messages",
      description:
        "Get recent Mashov and Webtop inbox messages plus extracted text from PDF/DOCX attachments. Can filter by kid and category ('behavior', 'exam', 'study_material', 'general').",
      inputSchema: {
        kid: z.string().optional().describe("Optional student name/alias."),
        category: z
          .enum(["behavior", "exam", "study_material", "general"])
          .optional()
          .describe("Optional message category filter."),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Lookback window in days (default 14)."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ kid, category, days }) => {
      const state = await manager.getFullState();
      const targetKid = manager.resolveStudentName(kid, state.students);
      const lookback = days ?? 14;
      const cutoffIso = new Date(Date.now() - lookback * 24 * 3600 * 1000).toISOString();

      const messages = state.messages.filter((m) => {
        if (targetKid && m.kid !== targetKid && m.kid !== "משותף") return false;
        if (m.sentAt < cutoffIso) return false;
        if (category && !m.categories.includes(category)) return false;
        return true;
      });

      return jsonResult({
        count: messages.length,
        messages,
        updatedAt: state.updatedAt,
        errors: state.errors,
      });
    }
  );

  server.registerTool(
    "school_get_digest",
    {
      title: "Get Daily School Digest",
      description:
        "Get a consolidated family school digest: today and tomorrow timetables, active homework, 7-day upcoming exams (with missing study-material warnings), and recent behavior events.",
      inputSchema: {
        refresh: z.boolean().optional().describe("Force a live refresh from Mashov/Webtop."),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ refresh }) => {
      const state = await manager.getFullState(Boolean(refresh));
      if (state.needsSetup) {
        return jsonResult(await maybeAttachSetupPayload(manager, true));
      }
      const now = new Date();
      const todayParts = getZonedDateParts(now, state.timezone);
      const tomorrowParts = getZonedDateParts(
        new Date(now.getTime() + 24 * 3600 * 1000),
        state.timezone
      );
      const weekAheadIso = getZonedDateParts(
        new Date(now.getTime() + 7 * 24 * 3600 * 1000),
        state.timezone
      ).isoDate;
      const recentBehCutoff = new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();

      const todaySchedules: Record<string, unknown[]> = {};
      const tomorrowSchedules: Record<string, unknown[]> = {};
      for (const st of state.students) {
        todaySchedules[st.displayName] = state.timetables[st.displayName]?.[todayParts.hebrewDay] ?? [];
        tomorrowSchedules[st.displayName] =
          state.timetables[st.displayName]?.[tomorrowParts.hebrewDay] ?? [];
      }

      const activeHomework = state.homework.filter((hw) => {
        const assignedToday = hw.assignedDate?.slice(0, 10) === todayParts.isoDate;
        const dueTodayOrFuture = Boolean(hw.dueDate && hw.dueDate.slice(0, 10) >= todayParts.isoDate);
        return assignedToday || dueTodayOrFuture;
      });

      const upcomingExams7d = state.exams.filter((ex) => {
        const d = ex.examDate.slice(0, 10);
        return d >= todayParts.isoDate && d <= weekAheadIso;
      });

      const recentBehavior3d = state.behaviorEvents.filter((ev) => ev.eventDate >= recentBehCutoff);

      return jsonResult({
        updatedAt: state.updatedAt,
        students: state.students.map((s) => s.displayName),
        today: {
          date: todayParts.isoDate,
          dayNum: todayParts.hebrewDay,
          dayName: HEBREW_DAY_NAMES[todayParts.hebrewDay],
        },
        tomorrow: {
          date: tomorrowParts.isoDate,
          dayNum: tomorrowParts.hebrewDay,
          dayName: HEBREW_DAY_NAMES[tomorrowParts.hebrewDay],
        },
        todaySchedules,
        tomorrowSchedules,
        homework: activeHomework,
        upcomingExams7d,
        recentBehavior3d,
        errors: state.errors,
      });
    }
  );

  server.registerPrompt(
    "daily_briefing",
    {
      title: "Daily Israeli School Briefing",
      description: "Generate a concise parent-friendly summary of today/tomorrow schedules, homework, upcoming exams, and behavior.",
      argsSchema: {
        kid: z.string().optional().describe("Optional student name to focus on."),
      },
    },
    ({ kid }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              (kid ? `Summarize school updates for ${kid}. ` : "Summarize school updates for all kids. ") +
              "Call `school_get_digest` (and `school_get_messages` if needed). " +
              "Highlight any homework with estimated due dates (`dueDateInferred`), any upcoming exams missing study material (`studyMaterialStatus='missing'`), and clearly note positive vs. negative behavior events.",
          },
        },
      ],
    })
  );

  return server;
}

export async function runStdioServer(manager: SchoolManager): Promise<void> {
  // Ensure third-party libraries can never write stray logs to stdout in stdio MCP mode
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const server = createSchoolMcpServer(manager);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runHttpServer(
  manager: SchoolManager,
  opts: { host: string; port: number; bearerToken?: string }
): Promise<http.Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (reqUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: "il-school-mcp" }));
      return;
    }

    if (reqUrl.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    if (opts.bearerToken) {
      const authHeader = req.headers.authorization ?? "";
      const expected = `Bearer ${opts.bearerToken}`;
      if (authHeader !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let parsedBody: unknown;
    if (chunks.length > 0) {
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport && req.method === "POST") {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          if (transport) sessions.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) sessions.delete(transport.sessionId);
      };
      const mcpServer = createSchoolMcpServer(manager);
      await mcpServer.connect(transport);
    }

    if (!transport) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid MCP session ID" }));
      return;
    }

    await transport.handleRequest(req, res, parsedBody);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  return httpServer;
}
