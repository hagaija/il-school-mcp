import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import mammoth from "mammoth";
import type {
  BehaviorEvent,
  ExamWithMaterial,
  ScheduleLesson,
  SchoolItem,
  SchoolMessage,
} from "./types.js";

// Lazy require compatible with both ESM (tsc) and CJS (esbuild bundle)
function loadPdfParse(): (dataBuffer: Buffer) => Promise<{ text?: string }> {
  const req =
    typeof require === "function" ? require : createRequire(import.meta.url);
  return req("pdf-parse/lib/pdf-parse.js") as (
    dataBuffer: Buffer
  ) => Promise<{ text?: string }>;
}

export const HEBREW_DAY_NAMES: Record<number, string> = {
  1: "ראשון",
  2: "שני",
  3: "שלישי",
  4: "רביעי",
  5: "חמישי",
  6: "שישי",
  7: "שבת",
};

const DAY_ALIAS_TO_NUM: Record<string, number> = {
  "1": 1,
  "ראשון": 1,
  "יום ראשון": 1,
  "א": 1,
  "א'": 1,
  sunday: 1,
  sun: 1,
  "2": 2,
  "שני": 2,
  "יום שני": 2,
  "ב": 2,
  "ב'": 2,
  monday: 2,
  mon: 2,
  "3": 3,
  "שלישי": 3,
  "יום שלישי": 3,
  "ג": 3,
  "ג'": 3,
  tuesday: 3,
  tue: 3,
  tues: 3,
  "4": 4,
  "רביעי": 4,
  "יום רביעי": 4,
  "ד": 4,
  "ד'": 4,
  wednesday: 4,
  wed: 4,
  "5": 5,
  "חמישי": 5,
  "יום חמישי": 5,
  "ה": 5,
  "ה'": 5,
  thursday: 5,
  thu: 5,
  thurs: 5,
  "6": 6,
  "שישי": 6,
  "יום שישי": 6,
  "ו": 6,
  "ו'": 6,
  friday: 6,
  fri: 6,
  "7": 7,
  "שבת": 7,
  "יום שבת": 7,
  saturday: 7,
  sat: 7,
};

const SUBJECT_SYNONYMS: string[][] = [
  ["עברית", "שפה", "לשון", "לשון והבעה", "שפה ועברית", "הבעה"],
  ["מתמטיקה", "חשבון", "הנדסה", "גאומטריה", "אלגברה"],
  ["תנך", "מקרא", "תורה"],
  ["מדעים", "מדעי כדור הארץ", "פיזיקה", "ביולוגיה", "כימיה"],
  ["אנגלית", "english"],
  ["היסטוריה", "תולדות"],
  ["חנג", "חינוך גופני", "ספורט"],
  ['של"ח', "שלח", "לימודי ארץ ישראל"],
  ["מחשבים", "מדעי המחשב"],
];

const BEHAVIOR_KEYWORDS = [
  "אירוע התנהגות",
  "דיווח התנהגות",
  "התנהגות לא",
  "התנהגות טובה",
  "אירוע משמעת",
  "הפרת משמעת",
  "הערת משמעת",
  "הפרעה בשיעור",
  "הפרעה למהלך",
  "אי הכנת ש.ב",
  "אי הכנת שיעורי",
  "ציוד חסר",
  "חוסר ציוד",
  "מילה טובה",
  "הצטיינות",
  "איחור לשיעור",
  "חיסור מוצדק",
  "חיסור לא מוצדק",
  "הרחקה מהכיתה",
  "הערה ביומן",
];

const EXAM_KEYWORDS = [
  "מבחן",
  "בוחן",
  "מבדק",
  "בחינה",
  "מיפוי",
  "מועד ב",
  "עבודת הגשה",
  "מטלת חקר",
  "מטלת ביצוע",
];

