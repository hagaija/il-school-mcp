import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  classifyBehaviorCategory,
  classifyMessageCategories,
  extractAttachmentText,
  htmlToText,
} from "../intelligence.js";
import { isSessionValid, SchoolSessionStore } from "../session-store.js";
import type {
  AccountConfig,
  BehaviorEvent,
  DiscoveredStudent,
  MessageAttachment,
  ScheduleLesson,
  SchoolItem,
  SchoolMessage,
  SchoolSession,
  StudentOverrideConfig,
} from "../types.js";
import { computeAcademicYear, type AccountFetchResult, type FetchLike } from "./mashov.js";

const WEBTOP_BASE = "https://webtopserver.smartschool.co.il/server";
const WEBTOP_ORIGIN = "https://webtop.smartschool.co.il";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const WEBTOP_AES_KEY = Buffer.from("01234567890000000150778345678901", "utf8");
const WEBTOP_AES_IV = Buffer.from("6543210987654321", "utf8");

export function encryptWebtopPayload(username: string): string {
  const plaintext = JSON.stringify(`${username}0`);
  const cipher = crypto.createCipheriv("aes-256-cbc", WEBTOP_AES_KEY, WEBTOP_AES_IV);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\-\u0590-\u05FF]/g, "_");
  return base.slice(0, 120) || "attachment";
}

function matchOverride(
  rawChild: Record<string, unknown>,
  overrides: StudentOverrideConfig[] | undefined
): StudentOverrideConfig | undefined {
  if (!overrides || overrides.length === 0) return undefined;
  const id = String(rawChild.id ?? "");
  const first = String(rawChild.firstName ?? "").trim();
  const last = String(rawChild.lastName ?? "").trim();
  const full = `${first} ${last}`.trim();

  return overrides.find((ov) => {
    const m = ov.match.trim().toLowerCase();
    return (
      (id && id.toLowerCase() === m) ||
      (first && first.toLowerCase() === m) ||
      (full && full.toLowerCase() === m) ||
      (first && m.includes(first.toLowerCase()))
    );
  });
}

export function normalizeWebtopHomework(
  student: DiscoveredStudent,
  rawTasks: Array<Record<string, unknown>> | null | undefined,
  now: Date = new Date()
): SchoolItem[] {
  const items: SchoolItem[] = [];
  for (let idx = 0; idx < (rawTasks ?? []).length; idx += 1) {
    const task = rawTasks![idx];
    if ("homeworkData" in task || "lesson" in task) {
      const hwText = String(task.homeworkData ?? "").trim();
      if (!hwText) continue;
      const subject = String(task.lesson ?? task.subject ?? "כללי").trim();
      const lessonSubj = String(task.lessonSubject ?? "").trim();
      const teacher = String(task.teacher ?? "").trim();
      const detailsParts: string[] = [];
      if (lessonSubj) detailsParts.push(`נושא השיעור: ${lessonSubj}`);
      if (teacher) detailsParts.push(`מורה: ${teacher}`);

      items.push({
        id: String(task.id ?? `webtop-hw-${student.studentId}-${task.studyGroupId ?? idx}-${task.hourNum ?? idx}`),
        kid: student.displayName,
        studentId: student.studentId,
        subject,
        itemType: "homework",
        title: hwText,
        details: detailsParts.length > 0 ? detailsParts.join(" | ") : undefined,
        dueDate: task.dueDate || task.date ? String(task.dueDate ?? task.date) : undefined,
        assignedDate: task.lessonDate ? String(task.lessonDate) : now.toISOString(),
        source: "webtop",
      });
      continue;
    }

    const rawType = String(task.taskType ?? "homework").toLowerCase();
    const itemType: "homework" | "exam" | "notice" =
      rawType === "exam" || rawType === "notice" ? rawType : "homework";
    const subject = String(task.subject ?? task.subjectName ?? "כללי").trim();
    const title = String(task.title ?? task.name ?? "משימה").trim();
    const details = task.description ?? task.details;
    const dueVal = task.dueDate ?? task.date;

    items.push({
      id: String(task.id ?? `webtop-${student.studentId}-${idx}`),
      kid: student.displayName,
      studentId: student.studentId,
      subject,
      itemType,
      title,
      details: details ? String(details) : undefined,
      dueDate: dueVal ? String(dueVal) : undefined,
      source: "webtop",
    });
  }
  return items;
}

