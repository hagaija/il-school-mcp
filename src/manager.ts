import path from "node:path";
import { getCacheDir, loadConfig } from "./config.js";
import {
  buildExamsWithMaterials,
  inferNextLessonDueDate,
  isQuietHours,
} from "./intelligence.js";
import { fetchExamCalendarForStudent } from "./providers/exam-calendar.js";
import { type FetchLike, MashovClient } from "./providers/mashov.js";
import { WebtopClient } from "./providers/webtop.js";
import { SchoolSessionStore } from "./session-store.js";
import type {
  AppConfig,
  DiscoveredStudent,
  FullSchoolState,
  ScheduleLesson,
  SchoolItem,
} from "./types.js";

export class SchoolManager {
  private readonly config: AppConfig;
  private readonly sessionStore: SchoolSessionStore;
  private readonly attachmentsDir: string;
  private readonly fetchImpl?: FetchLike;
  private cachedState?: FullSchoolState;
  private lastFetchMs = 0;

  constructor(opts?: {
    config?: AppConfig;
    sessionStore?: SchoolSessionStore;
    attachmentsDir?: string;
    fetchImpl?: FetchLike;
  }) {
    this.config = opts?.config ?? loadConfig();
    const cacheDir = getCacheDir();
    this.sessionStore =
      opts?.sessionStore ?? new SchoolSessionStore(path.join(cacheDir, "school_sessions.json"));
    this.attachmentsDir = opts?.attachmentsDir ?? path.join(cacheDir, "attachments");
    this.fetchImpl = opts?.fetchImpl;
  }

  getAppConfig(): AppConfig {
    return this.config;
  }

  resolveStudentName(
    kidQuery: string | undefined,
    students: DiscoveredStudent[]
  ): string | undefined {
    if (!kidQuery || !kidQuery.trim()) return undefined;
    const q = kidQuery.trim().toLowerCase();
    for (const st of students) {
      if (
        st.displayName.toLowerCase() === q ||
        st.firstName.toLowerCase() === q ||
        st.studentId.toLowerCase() === q ||
        st.aliases.some((a) => a.toLowerCase() === q)
      ) {
        return st.displayName;
      }
    }
    for (const st of students) {
      if (
        st.displayName.toLowerCase().includes(q) ||
        st.aliases.some((a) => a.toLowerCase().includes(q))
      ) {
        return st.displayName;
      }
    }
    return kidQuery.trim();
  }

  async getFullState(
    forceLive: boolean = false,
    now: Date = new Date()
  ): Promise<FullSchoolState> {
    const nowMs = now.getTime();
    const ttlMs = Math.max(1, this.config.cacheMinutes) * 60 * 1000;

    if (!forceLive && this.cachedState && nowMs - this.lastFetchMs < ttlMs) {
      return this.cachedState;
    }

    if (
      !forceLive &&
      this.config.quietHoursEnabled &&
      this.cachedState &&
      isQuietHours(now, this.config.timezone, this.config.quietHoursStart, this.config.quietHoursEnd)
    ) {
      return this.cachedState;
    }

    if (this.config.accounts.length === 0) {
      return {
        updatedAt: now.toISOString(),
        timezone: this.config.timezone,
        needsSetup: true,
        students: [],
        timetables: {},
        homework: [],
        behaviorEvents: [],
        messages: [],
        exams: [],
        notices: [],
        errors: [
          {
            accountId: "config",
            system: "mashov",
            message:
              "No Mashov or Webtop accounts configured. Run `node scripts/launch-mcp.mjs setup` (or `npx il-school-mcp setup`) in your terminal.",
          },
        ],
      };
    }

    const students: DiscoveredStudent[] = [];
    const timetables: Record<string, Record<number, ScheduleLesson[]>> = {};
    const homework: SchoolItem[] = [];
    const rawExams: SchoolItem[] = [];
    const notices: SchoolItem[] = [];
    const behaviorEvents: FullSchoolState["behaviorEvents"] = [];
    const messages: FullSchoolState["messages"] = [];
    const errors: FullSchoolState["errors"] = [];

    for (const account of this.config.accounts) {
      try {
        const client =
          account.system === "mashov"
            ? new MashovClient({
                account,
                sessionStore: this.sessionStore,
                attachmentsDir: this.attachmentsDir,
                schoolYear: this.config.schoolYear,
                downloadAttachments: this.config.downloadAttachments,
                fetchImpl: this.fetchImpl,
              })
            : new WebtopClient({
                account,
                sessionStore: this.sessionStore,
                attachmentsDir: this.attachmentsDir,
                schoolYear: this.config.schoolYear,
                downloadAttachments: this.config.downloadAttachments,
                fetchImpl: this.fetchImpl,
              });

        const res = await client.fetchAll(now);
        students.push(...res.students);
        Object.assign(timetables, res.timetables);
        homework.push(...res.homework);
        rawExams.push(...res.exams);
        behaviorEvents.push(...res.behaviorEvents);
        messages.push(...res.messages);
      } catch (err) {
        errors.push({
          accountId: account.id,
          system: account.system,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fetch optional school Google Exam Calendars per student
    for (const student of students) {
      if (!student.examIcalUrl) continue;
      try {
        const calItems = await fetchExamCalendarForStudent(student, now, this.fetchImpl);
        for (const item of calItems) {
          if (item.itemType === "exam") rawExams.push(item);
          else notices.push(item);
        }
      } catch (err) {
        errors.push({
          accountId: student.accountId,
          system: student.system,
          message: `Exam calendar error (${student.displayName}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    // Infer missing homework due dates from weekly timetables
    for (const item of homework) {
      if (item.dueDate) continue;
      const tt = timetables[item.kid];
      if (!tt) continue;
      const inferred = inferNextLessonDueDate(
        item.subject,
        item.assignedDate,
        tt,
        this.config.timezone,
        now
      );
      if (inferred.dueDate) {
        item.dueDate = inferred.dueDate;
        item.dueDateInferred = true;
        item.inferredFromLesson = inferred.label;
      }
    }

    homework.sort((a, b) =>
      (b.dueDate ?? b.assignedDate ?? "").localeCompare(a.dueDate ?? a.assignedDate ?? "")
    );
    behaviorEvents.sort((a, b) => b.eventDate.localeCompare(a.eventDate));
    messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt));

    const exams = buildExamsWithMaterials(rawExams, messages, now);

    const state: FullSchoolState = {
      updatedAt: now.toISOString(),
      timezone: this.config.timezone,
      needsSetup: false,
      students,
      timetables,
      homework,
      behaviorEvents,
      messages,
      exams,
      notices,
      errors,
    };

    this.cachedState = state;
    this.lastFetchMs = nowMs;
    return state;
  }
}