const MATERIAL_KEYWORDS = [
  "חומר למבחן",
  "נושאים למבחן",
  "נושאים לבחינה",
  "נושאי המבחן",
  "חומר לבחינה",
  "הכנה למבחן",
  "דף חזרה",
  "אמצעי עזר",
  "הנחיות למבחן",
  "הוראות לביצוע",
  "מצורפים הנושאים",
  "מצורף קובץ",
  "ספר",
  "עמודים",
  "פרקים",
];

const POSITIVE_BEHAVIOR_HINTS = [
  "מילה טובה",
  "הצטיינות",
  "התנהגות טובה",
  "מעורבות פעילה",
  "נחת",
  "שבח",
  "תודה",
  "כל הכבוד",
];

const NEGATIVE_BEHAVIOR_HINTS = [
  "אי הכנת",
  "הפרעה",
  "איחור",
  "חיסור",
  "חוסר ציוד",
  "ציוד חסר",
  "התנהגות לא",
  "משמעת",
  "יציאה מהכיתה",
  "הרחקה",
  "פטפוט",
];

const ATTENDANCE_HINTS = ["חיסור", "חיסורים", "איחור", "היעדרות"];

const DATE_IN_TEXT_RE = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/;

/** Get YYYY-MM-DD, weekday (0=Sun..6=Sat), and hour in the target timezone. */
export function getZonedDateParts(
  date: Date,
  timeZone: string = "Asia/Jerusalem"
): { year: number; month: number; day: number; hour: number; hebrewDay: number; isoDate: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour) % 24;
  const weekdayMap: Record<string, number> = {
    Sun: 1,
    Mon: 2,
    Tue: 3,
    Wed: 4,
    Thu: 5,
    Fri: 6,
    Sat: 7,
  };
  const hebrewDay = weekdayMap[map.weekday] ?? 1;
  const isoDate = `${map.year}-${map.month}-${map.day}`;
  return { year, month, day, hour, hebrewDay, isoDate };
}

export function dateToHebrewDay(date: Date, timeZone: string = "Asia/Jerusalem"): number {
  return getZonedDateParts(date, timeZone).hebrewDay;
}

export function isQuietHours(
  now: Date = new Date(),
  timeZone: string = "Asia/Jerusalem",
  startHour: number = 22,
  endHour: number = 6
): boolean {
  const { hour } = getZonedDateParts(now, timeZone);
  if (startHour > endHour) {
    return hour >= startHour || hour < endHour;
  }
  return hour >= startHour && hour < endHour;
}

export function resolveDayQuery(
  dateOrDay: string | undefined,
  timeZone: string = "Asia/Jerusalem",
  now: Date = new Date()
): { mode: "week" } | { mode: "day"; dayNum: number; dayName: string; date?: string } {
  const raw = (dateOrDay ?? "today").trim().toLowerCase();
  if (raw === "week" || raw === "שבוע" || raw === "שבועי") {
    return { mode: "week" };
  }
  if (!raw || raw === "today" || raw === "היום") {
    const parts = getZonedDateParts(now, timeZone);
    return {
      mode: "day",
      dayNum: parts.hebrewDay,
      dayName: HEBREW_DAY_NAMES[parts.hebrewDay] ?? "",
      date: parts.isoDate,
    };
  }
  if (raw === "tomorrow" || raw === "מחר") {
    const tmr = new Date(now.getTime() + 24 * 3600 * 1000);
    const parts = getZonedDateParts(tmr, timeZone);
    return {
      mode: "day",
      dayNum: parts.hebrewDay,
      dayName: HEBREW_DAY_NAMES[parts.hebrewDay] ?? "",
      date: parts.isoDate,
    };
  }
  if (raw in DAY_ALIAS_TO_NUM) {
    const dayNum = DAY_ALIAS_TO_NUM[raw];
    return {
      mode: "day",
      dayNum,
      dayName: HEBREW_DAY_NAMES[dayNum] ?? "",
    };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      const parts = getZonedDateParts(parsed, timeZone);
      return {
        mode: "day",
        dayNum: parts.hebrewDay,
        dayName: HEBREW_DAY_NAMES[parts.hebrewDay] ?? "",
        date: raw,
      };
    }
  }
  const fallback = getZonedDateParts(now, timeZone);
  return {
    mode: "day",
    dayNum: fallback.hebrewDay,
    dayName: HEBREW_DAY_NAMES[fallback.hebrewDay] ?? "",
    date: fallback.isoDate,
  };
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  if (!html.includes("<") && !html.includes(">")) {
    return html.trim();
  }
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|p|div|li|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));

  const lines = text
    .split(/\r?\n/)
    .map((ln) => ln.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  return lines.join("\n");
}

