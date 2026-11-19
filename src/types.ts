export type SchoolSystem = "mashov" | "webtop";

export interface StudentOverrideConfig {
  /** Match against discovered student first name, full name, or student ID/GUID. */
  match: string;
  /** Optional display name override (e.g. nickname). */
  displayName?: string;
  /** Optional alternative names / aliases the parent might type (Hebrew or English). */
  aliases?: string[];
  /** Optional public Google Calendar ICS URL for school exam schedules. */
  examIcalUrl?: string;
  /** Grade letter for filtering exam calendars (e.g. "ח", "ט"). */
  grade?: string;
  /** Class number for filtering exam calendars (e.g. 3, 4). */
  classNumber?: number;
  /** Track / megama keywords for filtering exam calendars (e.g. ["מוזיקה"]). */
  tracks?: string[];
  /** Optional fallback weekly timetable if the portal (e.g. elementary Webtop) disables it. */
  fallbackTimetable?: Record<number, ScheduleLesson[]>;
}

export interface AccountConfig {
  id: string;
  system: SchoolSystem;
  username: string;
  password: string;
  /** Mashov 6-digit school code (סמל מוסד). Required for Mashov accounts. */
  semel?: number;
  /** Optional label for the account (e.g. "Tichon Herzliya"). */
  label?: string;
  /** Optional per-student metadata overrides & exam calendars. */
  students?: StudentOverrideConfig[];
}

export interface AppConfig {
  version: 1;
  timezone: string;
  schoolYear?: number;
  cacheMinutes: number;
  quietHoursEnabled: boolean;
  quietHoursStart: number; // e.g. 22
  quietHoursEnd: number;   // e.g. 6
  downloadAttachments: boolean;
  accounts: AccountConfig[];
}

export interface DiscoveredStudent {
  studentId: string;
  accountId: string;
  system: SchoolSystem;
  displayName: string;
  firstName: string;
  lastName: string;
  aliases: string[];
  grade?: string;
  classNumber?: number;
  semel?: number;
  schoolName?: string;
  tracks: string[];
  examIcalUrl?: string;
  fallbackTimetable?: Record<number, ScheduleLesson[]>;
  rawMetadata?: Record<string, unknown>;
}

export interface ScheduleLesson {
  lesson: number;
  subject: string;
  room?: string;
  teacher?: string;
}

export interface SchoolItem {
  id: string;
  kid: string;
  studentId: string;
  subject: string;
  itemType: "homework" | "exam" | "notice";
  title: string;
  details?: string;
  dueDate?: string; // ISO string
  assignedDate?: string; // ISO string
  dueDateInferred?: boolean;
  inferredFromLesson?: string;
  source: "mashov" | "webtop" | "exam_calendar" | "message" | "portal";
  importantTrack?: string;
}

export interface BehaviorEvent {
  id: string;
  kid: string;
  studentId: string;
  eventDate: string; // ISO string
  category: "positive" | "negative" | "attendance" | "note";
  title: string;
  subject?: string;
  teacher?: string;
  details?: string;
  justified?: boolean | null;
  source: "behave_api" | "message";
}

export interface MessageAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  localPath?: string;
  extractedText?: string;
  isImage: boolean;
}

export interface SchoolMessage {
  id: string;
  kid: string;
  studentId?: string;
  sender?: string;
  subject: string;
  bodyText: string;
  sentAt: string; // ISO string
  categories: Array<"behavior" | "exam" | "study_material" | "general">;
  attachments: MessageAttachment[];
  source: "mashov" | "webtop" | "portal";
}

export interface ExamWithMaterial {
  id: string;
  kid: string;
  studentId: string;
  subject: string;
  title: string;
  examDate: string; // ISO string
  sources: string[];
  importantTrack?: string;
  studyMaterialStatus: "provided" | "missing";
  studyMaterialSummary?: string;
  linkedMessages: SchoolMessage[];
  details?: string;
}

export interface FullSchoolState {
  updatedAt: string;
  timezone: string;
  needsSetup?: boolean;
  students: DiscoveredStudent[];
  timetables: Record<string, Record<number, ScheduleLesson[]>>; // keyed by student displayName
  homework: SchoolItem[];
  behaviorEvents: BehaviorEvent[];
  messages: SchoolMessage[];
  exams: ExamWithMaterial[];
  notices: SchoolItem[];
  errors: Array<{ accountId: string; system: SchoolSystem; message: string }>;
}

export interface SchoolSession {
  providerType: SchoolSystem;
  accountKey: string;
  csrfToken?: string;
  webToken?: string;
  cookies: Record<string, string>;
  childMetadata: Record<string, unknown>;
  lastLoginTs: number;
  expiresAt: number;
  consecutiveFailures: number;
  lastFailureTs: number;
}
