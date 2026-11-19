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

export type FetchLike = typeof fetch;

export interface MashovSchoolEntry {
  semel: number;
  name: string;
  city?: string;
}

const MASHOV_BASE = "https://web.mashov.info";
const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

export function computeAcademicYear(now: Date = new Date(), overrideYear?: number): number {
  if (overrideYear && overrideYear > 2000) return overrideYear;
  return now.getUTCMonth() + 1 >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._\-\u0590-\u05FF]/g, "_");
  return base.slice(0, 120) || "attachment";
}

function parseCookiesFromHeaders(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const rawList =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie") as string]
        : [];

  for (const raw of rawList) {
    const firstPart = raw.split(";")[0]?.trim();
    if (!firstPart) continue;
    const eq = firstPart.indexOf("=");
    if (eq <= 0) continue;
    const name = firstPart.slice(0, eq).trim();
    const val = firstPart.slice(eq + 1).trim();
    if (name) cookies[name] = val;
  }
  return cookies;
}

function formatCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function matchOverride(
  rawChild: Record<string, unknown>,
  overrides: StudentOverrideConfig[] | undefined
): StudentOverrideConfig | undefined {
  if (!overrides || overrides.length === 0) return undefined;
  const guid = String(rawChild.childGuid ?? "");
  const first = String(rawChild.privateName ?? "").trim();
  const last = String(rawChild.familyName ?? "").trim();
  const full = `${first} ${last}`.trim();

  return overrides.find((ov) => {
    const m = ov.match.trim().toLowerCase();
    return (
      (guid && guid.toLowerCase() === m) ||
      (first && first.toLowerCase() === m) ||
      (full && full.toLowerCase() === m) ||
      (first && m.includes(first.toLowerCase()))
    );
  });
}