export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  let s = subject.trim().toLowerCase();
  for (const q of ['"', "'", "״", "׳"]) {
    s = s.replaceAll(q, "");
  }
  for (const ch of ["-", "–", "_", ":", ",", "."]) {
    s = s.replaceAll(ch, " ");
  }
  s = s.replace(/\b(?:עמט|כיתה|הקבצה|שכבה|שכבת)\b/g, " ");
  s = s.replace(/\b[זחט]\s*\d\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function subjectSynonymGroup(normSubj: string): number | undefined {
  if (!normSubj) return undefined;
  for (let idx = 0; idx < SUBJECT_SYNONYMS.length; idx += 1) {
    const normGroup = SUBJECT_SYNONYMS[idx].map((g) => normalizeSubject(g)).filter(Boolean);
    if (
      normGroup.includes(normSubj) ||
      normGroup.some((ng) => ng.includes(normSubj) || normSubj.includes(ng))
    ) {
      return idx;
    }
  }
  return undefined;
}

export function subjectsMatch(subjA: string | null | undefined, subjB: string | null | undefined): boolean {
  const na = normalizeSubject(subjA);
  const nb = normalizeSubject(subjB);
  if (!na || !nb || na === "כללי" || nb === "כללי") return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;

  const ga = subjectSynonymGroup(na);
  const gb = subjectSynonymGroup(nb);
  if (ga !== undefined && ga === gb) return true;

  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  for (const token of ta) {
    if (token.length > 2 && tb.has(token)) {
      return true;
    }
  }
  return false;
}

export function inferNextLessonDueDate(
  subject: string,
  assignedDateIso: string | undefined,
  weeklyTimetable: Record<number, ScheduleLesson[]>,
  timeZone: string = "Asia/Jerusalem",
  referenceNow: Date = new Date()
): { dueDate?: string; label?: string } {
  if (!subject || !weeklyTimetable || Object.keys(weeklyTimetable).length === 0) {
    return {};
  }
  const baseDate = assignedDateIso ? new Date(assignedDateIso) : referenceNow;
  if (Number.isNaN(baseDate.getTime())) return {};

  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(baseDate.getTime() + offset * 24 * 3600 * 1000);
    const parts = getZonedDateParts(candidate, timeZone);
    if (parts.hebrewDay === 7) continue; // Skip Shabbat
    const lessons = weeklyTimetable[parts.hebrewDay] ?? [];
    for (const lesson of lessons) {
      if (subjectsMatch(subject, lesson.subject)) {
        const dueDate = `${parts.isoDate}T08:00:00`;
        const dayName = HEBREW_DAY_NAMES[parts.hebrewDay] ?? "";
        const dd = String(parts.day).padStart(2, "0");
        const mm = String(parts.month).padStart(2, "0");
        const label = `שיעור ${lesson.subject} הבא (יום ${dayName} ${dd}/${mm})`;
        return { dueDate, label };
      }
    }
  }
  return {};
}

export function classifyBehaviorCategory(
  title: string,
  details?: string | null
): "positive" | "negative" | "attendance" | "note" {
  const combined = `${title} ${details ?? ""}`.toLowerCase();
  if (POSITIVE_BEHAVIOR_HINTS.some((h) => combined.includes(h))) {
    return "positive";
  }
  if (ATTENDANCE_HINTS.some((h) => combined.includes(h))) {
    return "attendance";
  }
  if (NEGATIVE_BEHAVIOR_HINTS.some((h) => combined.includes(h))) {
    return "negative";
  }
  return "note";
}

