---
name: il-school-assistant
description: >-
  Query Israeli school portals (Mashov and Webtop) via the il-school-mcp server.
  Use when parents ask about today's or weekly schedules, homework, behavior or
  attendance logs, upcoming exams, study materials, or school inbox messages.
---

# Israeli School Assistant (Mashov & Webtop)

## Step 1: Discover Students & Check Setup State
1. If you do not yet know the children's names or systems, call `school_list_students`.
2. If `needsSetup` is `true` or `count === 0` with a configuration error, switch to the **`il-school-setup`** workflow so the parent can configure their accounts locally first.

## Step 2: Choose the Right Tool
- **Daily / tomorrow overview:** Call `school_get_digest` (returns today + tomorrow timetables, active homework, 7-day exams, and recent behavior).
- **Schedule / מערכת שעות:** Call `school_get_schedule` with optional `kid` and `date_or_day` (`today`, `tomorrow`, weekday name in Hebrew or English, `YYYY-MM-DD`, or `week`).
- **Homework / שיעורי בית:** Call `school_get_homework` with optional `kid` and `include_past_days`.
- **Exams & Study Material / מבחנים:** Call `school_get_exams` (and `school_get_messages` with `category: "study_material"` if extra context from teacher messages/PDFs/DOCX files is helpful).
- **Behavior & Attendance / התנהגות ונוכחות:** Call `school_get_behavior`.
- **Messages & Attachments / הודעות:** Call `school_get_messages` (can filter by `kid`, `category`, and `days`).

## Mandatory Reporting Rules
- **Estimated due dates:** Whenever `dueDateInferred` is `true`, explicitly tell the parent the due date is estimated from `inferredFromLesson` (the next scheduled lesson in that subject).
- **Missing study material:** Whenever `studyMaterialStatus === "missing"`, explicitly warn that no study material has been published by the teacher/school yet.
- **Behavior clarity:** Clearly separate `positive` praise (e.g., מילה טובה) from `negative` remarks and `attendance` events.
- **Read-only boundary:** Never offer or claim to submit assignments or reply to teachers.