function extractWebtopDisciplineEvents(rawData: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rawData)) {
    return rawData as Array<Record<string, unknown>>;
  }
  if (!rawData || typeof rawData !== "object") {
    return [];
  }
  const obj = rawData as Record<string, unknown>;
  const dt = obj.dataTable;
  if (Array.isArray(dt)) {
    return dt as Array<Record<string, unknown>>;
  }
  if (dt && typeof dt === "object") {
    const dtObj = dt as Record<string, unknown>;
    if (Array.isArray(dtObj.diciplineEvents)) {
      return dtObj.diciplineEvents as Array<Record<string, unknown>>;
    }
    if (Array.isArray(dtObj.disciplineEvents)) {
      return dtObj.disciplineEvents as Array<Record<string, unknown>>;
    }
  }
  if (Array.isArray(obj.diciplineEvents)) {
    return obj.diciplineEvents as Array<Record<string, unknown>>;
  }
  if (Array.isArray(obj.disciplineEvents)) {
    return obj.disciplineEvents as Array<Record<string, unknown>>;
  }
  return [];
}

export function normalizeWebtopBehave(
  student: DiscoveredStudent,
  rawEvents: Array<Record<string, unknown>> | null | undefined
): BehaviorEvent[] {
  const events: BehaviorEvent[] = [];
  for (let idx = 0; idx < (rawEvents ?? []).length; idx += 1) {
    const ev = rawEvents![idx];
    const eventDate = String(ev.eventDate ?? ev.date ?? new Date().toISOString());
    const title = String(ev.eventType ?? ev.title ?? "אירוע התנהגות").trim();
    const subject = ev.subjectName ?? ev.subject;
    const teacher = ev.teacherName;
    const remark = ev.remark ?? ev.justifiedReason;
    const details = remark ? String(remark).trim() : undefined;
    const justified =
      ev.isJustified === null || ev.isJustified === undefined ? null : Boolean(ev.isJustified);
    const evId = String(ev.eventID ?? ev.id ?? `${idx}-${eventDate.slice(0, 10)}`);

    events.push({
      id: `webtop-beh-${student.studentId}-${evId}`,
      kid: student.displayName,
      studentId: student.studentId,
      eventDate,
      category: classifyBehaviorCategory(title, details),
      title,
      subject: subject ? String(subject) : undefined,
      teacher: teacher ? String(teacher) : undefined,
      details,
      justified,
      source: "behave_api",
    });
  }
  events.sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  return events;
}