export async function searchMashovSchools(
  query: string,
  fetchImpl: FetchLike = fetch
): Promise<MashovSchoolEntry[]> {
  const resp = await fetchImpl(`${MASHOV_BASE}/api/schools`, {
    headers: { Accept: "application/json, text/plain, */*", "User-Agent": DEFAULT_UA },
  });
  if (!resp.ok) {
    throw new Error(`Mashov schools lookup failed with HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) return [];
  const q = query.trim().toLowerCase();
  const matches: MashovSchoolEntry[] = [];
  for (const row of data) {
    const semel = Number(row.semel ?? row.schoolId ?? 0);
    const name = String(row.name ?? row.schoolName ?? "").trim();
    const city = String(row.city ?? row.town ?? "").trim() || undefined;
    if (!semel || !name) continue;
    if (!q || name.toLowerCase().includes(q) || (city && city.toLowerCase().includes(q)) || String(semel) === q) {
      matches.push({ semel, name, city });
    }
    if (matches.length >= 25) break;
  }
  return matches;
}

export function normalizeMashovTimetable(
  rawTimetable: Array<Record<string, unknown>> | null | undefined
): Record<number, ScheduleLesson[]> {
  const byDay: Record<number, ScheduleLesson[]> = {};
  for (const entry of rawTimetable ?? []) {
    const tInfo = (entry.timeTable as Record<string, unknown>) ?? {};
    const gInfo = (entry.groupDetails as Record<string, unknown>) ?? {};
    const day = Number(tInfo.day ?? 0);
    const lessonNum = Number(tInfo.lesson ?? 0);
    if (!day || !lessonNum) continue;

    const subject = String(gInfo.subjectName ?? gInfo.groupName ?? "שיעור").trim();
    const teachers = Array.isArray(gInfo.groupTeachers)
      ? (gInfo.groupTeachers as Array<Record<string, unknown>>)
      : [];
    const teacher = teachers[0]?.teacherName ? String(teachers[0].teacherName) : undefined;
    const room = tInfo.room ? String(tInfo.room) : undefined;

    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ lesson: lessonNum, subject, room, teacher });
  }
  for (const day of Object.keys(byDay)) {
    byDay[Number(day)].sort((a, b) => a.lesson - b.lesson);
  }
  return byDay;
}

export function normalizeMashovHomework(
  student: DiscoveredStudent,
  rawHomework: Array<Record<string, unknown>> | null | undefined
): SchoolItem[] {
  const items: SchoolItem[] = [];
  for (let idx = 0; idx < (rawHomework ?? []).length; idx += 1) {
    const hw = rawHomework![idx];
    const subject = String(hw.subject ?? hw.subjectName ?? "כללי").trim();
    const title = String(hw.homework ?? hw.title ?? hw.remark ?? "מטלת שיעורי בית").trim();
    const details = hw.remark && hw.remark !== title ? String(hw.remark) : undefined;
    const dueDate = hw.dueDate ? String(hw.dueDate) : undefined;
    const assignedDate = hw.lessonDate ? String(hw.lessonDate) : undefined;
    const id = String(hw.homeworkId ?? hw.id ?? `mashov-hw-${student.studentId}-${idx}`);

    items.push({
      id,
      kid: student.displayName,
      studentId: student.studentId,
      subject,
      itemType: "homework",
      title,
      details,
      dueDate,
      assignedDate,
      source: "mashov",
    });
  }
  return items;
}

export function normalizeMashovExams(
  student: DiscoveredStudent,
  rawExams: Array<Record<string, unknown>> | null | undefined
): SchoolItem[] {
  const items: SchoolItem[] = [];
  for (let idx = 0; idx < (rawExams ?? []).length; idx += 1) {
    const ex = rawExams![idx];
    const subject = String(ex.subject ?? ex.subjectName ?? "כללי").trim();
    const title = String(ex.name ?? ex.title ?? `מבחן ב${subject}`).trim();
    const detailsRaw = ex.details ?? ex.topics ?? ex.remark;
    const details = detailsRaw ? String(detailsRaw) : undefined;
    const dueDate = ex.examDate ?? ex.date ?? ex.dueDate;
    const id = String(ex.examId ?? ex.id ?? `mashov-exam-${student.studentId}-${idx}`);
    items.push({
      id,
      kid: student.displayName,
      studentId: student.studentId,
      subject,
      itemType: "exam",
      title,
      details,
      dueDate: dueDate ? String(dueDate) : undefined,
      source: "mashov",
    });
  }
  return items;
}

export function normalizeMashovBehave(
  student: DiscoveredStudent,
  rawBehave: Array<Record<string, unknown>> | null | undefined
): BehaviorEvent[] {
  const events: BehaviorEvent[] = [];
  for (let idx = 0; idx < (rawBehave ?? []).length; idx += 1) {
    const ev = rawBehave![idx];
    const eventDate = String(ev.timestamp ?? ev.lessonDate ?? new Date().toISOString());
    const title = String(ev.achvaName ?? ev.eventName ?? "אירוע התנהגות").trim();
    const subject = ev.subject ?? ev.subjectName;
    const teacher = ev.reporter ?? ev.teacherName;
    const just = ev.justification ? String(ev.justification).trim() : "";
    const details = just && just !== "ללא הערות" ? just : undefined;
    const justifiedRaw = ev.justified;
    const justified =
      justifiedRaw === null || justifiedRaw === undefined || justifiedRaw === -1
        ? null
        : Boolean(justifiedRaw);
    const evId = `${ev.lessonId ?? ev.eventId ?? idx}-${ev.eventCode ?? ""}-${eventDate.slice(0, 19)}`;

    events.push({
      id: `mashov-beh-${student.studentId}-${evId}`,
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

export interface AccountFetchResult {
  students: DiscoveredStudent[];
  timetables: Record<string, Record<number, ScheduleLesson[]>>;
  homework: SchoolItem[];
  exams: SchoolItem[];
  behaviorEvents: BehaviorEvent[];
  messages: SchoolMessage[];
}

export class MashovClient {
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
    return `${this.account.semel ?? 0}:${this.account.username}`;
  }

  private authHeaders(session: SchoolSession): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": DEFAULT_UA,
    };
    if (session.csrfToken) {
      headers["X-Csrf-Token"] = session.csrfToken;
    }
    const cookieStr = formatCookieHeader(session.cookies);
    if (cookieStr) {
      headers.Cookie = cookieStr;
    }
    return headers;
  }

  async login(now: Date = new Date()): Promise<SchoolSession> {
    if (!this.account.semel) {
      throw new Error(`Mashov account ${this.account.id} is missing semel (school code)`);
    }
    if (!this.sessionStore.canAttemptLogin("mashov", this.accountKey, undefined, now.getTime())) {
      throw new Error(`Mashov login cooldown active for ${this.accountKey}`);
    }

    const academicYear = computeAcademicYear(now, this.schoolYear);
    const payload = {
      semel: Number(this.account.semel),
      year: academicYear,
      username: this.account.username,
      password: this.account.password,
      IsBiometric: false,
      appName: "info.mashov.students",
      apiVersion: "4.20250101",
      appVersion: "4.20250101",
      appBuild: "4.20250101",
      deviceUuid: "il-school-mcp",
      devicePlatform: "chrome",
      deviceManufacturer: "desktop",
      deviceModel: "mcp-client",
      deviceVersion: "0.1.0",
    };

    try {
      const resp = await this.fetchImpl(`${MASHOV_BASE}/api/login`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: MASHOV_BASE,
          Referer: `${MASHOV_BASE}/students/login`,
          "User-Agent": DEFAULT_UA,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        this.sessionStore.recordLoginFailure("mashov", this.accountKey, now.getTime());
        throw new Error(`Mashov login failed with HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as Record<string, unknown>;
      const cookies = parseCookiesFromHeaders(resp.headers);
      const csrfToken =
        resp.headers.get("x-csrf-token") ||
        resp.headers.get("X-Csrf-Token") ||
        cookies["Csrf-Token"] ||
        "";

      const accessToken = (data.accessToken as Record<string, unknown>) ?? {};
      const children = Array.isArray(accessToken.children)
        ? (accessToken.children as Array<Record<string, unknown>>)
        : [];

      const session: SchoolSession = {
        providerType: "mashov",
        accountKey: this.accountKey,
        csrfToken,
        cookies,
        childMetadata: { children },
        lastLoginTs: now.getTime(),
        expiresAt: now.getTime() + 12 * 3600 * 1000,
        consecutiveFailures: 0,
        lastFailureTs: 0,
      };
      this.sessionStore.saveSession("mashov", this.accountKey, session, now.getTime());
      this.sessionStore.recordLoginSuccess("mashov", this.accountKey);
      return session;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Mashov login failed with HTTP")) {
        throw err;
      }
      this.sessionStore.recordLoginFailure("mashov", this.accountKey, now.getTime());
      throw err;
    }
  }

  async getValidSession(now: Date = new Date()): Promise<SchoolSession> {
    const existing = this.sessionStore.getSession("mashov", this.accountKey);
    if (existing && isSessionValid(existing, now.getTime())) {
      return existing;
    }
    return this.login(now);
  }

  private async authedGet(
    url: string,
    session: SchoolSession,
    now: Date = new Date()
  ): Promise<{ resp: Response; session: SchoolSession }> {
    let resp = await this.fetchImpl(url, {
      method: "GET",
      headers: this.authHeaders(session),
    });

    if (resp.status === 401 || resp.status === 403) {
      this.sessionStore.invalidateSession("mashov", this.accountKey);
      const newSession = await this.login(now);
      resp = await this.fetchImpl(url, {
        method: "GET",
        headers: this.authHeaders(newSession),
      });
      return { resp, session: newSession };
    }
    return { resp, session };
  }

  discoverStudentsFromSession(session: SchoolSession): DiscoveredStudent[] {
    const rawChildren = Array.isArray(session.childMetadata?.children)
      ? (session.childMetadata.children as Array<Record<string, unknown>>)
      : [];

    return rawChildren.map((ch, idx) => {
      const guid = String(ch.childGuid ?? `child-${idx}`);
      const firstName = String(ch.privateName ?? `Child ${idx + 1}`).trim();
      const lastName = String(ch.familyName ?? "").trim();
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
        studentId: guid,
        accountId: this.account.id,
        system: "mashov",
        displayName,
        firstName,
        lastName,
        aliases,
        grade: override?.grade ?? (ch.grade ? String(ch.grade) : undefined),
        classNumber: override?.classNumber ?? (ch.classNum ? Number(ch.classNum) : undefined),
        semel: this.account.semel,
        tracks: override?.tracks ?? [],
        examIcalUrl: override?.examIcalUrl,
        fallbackTimetable: override?.fallbackTimetable,
        rawMetadata: ch,
      };
    });
  }

  private inferKidForMessage(
    msgJson: Record<string, unknown>,
    students: DiscoveredStudent[],
    rawChildren: Array<Record<string, unknown>>
  ): { kid: string; studentId?: string } {
    const groupToStudent = new Map<string, DiscoveredStudent>();
    for (let i = 0; i < rawChildren.length; i += 1) {
      const ch = rawChildren[i];
      const st = students[i];
      if (!st) continue;
      for (const gid of Array.isArray(ch.groups) ? ch.groups : []) {
        groupToStudent.set(String(gid), st);
      }
    }

    for (const r of Array.isArray(msgJson.recipients) ? (msgJson.recipients as Array<Record<string, unknown>>) : []) {
      const st = groupToStudent.get(String(r.groupId ?? ""));
      if (st) return { kid: st.displayName, studentId: st.studentId };
    }

    const blob = `${msgJson.subject ?? ""} ${htmlToText(String(msgJson.body ?? ""))}`;
    for (const st of students) {
      if (blob.includes(st.firstName) || blob.includes(st.displayName)) {
        return { kid: st.displayName, studentId: st.studentId };
      }
    }

    if (students.length === 1) {
      return { kid: students[0].displayName, studentId: students[0].studentId };
    }
    return { kid: "משותף" };
  }

  async fetchAll(now: Date = new Date()): Promise<AccountFetchResult> {
    let session = await this.getValidSession(now);
    const students = this.discoverStudentsFromSession(session);
    const rawChildren = Array.isArray(session.childMetadata?.children)
      ? (session.childMetadata.children as Array<Record<string, unknown>>)
      : [];

    const academicYear = computeAcademicYear(now, this.schoolYear);
    const fromDate = new Date(now.getTime() - 21 * 24 * 3600 * 1000).toISOString().slice(0, 10) + "T00:00:00";
    const toDate = new Date(now.getTime() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10) + "T23:59:59";

    const timetables: Record<string, Record<number, ScheduleLesson[]>> = {};
    const homework: SchoolItem[] = [];
    const exams: SchoolItem[] = [];
    const behaviorEvents: BehaviorEvent[] = [];

    for (const student of students) {
      const guid = student.studentId;

      // Timetable
      const ttRes = await this.authedGet(`${MASHOV_BASE}/api/students/${guid}/timetable`, session, now);
      session = ttRes.session;
      if (ttRes.resp.ok) {
        const rawTt = (await ttRes.resp.json()) as Array<Record<string, unknown>>;
        timetables[student.displayName] = normalizeMashovTimetable(Array.isArray(rawTt) ? rawTt : []);
      } else if (student.fallbackTimetable) {
        timetables[student.displayName] = student.fallbackTimetable;
      }

      // Homework
      const hwUrl = `${MASHOV_BASE}/api/students/${guid}/homework?from=${fromDate}&to=${toDate}&year=${academicYear}`;
      const hwRes = await this.authedGet(hwUrl, session, now);
      session = hwRes.session;
      if (hwRes.resp.ok) {
        const rawHw = (await hwRes.resp.json()) as Array<Record<string, unknown>>;
        homework.push(...normalizeMashovHomework(student, Array.isArray(rawHw) ? rawHw : []));
      }

      // Exams
      const exRes = await this.authedGet(`${MASHOV_BASE}/api/students/${guid}/exams`, session, now);
      session = exRes.session;
      if (exRes.resp.ok) {
        const rawEx = (await exRes.resp.json()) as Array<Record<string, unknown>>;
        exams.push(...normalizeMashovExams(student, Array.isArray(rawEx) ? rawEx : []));
      }

      // Behavior
      const behRes = await this.authedGet(`${MASHOV_BASE}/api/students/${guid}/behave`, session, now);
      session = behRes.session;
      if (behRes.resp.ok) {
        const rawBeh = (await behRes.resp.json()) as Array<Record<string, unknown>>;
        behaviorEvents.push(...normalizeMashovBehave(student, Array.isArray(rawBeh) ? rawBeh : []));
      }
    }

    // Shared inbox messages
    const messages: SchoolMessage[] = [];
    const inboxRes = await this.authedGet(`${MASHOV_BASE}/api/mail/inbox/conversations`, session, now);
    session = inboxRes.session;
    if (inboxRes.resp.ok) {
      const convs = (await inboxRes.resp.json()) as Array<Record<string, unknown>>;
      for (const conv of (Array.isArray(convs) ? convs : []).slice(0, 20)) {
        const convMsgs = Array.isArray(conv.messages) ? (conv.messages as Array<Record<string, unknown>>) : [];
        const latest = convMsgs[convMsgs.length - 1];
        const mid = latest?.messageId;
        if (!mid) continue;

        const detRes = await this.authedGet(`${MASHOV_BASE}/api/mail/messages/${mid}`, session, now);
        session = detRes.session;
        if (!detRes.resp.ok) continue;

        const mj = (await detRes.resp.json()) as Record<string, unknown>;
        const sentAt = String(mj.sendTime ?? conv.sendTime ?? now.toISOString());
        const bodyText = htmlToText(mj.body ? String(mj.body) : "");
        const { kid, studentId } = this.inferKidForMessage(mj, students, rawChildren);

        const attachments: MessageAttachment[] = [];
        const files = Array.isArray(mj.files) ? (mj.files as Array<Record<string, unknown>>) : [];
        for (const f of files) {
          const fid = String(f.fileId ?? "");
          const fname = String(f.fileName ?? `file_${fid}`);
          if (!fid) continue;
          const localFile = path.join(this.attachmentsDir, "mashov", safeFilename(`${fid}_${fname}`));
          let sizeBytes = fs.existsSync(localFile) ? fs.statSync(localFile).size : 0;

          if (this.downloadAttachments && !fs.existsSync(localFile)) {
            const dlUrl = `${MASHOV_BASE}/api/mail/messages/${mid}/files/${fid}/download/${encodeURIComponent(fname)}`;
            const dlRes = await this.authedGet(dlUrl, session, now);
            session = dlRes.session;
            if (dlRes.resp.ok) {
              const buf = Buffer.from(await dlRes.resp.arrayBuffer());
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
            id: `mashov-${fid}`,
            filename: fname,
            sizeBytes,
            localPath: fs.existsSync(localFile) ? localFile : undefined,
            extractedText: extracted.extractedText,
            isImage: extracted.isImage,
          });
        }

        const msgObj: SchoolMessage = {
          id: `mashov-msg-${mid}`,
          kid,
          studentId,
          sender: mj.senderName ? String(mj.senderName).trim() : undefined,
          subject: String(mj.subject ?? conv.subject ?? "הודעה").trim(),
          bodyText,
          sentAt,
          categories: [],
          attachments,
          source: "mashov",
        };
        msgObj.categories = classifyMessageCategories(msgObj);
        messages.push(msgObj);
      }
    }

    messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return { students, timetables, homework, exams, behaviorEvents, messages };
  }
}
