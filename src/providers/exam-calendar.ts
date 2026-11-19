import ical from "node-ical";
import type { DiscoveredStudent, SchoolItem } from "../types.js";
import type { FetchLike } from "./mashov.js";

const GRADE_LETTERS = ["ז", "ח", "ט", "י", "יא", "יב", "א", "ב", "ג", "ד", "ה", "ו"];

function isExamTitle(summary: string, description: string): boolean {
  const blob = `${summary} ${description}`;
  return ["מבחן", "בוחן", "מבדק", "בחינה", "מיפוי", "מועד ב", "מתכונת", "בגרות"].some((kw) =>
    blob.includes(kw)
  );
}

function inferSubjectFromTitle(summary: string): string {
  let cleaned = summary
    .replace(/\s+(?:מבחן|בוחן|מבדק|בחינה)$/, "")
    .replace(/\bל?(?:שכבת|שכבה|כיתה|כיתות)\b.*/, "")
    .replace(/\s+ל?(?:ז|ח|ט|י|יא|יב)["'׳']?\s*\d.*/, "")
    .trim();
  return cleaned.slice(0, 40) || "כללי";
}

export function isEventRelevantForStudent(opts: {
  summary: string;
  description: string;
  targetGrade?: string;
  targetClassNum?: number;
  tracks: string[];
}): { relevant: boolean; matchedTrack?: string } {
  const blob = `${opts.summary}\n${opts.description}`;

  // Track match takes precedence if configured
  for (const track of opts.tracks) {
    if (track && blob.includes(track)) {
      return { relevant: true, matchedTrack: track };
    }
  }

  if (!opts.targetGrade) {
    return { relevant: true };
  }

  const grade = opts.targetGrade.replace(/["'׳']/g, "").trim();
  const classNum = opts.targetClassNum;

  // Exact class match e.g. ח'-3, ח3, ח 3
  if (classNum !== undefined) {
    const classRe = new RegExp(`(?<![א-ת])${grade}["'׳']?\\s*[-–]?\\s*${classNum}(?!\\d)`);
    if (classRe.test(blob)) {
      return { relevant: true };
    }
  }

  // Whole-grade match e.g. שכבת ח, שכבה ט'
  const wholeGradeRe = new RegExp(`(?:שכבת|שכבה|כל\\s+כיתות)\\s+${grade}["'׳']?(?!\\s*[-–]?\\s*\\d)`);
  if (wholeGradeRe.test(blob)) {
    return { relevant: true };
  }

  // Exclude events explicitly targeting another grade or another class in our grade
  if (classNum !== undefined) {
    const otherClassSameGradeRe = new RegExp(`(?<![א-ת])${grade}["'׳']?\\s*[-–]?\\s*(\\d+)`);
    const m = otherClassSameGradeRe.exec(blob);
    if (m && Number(m[1]) !== classNum) {
      return { relevant: false };
    }
  }

  for (const otherGrade of GRADE_LETTERS) {
    if (otherGrade === grade) continue;
    const otherGradeRe = new RegExp(
      `(?:שכבת|שכבה|כיתה|כיתות|(?<![א-ת]))${otherGrade}["'׳']?\\s*[-–]?\\s*\\d`
    );
    if (otherGradeRe.test(blob)) {
      return { relevant: false };
    }
  }

  return { relevant: false };
}

export function parseIcsToExamItems(
  icsText: string,
  student: DiscoveredStudent,
  startDate: Date,
  endDate: Date
): SchoolItem[] {
  const parsed = ical.parseICS(icsText);
  const items: SchoolItem[] = [];

  for (const [uid, entry] of Object.entries(parsed)) {
    if (!entry || entry.type !== "VEVENT") continue;
    const summary = String(entry.summary ?? "").trim();
    if (!summary) continue;
    const description = String(entry.description ?? "").trim();

    const { relevant, matchedTrack } = isEventRelevantForStudent({
      summary,
      description,
      targetGrade: student.grade,
      targetClassNum: student.classNumber,
      tracks: student.tracks,
    });
    if (!relevant) continue;

    if (!isExamTitle(summary, description) && !matchedTrack) {
      continue;
    }

    const startVal = entry.start instanceof Date ? entry.start : new Date(String(entry.start));
    if (Number.isNaN(startVal.getTime())) continue;
    if (startVal < startDate || startVal > endDate) continue;

    items.push({
      id: `gcal-${student.studentId}-${uid}`,
      kid: student.displayName,
      studentId: student.studentId,
      subject: inferSubjectFromTitle(summary),
      itemType: isExamTitle(summary, description) ? "exam" : "notice",
      title: summary,
      details: description || undefined,
      dueDate: startVal.toISOString(),
      source: "exam_calendar",
      importantTrack: matchedTrack,
    });
  }

  items.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  return items;
}

export async function fetchExamCalendarForStudent(
  student: DiscoveredStudent,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch
): Promise<SchoolItem[]> {
  if (!student.examIcalUrl) return [];
  const start = new Date(now.getTime() - 24 * 3600 * 1000);
  const end = new Date(now.getTime() + 45 * 24 * 3600 * 1000);

  const resp = await fetchImpl(student.examIcalUrl);
  if (!resp.ok) {
    throw new Error(`Exam calendar HTTP ${resp.status} for ${student.displayName}`);
  }
  const icsText = await resp.text();
  return parseIcsToExamItems(icsText, student, start, end);
}