export function normalizeWebtopSchedule(
  rawData: unknown
): Record<number, ScheduleLesson[]> {
  const byDay: Record<number, ScheduleLesson[]> = {};
  if (!rawData) return byDay;

  const entries: Array<Record<string, unknown>> = Array.isArray(rawData)
    ? (rawData as Array<Record<string, unknown>>)
    : Array.isArray((rawData as Record<string, unknown>).schedule)
      ? ((rawData as Record<string, unknown>).schedule as Array<Record<string, unknown>>)
      : Array.isArray((rawData as Record<string, unknown>).hours)
        ? ((rawData as Record<string, unknown>).hours as Array<Record<string, unknown>>)
        : [];

  for (const row of entries) {
    // Nested Webtop GetPupilScheduale shape: { dayIndex, hoursData: [{ hour, scheduale: [{ day, hour, subject, teacherPrivateName, teacherLastName, room }] }] }
    if (Array.isArray(row.hoursData)) {
      const parentDay = Number(row.dayIndex ?? 0);
      for (const hObj of row.hoursData as Array<Record<string, unknown>>) {
        const parentHour = Number(hObj.hour ?? hObj.hourNum ?? 0);
        const schedItems = Array.isArray(hObj.scheduale)
          ? (hObj.scheduale as Array<Record<string, unknown>>)
          : Array.isArray(hObj.schedule)
            ? (hObj.schedule as Array<Record<string, unknown>>)
            : [];
        for (const item of schedItems) {
          const day = Number(item.day ?? parentDay);
          const lesson = Number(item.hour ?? parentHour);
          const subject = String(item.subject ?? item.lessonName ?? item.subjectName ?? "").trim();
          if (!day || !lesson || !subject) continue;
          const room = item.room ?? item.classRoom ? String(item.room ?? item.classRoom) : undefined;
          const fullTeacher = [item.teacherPrivateName, item.teacherLastName]
            .map((p) => (p ? String(p).trim() : ""))
            .filter(Boolean)
            .join(" ");
          const teacher =
            fullTeacher ||
            (item.teacher ?? item.teacherName ? String(item.teacher ?? item.teacherName) : undefined);
          if (!byDay[day]) byDay[day] = [];
          byDay[day].push({ lesson, subject, room, teacher });
        }
      }
      continue;
    }

    // Flat entry fallback shape
    const day = Number(row.day ?? row.dayOfWeek ?? row.dayNum ?? 0);
    const lesson = Number(row.hour ?? row.hourNum ?? row.lesson ?? row.lessonNum ?? 0);
    const subject = String(row.subject ?? row.lessonName ?? row.subjectName ?? "").trim();
    if (!day || !lesson || !subject) continue;
    const room = row.room ?? row.classRoom ? String(row.room ?? row.classRoom) : undefined;
    const teacher = row.teacher ?? row.teacherName ? String(row.teacher ?? row.teacherName) : undefined;
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ lesson, subject, room, teacher });
  }
  for (const day of Object.keys(byDay)) {
    byDay[Number(day)].sort((a, b) => a.lesson - b.lesson);
  }
  return byDay;
}