export function classifyMessageCategories(
  msg: Pick<SchoolMessage, "subject" | "bodyText" | "attachments">
): Array<"behavior" | "exam" | "study_material" | "general"> {
  const msgText = `${msg.subject}\n${msg.bodyText}`;
  const combined =
    msgText +
    "\n" +
    msg.attachments.map((a) => `${a.filename} ${a.extractedText ?? ""}`).join("\n");

  const cats: Array<"behavior" | "exam" | "study_material" | "general"> = [];
  if (BEHAVIOR_KEYWORDS.some((kw) => msgText.includes(kw))) {
    cats.push("behavior");
  }
  if (EXAM_KEYWORDS.some((kw) => combined.includes(kw))) {
    cats.push("exam");
  }
  if (
    MATERIAL_KEYWORDS.some((kw) => combined.includes(kw)) ||
    (cats.includes("exam") && (msg.attachments.length > 0 || msg.bodyText.length > 120))
  ) {
    cats.push("study_material");
  }
  if (cats.length === 0) {
    cats.push("general");
  }
  return cats;
}

export async function extractAttachmentText(
  localPath: string,
  maxChars: number = 8000
): Promise<{ extractedText?: string; isImage: boolean }> {
  const suffix = path.extname(localPath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(suffix)) {
    return { isImage: true };
  }
  if (!fs.existsSync(localPath)) {
    return { isImage: false };
  }
  const stat = fs.statSync(localPath);
  if (stat.size > 12 * 1024 * 1024) {
    return { isImage: false };
  }

  try {
    if (suffix === ".pdf") {
      const buf = fs.readFileSync(localPath);
      if (!buf.subarray(0, 8).toString("latin1").startsWith("%PDF")) {
        return { isImage: false };
      }
      const pdfParse = loadPdfParse();
      // pdf-parse's bundled pdf.js logs font warnings via console.log (stdout),
      // which would corrupt MCP stdio JSON-RPC streams if left unguarded.
      const origLog = console.log;
      const origWarn = console.warn;
      console.log = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
        console.error(...args);
      };
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
        console.error(...args);
      };
      let parsed: { text?: string } | undefined;
      try {
        parsed = await pdfParse(buf);
      } finally {
        console.log = origLog;
        console.warn = origWarn;
      }
      const txt = (parsed?.text ?? "").trim();
      return {
        extractedText: txt ? txt.slice(0, maxChars) : undefined,
        isImage: false,
      };
    }

    if (suffix === ".docx") {
      const res = await mammoth.extractRawText({ path: localPath });
      const txt = (res.value ?? "").trim();
      return {
        extractedText: txt ? txt.slice(0, maxChars) : undefined,
        isImage: false,
      };
    }

    if ([".txt", ".csv", ".md"].includes(suffix)) {
      const txt = fs.readFileSync(localPath, "utf8").trim();
      return {
        extractedText: txt ? txt.slice(0, maxChars) : undefined,
        isImage: false,
      };
    }

    if ([".html", ".htm"].includes(suffix)) {
      const raw = fs.readFileSync(localPath, "utf8");
      const txt = htmlToText(raw);
      return {
        extractedText: txt ? txt.slice(0, maxChars) : undefined,
        isImage: false,
      };
    }
  } catch {
    // Non-fatal extraction failure
  }

  return { isImage: false };
}

function inferSubjectFromText(text: string): string {
  const knownSubjects = [
    "מתמטיקה",
    "אנגלית",
    "עברית",
    "לשון",
    "מדעים",
    "פיזיקה",
    "ביולוגיה",
    "כימיה",
    "היסטוריה",
    "אזרחות",
    'תנ"ך',
    "תנך",
    "ספרות",
    "ערבית",
    "גאוגרפיה",
    'של"ח',
    "מחשבים",
  ];
  for (const subj of knownSubjects) {
    if (text.includes(subj)) return subj;
  }
  return "כללי";
}

