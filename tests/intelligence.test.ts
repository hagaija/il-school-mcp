import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExamsWithMaterials,
  classifyBehaviorCategory,
  inferNextLessonDueDate,
  resolveDayQuery,
  subjectsMatch,
} from "../src/intelligence.js";

test("resolveDayQuery resolves today, tomorrow, Hebrew/English weekdays, dates, and week", () => {
  const wed = new Date("2026-11-18T10:00:00Z"); // Wednesday = day 4
  assert.deepEqual(resolveDayQuery("today", "Asia/Jerusalem", wed), {
    mode: "day",
    dayNum: 4,
    dayName: "רביעי",
    date: "2026-11-18",
  });
  assert.deepEqual(resolveDayQuery("tomorrow", "Asia/Jerusalem", wed), {
    mode: "day",
    dayNum: 5,
    dayName: "חמישי",
    date: "2026-11-19",
  });
  assert.deepEqual(resolveDayQuery("ראשון", "Asia/Jerusalem", wed), {
    mode: "day",
    dayNum: 1,
    dayName: "ראשון",
  });
  assert.deepEqual(resolveDayQuery("week", "Asia/Jerusalem", wed), { mode: "week" });
});

test("subjectsMatch and inferNextLessonDueDate handle Hebrew synonyms and skip Shabbat", () => {
  assert.equal(subjectsMatch("חשבון", "מתמטיקה"), true);
  assert.equal(subjectsMatch("לשון והבעה", "עברית"), true);
  assert.equal(subjectsMatch("היסטוריה", "מתמטיקה"), false);

  // Thursday 2026-11-19 -> Friday is day 6 (no Math), Saturday is Shabbat (skip), Sunday 2026-11-22 is day 1 (Math!)
  const inferred = inferNextLessonDueDate(
    "חשבון",
    "2026-11-19T09:00:00Z",
    {
      1: [{ lesson: 2, subject: "מתמטיקה" }],
      6: [{ lesson: 1, subject: "אנגלית" }],
    },
    "Asia/Jerusalem"
  );
  assert.equal(inferred.dueDate, "2026-11-22T08:00:00");
  assert.ok(inferred.label?.includes("יום ראשון"));
});

test("classifyBehaviorCategory and buildExamsWithMaterials work accurately", () => {
  assert.equal(classifyBehaviorCategory("מילה טובה"), "positive");
  assert.equal(classifyBehaviorCategory("אי הכנת ש.ב"), "negative");
  assert.equal(classifyBehaviorCategory("חיסור לא מוצדק"), "attendance");

  const exams = buildExamsWithMaterials(
    [
      {
        id: "ex-1",
        kid: "נועה",
        studentId: "s1",
        subject: "היסטוריה",
        itemType: "exam",
        title: "מבחן בהיסטוריה",
        dueDate: "2026-11-25T09:00:00",
        source: "mashov",
      },
      {
        id: "ex-2",
        kid: "נועה",
        studentId: "s1",
        subject: "אנגלית",
        itemType: "exam",
        title: "בוחן באנגלית",
        dueDate: "2026-11-27T09:00:00",
        source: "mashov",
      },
    ],
    [
      {
        id: "msg-1",
        kid: "נועה",
        subject: "חומר למבחן בהיסטוריה",
        bodyText: "עמודים 20-45 בספר הלימוד",
        sentAt: "2026-11-18T10:00:00",
        categories: ["exam", "study_material"],
        attachments: [],
        source: "mashov",
      },
    ],
    new Date("2026-11-18T12:00:00Z")
  );

  assert.equal(exams.length, 2);
  assert.equal(exams[0].subject, "היסטוריה");
  assert.equal(exams[0].studyMaterialStatus, "provided");
  assert.equal(exams[1].subject, "אנגלית");
  assert.equal(exams[1].studyMaterialStatus, "missing");
});