export class WebtopClient {
  private readonly account: AccountConfig;
  private readonly sessionStore: SchoolSessionStore;
  private readonly attachmentsDir: string;
  private readonly schoolYear?: number;
  private readonly downloadAttachments: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(opts: {
    account: AccountConfig;
    sessionStore: SchoolSessionStore;
    attachmentsDir: string;
    schoolYear?: number;
    downloadAttachments?: boolean;
    fetchImpl?: FetchLike;
  }) {
    this.account = opts.account;
    this.sessionStore = opts.sessionStore;
    this.attachmentsDir = opts.attachmentsDir;
    this.schoolYear = opts.schoolYear;
    this.downloadAttachments = opts.downloadAttachments ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get accountKey(): string {
    return this.account.username;
  }

  private defaultHeaders(session?: SchoolSession): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": DEFAULT_UA,
      Origin: WEBTOP_ORIGIN,
      Referer: `${WEBTOP_ORIGIN}/`,
    };
    if (session?.webToken) {
      headers.Cookie = `webToken=${session.webToken}`;
    }
    return headers;
  }

  async login(now: Date = new Date()): Promise<SchoolSession> {
    if (!this.sessionStore.canAttemptLogin("webtop", this.accountKey, undefined, now.getTime())) {
      throw new Error(`Webtop login cooldown active for ${this.accountKey}`);
    }

    const payload = {
      UserName: this.account.username,
      Password: this.account.password,
      Data: encryptWebtopPayload(this.account.username),
      RememberMe: false,
      BiometricLogin: "",
    };

    try {
      const loginResp = await this.fetchImpl(`${WEBTOP_BASE}/api/user/LoginByUserNameAndPassword`, {
        method: "POST",
        headers: this.defaultHeaders(),
        body: JSON.stringify(payload),
      });

      if (!loginResp.ok) {
        this.sessionStore.recordLoginFailure("webtop", this.accountKey, now.getTime());
        throw new Error(`Webtop login failed with HTTP ${loginResp.status}`);
      }

      const loginJson = (await loginResp.json()) as Record<string, unknown>;
      if (!loginJson.status) {
        this.sessionStore.recordLoginFailure("webtop", this.accountKey, now.getTime());
        throw new Error(String(loginJson.errorDescription ?? "Webtop login rejected"));
      }

      const loginData = (loginJson.data as Record<string, unknown>) ?? {};
      const token = String(loginData.token ?? "");
      if (!token) {
        this.sessionStore.recordLoginFailure("webtop", this.accountKey, now.getTime());
        throw new Error("Webtop login response missing token");
      }

      let children: Array<Record<string, unknown>> = [];
      const initResp = await this.fetchImpl(`${WEBTOP_BASE}/api/dashboard/InitDashboard`, {
        method: "POST",
        headers: {
          ...this.defaultHeaders(),
          Cookie: `webToken=${token}`,
        },
        body: "{}",
      });

      if (initResp.ok) {
        const initJson = (await initResp.json()) as Record<string, unknown>;
        const initData = (initJson.data as Record<string, unknown>) ?? {};
        if (Array.isArray(initData.childrens)) {
          children = initData.childrens as Array<Record<string, unknown>>;
        }
      }

      // Single-student account fallback
      if (children.length === 0 && (loginData.studentId || loginData.id)) {
        children = [
          {
            id: loginData.studentId ?? loginData.id,
            firstName: loginData.firstName ?? this.account.label ?? this.account.username,
            lastName: loginData.lastName ?? "",
            classCode: loginData.classCode ?? 0,
            classNum: loginData.classNumber ?? loginData.classNum ?? 0,
          },
        ];
      }

      const session: SchoolSession = {
        providerType: "webtop",
        accountKey: this.accountKey,
        webToken: token,
        cookies: { webToken: token },
        childMetadata: { children },
        lastLoginTs: now.getTime(),
        expiresAt: now.getTime() + 12 * 3600 * 1000,
        consecutiveFailures: 0,
        lastFailureTs: 0,
      };
      this.sessionStore.saveSession("webtop", this.accountKey, session, now.getTime());
      this.sessionStore.recordLoginSuccess("webtop", this.accountKey);
      return session;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.startsWith("Webtop login failed") ||
          err.message.includes("missing token") ||
          err.message.includes("rejected"))
      ) {
        throw err;
      }
      this.sessionStore.recordLoginFailure("webtop", this.accountKey, now.getTime());
      throw err;
    }
  }

  async getValidSession(now: Date = new Date()): Promise<SchoolSession> {
    const existing = this.sessionStore.getSession("webtop", this.accountKey);
    if (existing && isSessionValid(existing, now.getTime())) {
      return existing;
    }
    return this.login(now);
  }

  private async isAuthFailure(resp: Response): Promise<{ failed: boolean; json?: Record<string, unknown> }> {
    if (resp.status === 401 || resp.status === 403) {
      return { failed: true };
    }
    if (resp.ok) {
      try {
        const json = (await resp.json()) as Record<string, unknown>;
        if (json.status === false) {
          return { failed: true, json };
        }
        return { failed: false, json };
      } catch {
        return { failed: false };
      }
    }
    return { failed: false };
  }

  private async authedPost(
    apiPath: string,
    bodyObj: unknown,
    session: SchoolSession,
    now: Date = new Date()
  ): Promise<{ resp: Response; json?: Record<string, unknown>; session: SchoolSession }> {
    let resp = await this.fetchImpl(`${WEBTOP_BASE}${apiPath}`, {
      method: "POST",
      headers: this.defaultHeaders(session),
      body: JSON.stringify(bodyObj),
    });

    const check = await this.isAuthFailure(resp);
    if (check.failed) {
      this.sessionStore.invalidateSession("webtop", this.accountKey);
      const newSession = await this.login(now);
      resp = await this.fetchImpl(`${WEBTOP_BASE}${apiPath}`, {
        method: "POST",
        headers: this.defaultHeaders(newSession),
        body: JSON.stringify(bodyObj),
      });
      const retryCheck = await this.isAuthFailure(resp);
      return { resp, json: retryCheck.json, session: newSession };
    }

    return { resp, json: check.json, session };
  }

  discoverStudentsFromSession(session: SchoolSession): DiscoveredStudent[] {
    const rawChildren = Array.isArray(session.childMetadata?.children)
      ? (session.childMetadata.children as Array<Record<string, unknown>>)
      : [];

    return rawChildren.map((ch, idx) => {
      const id = String(ch.id ?? `webtop-child-${idx}`);
      const firstName = String(ch.firstName ?? `Student ${idx + 1}`).trim();
      const lastName = String(ch.lastName ?? "").trim();
      const override = matchOverride(ch, this.account.students);
      const displayName = override?.displayName?.trim() || firstName;
      const aliases = Array.from(
        new Set(
          [displayName, firstName, `${firstName} ${lastName}`.trim(), ...(override?.aliases ?? [])]
            .map((s) => s.trim())
            .filter(Boolean)
        )
      );

      return {
        studentId: id,
        accountId: this.account.id,
        system: "webtop",
        displayName,
        firstName,
        lastName,
        aliases,
        grade: override?.grade,
        classNumber:
          override?.classNumber ??
          (ch.classNum !== undefined || ch.classNumber !== undefined
            ? Number(ch.classNum ?? ch.classNumber)
            : undefined),
        tracks: override?.tracks ?? [],
        examIcalUrl: override?.examIcalUrl,
        fallbackTimetable: override?.fallbackTimetable,
        rawMetadata: ch,
      };
    });
  }

  async fetchAll(now: Date = new Date()): Promise<AccountFetchResult> {
    let session = await this.getValidSession(now);
    const students = this.discoverStudentsFromSession(session);
    const academicYear = computeAcademicYear(now, this.schoolYear);

    const timetables: Record<string, Record<number, ScheduleLesson[]>> = {};
    const homework: SchoolItem[] = [];
    const behaviorEvents: BehaviorEvent[] = [];

    for (const student of students) {
      const rawMeta = student.rawMetadata ?? {};
      const cid = String(rawMeta.id ?? student.studentId);
      const classCode = Number(rawMeta.classCode ?? 0);
      const classNumber = Number(rawMeta.classNum ?? rawMeta.classNumber ?? 0);

      // Homework
      if (cid && (classCode || classNumber)) {
        const hwRes = await this.authedPost(
          "/api/dashboard/GetHomeWork",
          { id: cid, ClassCode: classCode, ClassNumber: classNumber },
          session,
          now
        );
        session = hwRes.session;
        if (hwRes.json && hwRes.json.status !== false) {
          const hwData = hwRes.json.data;
          const rawTasks = Array.isArray(hwData)
            ? (hwData as Array<Record<string, unknown>>)
            : hwData && typeof hwData === "object"
              ? ((hwData as Record<string, unknown>).dataTable as Array<Record<string, unknown>>) ?? []
              : [];
          homework.push(...normalizeWebtopHomework(student, rawTasks, now));
        }
      }

      // Behavior
      const behRes = await this.authedPost(
        "/api/dashboard/GetPupilDiciplineEvents",
        { id: cid },
        session,
        now
      );
      session = behRes.session;
      if (behRes.json && behRes.json.status !== false) {
        const rawEvents = extractWebtopDisciplineEvents(behRes.json.data);
        behaviorEvents.push(...normalizeWebtopBehave(student, rawEvents));
      }

      // Timetable (note: disabled for some elementary Webtop schools -> graceful fallback)
      if (cid && classCode) {
        try {
          const ttRes = await this.authedPost(
            "/api/PupilCard/GetPupilScheduale",
            {
              weekIndex: 0,
              viewType: 0,
              studyYear: academicYear,
              studentID: cid,
              classCode,
              moduleID: 10,
            },
            session,
            now
          );
          session = ttRes.session;
          const parsedTt =
            ttRes.json && ttRes.json.status !== false
              ? normalizeWebtopSchedule(ttRes.json.data)
              : {};
          if (Object.keys(parsedTt).length > 0) {
            timetables[student.displayName] = parsedTt;
          } else if (student.fallbackTimetable) {
            timetables[student.displayName] = student.fallbackTimetable;
          }
        } catch {
          if (student.fallbackTimetable) {
            timetables[student.displayName] = student.fallbackTimetable;
          }
        }
      } else if (student.fallbackTimetable) {
        timetables[student.displayName] = student.fallbackTimetable;
      }
    }

    // Inbox messages
    const messages: SchoolMessage[] = [];
    const inboxRes = await this.authedPost(
      "/api/messageBox/GetMessagesInbox",
      { PageId: 1, LabelId: 0, HasRead: null, Search: "" },
      session,
      now
    );
    session = inboxRes.session;
    const rows = Array.isArray(inboxRes.json?.data)
      ? ((inboxRes.json!.data as Array<Record<string, unknown>>).slice(0, 20))
      : [];

    const defaultKid = students.length === 1 ? students[0].displayName : "משותף";
    const defaultStudentId = students.length === 1 ? students[0].studentId : undefined;

    for (const row of rows) {
      const mid = row.messageId;
      if (!mid) continue;
      const detRes = await this.authedPost(
        "/api/messageBox/GetMessagesInboxData",
        { messageId: mid },
        session,
        now
      );
      session = detRes.session;
      if (!detRes.json || detRes.json.status === false) continue;

      const detData = (detRes.json.data as Record<string, unknown>) ?? {};
      const md = (detData.messageData as Record<string, unknown>) ?? {};
      const sentAt = String(md.sendingDate ?? row.sendingDate ?? now.toISOString());
      const firstSender = md.privateName ?? row.student_F_name ?? "";
      const lastSender = md.lastName ?? row.student_L_name ?? "";
      const sender = `${firstSender} ${lastSender}`.trim() || undefined;
      const bodyText = htmlToText(md.messageContent ? String(md.messageContent) : "");
      const subject = String(md.subject ?? row.subject ?? "הודעה").trim();

      let kid = defaultKid;
      let studentId = defaultStudentId;
      if (students.length > 1) {
        const blob = `${subject}\n${bodyText}`;
        const matched = students.find(
          (st) => blob.includes(st.firstName) || blob.includes(st.displayName)
        );
        if (matched) {
          kid = matched.displayName;
          studentId = matched.studentId;
        }
      }

      const attachments: MessageAttachment[] = [];
      const filesList = Array.isArray(md.filesList)
        ? (md.filesList as Array<Record<string, unknown>>)
        : [];
      for (const f of filesList) {
        const fname = String(f.fileName ?? `file_${f.id ?? "0"}`);
        const fkey = String(f.fileKey ?? "");
        const attUid = crypto.createHash("sha1").update(fkey || fname).digest("hex").slice(0, 12);
        const localFile = path.join(this.attachmentsDir, "webtop", safeFilename(`${attUid}_${fname}`));
        let sizeBytes = fs.existsSync(localFile) ? fs.statSync(localFile).size : 0;

        if (this.downloadAttachments && fkey && !fs.existsSync(localFile)) {
          const dlRes = await this.fetchImpl(
            `${WEBTOP_BASE}/api/stream/GetFile?token=${encodeURIComponent(fkey)}`,
            {
              method: "GET",
              headers: this.defaultHeaders(session),
            }
          );
          if (dlRes.ok) {
            const buf = Buffer.from(await dlRes.arrayBuffer());
            if (buf.length <= 12 * 1024 * 1024) {
              fs.mkdirSync(path.dirname(localFile), { recursive: true });
              fs.writeFileSync(localFile, buf);
              sizeBytes = buf.length;
            }
          }
        }

        const extracted = fs.existsSync(localFile)
          ? await extractAttachmentText(localFile)
          : { isImage: /\.(png|jpe?g|webp|gif)$/i.test(fname) };

        attachments.push({
          id: `webtop-${attUid}`,
          filename: fname,
          sizeBytes,
          localPath: fs.existsSync(localFile) ? localFile : undefined,
          extractedText: extracted.extractedText,
          isImage: extracted.isImage,
        });
      }

      const msgObj: SchoolMessage = {
        id: `webtop-msg-${mid}`,
        kid,
        studentId,
        sender,
        subject,
        bodyText,
        sentAt,
        categories: [],
        attachments,
        source: "webtop",
      };
      msgObj.categories = classifyMessageCategories(msgObj);
      messages.push(msgObj);
    }

    messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return { students, timetables, homework, exams: [], behaviorEvents, messages };
  }
}
