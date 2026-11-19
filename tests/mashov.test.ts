import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MashovClient } from "../src/providers/mashov.js";
import { SchoolSessionStore } from "../src/session-store.js";

test("MashovClient discovers multiple children, reuses session, and retries once on 401", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-mashov-"));
  const store = new SchoolSessionStore(path.join(tmpDir, "sessions.json"));

  let loginCalls = 0;
  let expiredOnce = false;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/login")) {
      loginCalls += 1;
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Csrf-Token": `csrf-${loginCalls}`,
        "Set-Cookie": `Csrf-Token=csrf-${loginCalls}; Path=/`,
      });
      return new Response(
        JSON.stringify({
          accessToken: {
            children: [
              { childGuid: "guid-1", privateName: "נועה", familyName: "כהן", grade: "ח", classNum: 2, groups: [101] },
              { childGuid: "guid-2", privateName: "איתי", familyName: "כהן", grade: "ה", classNum: 1, groups: [202] },
            ],
          },
        }),
        { status: 200, headers }
      );
    }

    // Force a single 401 on first homework call for guid-2 to verify optimistic re-auth
    if (url.includes("/students/guid-2/homework") && !expiredOnce) {
      expiredOnce = true;
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.includes("/timetable")) {
      return new Response(
        JSON.stringify([
          {
            timeTable: { day: 1, lesson: 1, room: "204" },
            groupDetails: { subjectName: "מתמטיקה", groupTeachers: [{ teacherName: "דנה" }] },
          },
        ]),
        { status: 200 }
      );
    }

    if (url.includes("/homework")) {
      return new Response(
        JSON.stringify([
          {
            homeworkId: 55,
            subject: "מתמטיקה",
            homework: "עמוד 12 תרגילים 1-4",
            lessonDate: "2026-11-18T08:00:00",
          },
        ]),
        { status: 200 }
      );
    }

    if (url.includes("/exams")) {
      return new Response(
        JSON.stringify([
          { examId: 77, subjectName: "מתמטיקה", name: "מבחן אלגברה", examDate: "2026-11-25T09:00:00" },
        ]),
        { status: 200 }
      );
    }

    if (url.includes("/behave")) {
      return new Response(
        JSON.stringify([
          {
            lessonId: 9,
            achvaName: "מילה טובה",
            subject: "אנגלית",
            reporter: "רונית",
            timestamp: "2026-11-18T10:00:00",
          },
        ]),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/mail/inbox/conversations")) {
      return new Response(
        JSON.stringify([{ sendTime: "2026-11-18T11:00:00", messages: [{ messageId: 901 }] }]),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/mail/messages/901")) {
      return new Response(
        JSON.stringify({
          messageId: 901,
          subject: "חומר למבחן באלגברה",
          body: "<p>נושאים: משוואות וגרפים עמודים 10-30</p>",
          senderName: "דנה מורה",
          sendTime: "2026-11-18T11:00:00",
          recipients: [{ groupId: 101 }],
          files: [],
        }),
        { status: 200 }
      );
    }

    return new Response("Not Found", { status: 404 });
  };

  const client = new MashovClient({
    account: { id: "acc1", system: "mashov", username: "123456789", password: "secret", semel: 540123 },
    sessionStore: store,
    attachmentsDir: path.join(tmpDir, "att"),
    downloadAttachments: false,
    fetchImpl: mockFetch,
  });

  const res = await client.fetchAll(new Date("2026-11-18T12:00:00Z"));
  assert.equal(loginCalls, 2); // 1 initial login + 1 re-auth after 401
  assert.equal(res.students.length, 2);
  assert.equal(res.students[0].displayName, "נועה");
  assert.equal(res.students[1].displayName, "איתי");
  assert.equal(res.homework.length, 2);
  assert.equal(res.exams.length, 2);
  assert.equal(res.behaviorEvents[0].category, "positive");
  assert.equal(res.messages[0].kid, "נועה");
  assert.ok(res.messages[0].categories.includes("study_material"));

  // Next fetchAll reuses the valid session -> 0 new logins
  await client.fetchAll(new Date("2026-11-18T12:05:00Z"));
  assert.equal(loginCalls, 2);
});
