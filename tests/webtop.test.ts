import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encryptWebtopPayload, WebtopClient } from "../src/providers/webtop.js";
import { SchoolSessionStore } from "../src/session-store.js";

test("encryptWebtopPayload produces deterministic AES-256-CBC base64 string", () => {
  const enc1 = encryptWebtopPayload("123456789");
  const enc2 = encryptWebtopPayload("123456789");
  assert.equal(enc1, enc2);
  assert.ok(enc1.length >= 24);
});

test("WebtopClient logs in, detects status:false expiration, re-auths once, and normalizes data", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-webtop-"));
  const store = new SchoolSessionStore(path.join(tmpDir, "sessions.json"));

  let loginCalls = 0;
  let expiredOnce = false;

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/user/LoginByUserNameAndPassword")) {
      loginCalls += 1;
      return new Response(
        JSON.stringify({ status: true, data: { token: `wt-token-${loginCalls}` } }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/dashboard/InitDashboard")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            childrens: [{ id: "enc-1", firstName: "ירדן", lastName: "לוי", classCode: 5, classNum: 2 }],
          },
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/dashboard/GetHomeWork")) {
      if (!expiredOnce) {
        expiredOnce = true;
        return new Response(
          JSON.stringify({ status: false, errorDescription: "פג תוקף החיבור" }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            dataTable: [
              {
                id: "hw-1",
                lesson: "אנגלית",
                homeworkData: "קריאת עמוד 18",
                lessonSubject: "Past Simple",
                teacher: "שירה",
                lessonDate: "2026-11-18T09:00:00",
              },
            ],
          },
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/dashboard/GetPupilDiciplineEvents")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            {
              eventID: 42,
              eventType: "אי הכנת ש.ב",
              subjectName: "מתמטיקה",
              teacherName: "יוסי",
              eventDate: "2026-11-18T10:00:00",
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/PupilCard/GetPupilScheduale")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: [
            {
              dayIndex: 4,
              hoursData: [
                {
                  hour: 2,
                  scheduale: [
                    {
                      day: 4,
                      hour: 2,
                      subject: "אנגלית",
                      room: "12",
                      teacherPrivateName: "שירה",
                      teacherLastName: "כהן",
                    },
                  ],
                },
                { hour: 3, scheduale: [] },
              ],
            },
          ],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/messageBox/GetMessagesInbox")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: [{ messageId: 300, subject: "עדכון כיתתי", sendingDate: "2026-11-18T12:00:00" }],
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/api/messageBox/GetMessagesInboxData")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            messageData: {
              subject: "עדכון כיתתי",
              messageContent: "<p>נא להביא מחברת</p>",
              privateName: "שירה",
              lastName: "כהן",
              sendingDate: "2026-11-18T12:00:00",
              filesList: [],
            },
          },
        }),
        { status: 200 }
      );
    }

    return new Response("Not found", { status: 404 });
  };

  const client = new WebtopClient({
    account: { id: "wt1", system: "webtop", username: "parent1", password: "pw" },
    sessionStore: store,
    attachmentsDir: path.join(tmpDir, "att"),
    downloadAttachments: false,
    fetchImpl: mockFetch,
  });

  const res = await client.fetchAll(new Date("2026-11-18T12:00:00Z"));
  assert.equal(loginCalls, 2); // initial + 1 reauth on status:false
  assert.equal(res.students[0].displayName, "ירדן");
  assert.equal(res.homework[0].subject, "אנגלית");
  assert.equal(res.behaviorEvents[0].category, "negative");
  assert.equal(res.timetables["ירדן"][4][0].subject, "אנגלית");
  assert.equal(res.messages[0].sender, "שירה כהן");
});

test("WebtopClient unwraps data.dataTable.diciplineEvents behavior response", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "il-school-webtop-beh-"));
  const store = new SchoolSessionStore(path.join(tmpDir, "sessions.json"));

  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/user/LoginByUserNameAndPassword")) {
      return new Response(
        JSON.stringify({ status: true, data: { token: "wt-tok-1" } }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/dashboard/InitDashboard")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            childrens: [{ id: "enc-1", firstName: "ירדן", lastName: "יעקובסון", classCode: 3, classNum: 1 }],
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/dashboard/GetHomeWork")) {
      return new Response(JSON.stringify({ status: true, data: { dataTable: [] } }), { status: 200 });
    }
    if (url.endsWith("/api/dashboard/GetPupilDiciplineEvents")) {
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            dataTable: {
              diciplineEvents: [
                {
                  eventID: 30540817,
                  eventType: "מילה טובה- התארגנות ומילוי משימות",
                  subjectName: "מתמטיקה",
                  teacherName: "מתתיה עדן אילנה",
                  eventDate: "2026-11-20T00:00:00",
                },
              ],
            },
          },
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/api/PupilCard/GetPupilScheduale")) {
      return new Response(JSON.stringify({ status: true, data: [] }), { status: 200 });
    }
    if (url.endsWith("/api/messageBox/GetMessagesInbox")) {
      return new Response(JSON.stringify({ status: true, data: [] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new WebtopClient({
    account: { id: "wt2", system: "webtop", username: "parent2", password: "pw" },
    sessionStore: store,
    attachmentsDir: path.join(tmpDir, "att"),
    downloadAttachments: false,
    fetchImpl: mockFetch,
  });

  const res = await client.fetchAll(new Date("2026-11-21T12:00:00Z"));
  assert.equal(res.behaviorEvents.length, 1);
  assert.equal(res.behaviorEvents[0].category, "positive");
  assert.equal(res.behaviorEvents[0].title, "מילה טובה- התארגנות ומילוי משימות");
  assert.equal(res.behaviorEvents[0].subject, "מתמטיקה");
});