function inferDateFromMessage(
  msg: SchoolMessage,
  now: Date = new Date()
): string | undefined {
  const text = `${msg.subject}\n${msg.bodyText}`;
  const match = DATE_IN_TEXT_RE.exec(text);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-${dd}T09:00:00`;
}

export function buildExamsWithMaterials(
  examItems: SchoolItem[],
  messages: SchoolMessage[],
  now: Date = new Date()
): ExamWithMaterial[] {
  const merged = new Map<string, ExamWithMaterial>();

  for (const item of examItems) {
    if (item.itemType !== "exam" || !item.dueDate) continue;
    const dateDay = item.dueDate.slice(0, 10);
    const subjKey = normalizeSubject(item.subject) || normalizeSubject(item.title);
    const key = `${item.kid}:${subjKey}:${dateDay}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        id: item.id,
        kid: item.kid,
        studentId: item.studentId,
        subject: item.subject,
        title: item.title,
        examDate: item.dueDate,
        sources: [item.source],
        importantTrack: item.importantTrack,
        studyMaterialStatus: item.details && item.details.length > 20 ? "provided" : "missing",
        studyMaterialSummary:
          item.details && item.details.length > 20 ? item.details.slice(0, 600) : undefined,
        linkedMessages: [],
        details: item.details,
      });
    } else {
      if (!existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
      }
      if (item.importantTrack && !existing.importantTrack) {
        existing.importantTrack = item.importantTrack;
      }
      if (item.details && (!existing.details || item.details.length > existing.details.length)) {
        existing.details = item.details;
        if (item.details.length > 20 && existing.studyMaterialStatus === "missing") {
          existing.studyMaterialStatus = "provided";
          existing.studyMaterialSummary = item.details.slice(0, 600);
        }
      }
    }
  }

  // Also synthesize exams discovered only in teacher messages
  for (const msg of messages) {
    if (!msg.categories.includes("exam")) continue;
    const examDate = inferDateFromMessage(msg, now);
    if (!examDate) continue;
    const dateDay = examDate.slice(0, 10);
    const subj = inferSubjectFromText(`${msg.subject}\n${msg.bodyText}`);
    const subjKey = normalizeSubject(subj);
    const key = `${msg.kid}:${subjKey}:${dateDay}`;
    if (!merged.has(key)) {
      merged.set(key, {
        id: `msg-exam-${msg.id}`,
        kid: msg.kid,
        studentId: msg.studentId ?? msg.kid,
        subject: subj,
        title: msg.subject,
        examDate,
        sources: ["message"],
        studyMaterialStatus: "missing",
        linkedMessages: [],
      });
    }
  }

  const exams = Array.from(merged.values());
  for (const exam of exams) {
    const snippets: string[] = [];
    for (const msg of messages) {
      if (msg.kid !== exam.kid && msg.kid !== "משותף") continue;
      if (!msg.categories.includes("exam") && !msg.categories.includes("study_material")) {
        continue;
      }
      const msgBlob = `${msg.subject}\n${msg.bodyText}`;
      const sameSubject =
        subjectsMatch(exam.subject, msgBlob) ||
        (exam.subject !== "כללי" && msgBlob.includes(exam.subject));
      if (!sameSubject) continue;

      exam.linkedMessages.push(msg);
      if (msg.bodyText.trim()) {
        snippets.push(`${msg.subject}: ${msg.bodyText.slice(0, 500)}`);
      }
      for (const att of msg.attachments) {
        if (att.extractedText) {
          snippets.push(`[קובץ ${att.filename}]: ${att.extractedText.slice(0, 700)}`);
        } else {
          snippets.push(`[קובץ מצורף: ${att.filename}]`);
        }
      }
    }

    if (snippets.length > 0) {
      exam.studyMaterialStatus = "provided";
      exam.studyMaterialSummary = snippets.join("\n---\n").slice(0, 1400);
    }
  }

  exams.sort((a, b) => a.examDate.localeCompare(b.examDate));
  return exams;
}
