import assert from "node:assert/strict";
import test from "node:test";
import { parseIcsToExamItems } from "../src/providers/exam-calendar.js";
import type { DiscoveredStudent } from "../src/types.js";

test("parseIcsToExamItems filters by class, whole grade, and tracks", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:ev-1",
    "DTSTART:20261124T090000Z",
    "SUMMARY:מבחן במתמטיקה ח'-3",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:ev-2",
    "DTSTART:20261125T090000Z",
    "SUMMARY:מבחן בפיזיקה ח'-2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:ev-3",
    "DTSTART:20261126T090000Z",
    "SUMMARY:קונצרט מגמת מוזיקה",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const student: DiscoveredStudent = {
    studentId: "s1",
    accountId: "acc1",
    system: "mashov",
    displayName: "נועה",
    firstName: "נועה",
    lastName: "כהן",
    aliases: ["נועה"],
    grade: "ח",
    classNumber: 3,
    tracks: ["מוזיקה"],
  };

  const items = parseIcsToExamItems(
    ics,
    student,
    new Date("2026-11-20T00:00:00Z"),
    new Date("2026-12-01T00:00:00Z")
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "מבחן במתמטיקה ח'-3");
  assert.equal(items[0].itemType, "exam");
  assert.equal(items[1].title, "קונצרט מגמת מוזיקה");
  assert.equal(items[1].importantTrack, "מוזיקה");
});
