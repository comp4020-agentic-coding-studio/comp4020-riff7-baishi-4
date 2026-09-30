import { beforeAll, describe, expect, inject, it } from "vitest";
import { createDirtyTracker, createReconnectGate } from "../src/lib/live-reload";
import { sessionDate } from "../src/lib/db";

// This week's brief: model a slice of a real ANU system, wired end to end,
// with a core flow that survives a reload. The roster's core flow is
// rescheduling a crit group's session for one teaching week; these tests
// assert the contracts that make that a real persisted change, not just a
// page that renders — the same shape as the starter's own guestbook.test.ts
// asserted for the demo it replaces.
//
// There's no login system yet (src/lib/auth.ts hardcodes the signed-in
// tutor to the "baishi" crit group), so every write below targets
// critGroupId 3 (baishi) unless a test is specifically probing that another
// group's sessions are off limits.
const baseUrl = inject("baseUrl");

// Astro checks form POSTs carry a same-origin Origin header (CSRF
// protection); browsers send it automatically, a bare fetch doesn't.
const post = (path: string, body: URLSearchParams) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { origin: baseUrl },
    body,
    redirect: "manual",
  });

// Each exception's <li> carries its own id as a data attribute regardless of
// whether its cancel form renders (it only does for the signed-in tutor's
// own group) — this finds the id belonging to the li whose text contains
// `needle`, without assuming DOM order relative to any other li on the page.
function findExceptionId(html: string, needle: string): string {
  const items = html.matchAll(/<li data-exception-id="(\d+)">((?:(?!<\/li>)[^])*)<\/li>/g);
  for (const item of items) {
    if (item[2].includes(needle)) return item[1];
  }
  throw new Error(`could not find an exception <li> containing ${JSON.stringify(needle)}`);
}

describe("rescheduling a session", () => {
  const reason = `spec probe ${process.hrtime.bigint()}`;

  it("accepts a valid reschedule and redirects back to the roster", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3", // baishi — the signed-in tutor's own group
        date: "2026-10-01", // week 8, Thu
        startTime: "11:00",
        room: "",
        reason,
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  it("persists the reschedule, with the end time computed as start + 90 minutes", async () => {
    const res = await fetch(baseUrl);
    const html = await res.text();
    expect(html).toContain(reason);
    expect(html).toContain("Thu 11:00–12:30");
  });

  it("falls back to the group's own room when none is given", async () => {
    const html = await (await fetch(baseUrl)).text();
    expect(html).toContain("Marie Reay Building (155), Room 4.03");
  });

  it("broadcasts the change over the SSE stream", async () => {
    const stream = await fetch(new URL("/api/events", baseUrl));
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("no response body");

    await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3", // baishi — a different week from the test above
        date: "2026-08-28", // week 5, Fri
        startTime: "13:00",
        room: "",
        reason: "live probe",
      }),
    );

    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("data: changed")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the event arrived");
      received += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  }, 10_000);
});

describe("rescheduling the same week twice", () => {
  // addException deletes any existing exception for the same (critGroupId,
  // week) before inserting the new one -- the schema's own unique
  // constraint on that pair would otherwise reject the second insert. This
  // is the "one exception per group per week" rule, and had no test of its
  // own: a naive read of that constraint could just as easily mean "reject
  // a second reschedule," which is not what the code does.
  it("replaces the earlier exception rather than duplicating or rejecting it", async () => {
    await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3", // baishi
        date: "2026-10-20", // week 11, Tue
        startTime: "09:00",
        room: "",
        reason: "first reschedule",
      }),
    );
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3",
        date: "2026-10-23", // week 11, Fri
        startTime: "13:00",
        room: "",
        reason: "second reschedule",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("first reschedule");
    expect(html).toContain("second reschedule");
    expect(html).toContain("Fri 13:00–14:30");
    // exactly one row for that group/week, not one for each reschedule
    expect(html.match(/second reschedule/g)?.length).toBe(1);
  });
});

describe("validation", () => {
  it("rejects a reason-free request without writing an exception", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3",
        date: "2026-09-03", // week 6, Thu
        startTime: "09:00",
        room: "",
        reason: "",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);

    const html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("Thu 09:00–10:30");
  });

  it("rejects a date that isn't a weekday within a teaching week", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3",
        date: "2026-09-05", // week 6's Saturday
        startTime: "10:00",
        room: "",
        reason: "weekend",
      }),
    );
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);
  });
});

describe("session duration", () => {
  // The form only takes a start time -- this is the one behaviour
  // requirement (6) asks to be pinned down explicitly, beyond the round
  // numbers the tests above already exercise incidentally.
  it("always computes the end time as exactly 90 minutes after the start time", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3",
        date: "2026-10-28", // week 12, Wed
        startTime: "16:20",
        room: "",
        reason: "duration probe",
      }),
    );
    expect(res.status).toBe(303);

    const html = await (await fetch(baseUrl)).text();
    expect(html).toContain("Wed 16:20–17:50");
  });

  it("rejects a start time so late a 90-minute session would run past midnight", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3",
        date: "2026-09-02", // week 6, Wed
        startTime: "23:15",
        room: "",
        reason: "past-midnight probe",
      }),
    );
    expect(res.headers.get("location")).toMatch(/^\/\?error=/);

    const html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("past-midnight probe");
  });
});

describe("tutor permissions", () => {
  // No login system yet: src/lib/auth.ts hardcodes the signed-in tutor to
  // the "baishi" crit group (id 3). These pin down requirement (1) and (5):
  // a tutor can manage their own group, and the server refuses every other
  // group even when the request is crafted directly, bypassing whatever the
  // UI does or doesn't render.
  it("lets the baishi tutor create and cancel a session for their own group", async () => {
    const createRes = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3", // baishi
        date: "2026-08-18", // week 4, Tue
        startTime: "10:00",
        room: "",
        reason: "own-group probe",
      }),
    );
    expect(createRes.status).toBe(303);
    expect(createRes.headers.get("location")).toBe("/");

    let html = await (await fetch(baseUrl)).text();
    expect(html).toContain("own-group probe");
    expect(html).toContain("Tue 10:00–11:30");

    const exceptionId = findExceptionId(html, "own-group probe");
    const cancelRes = await post(`/api/exceptions/${exceptionId}/cancel`, new URLSearchParams());
    expect(cancelRes.status).toBe(303);
    expect(cancelRes.headers.get("location")).toBe("/");

    html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("own-group probe");
  });

  it("rejects creating a session for another tutorial group, even via a direct request", async () => {
    const res = await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "4", // dachi — not the signed-in tutor's own group
        date: "2026-08-18", // week 4, Tue — otherwise a perfectly valid request
        startTime: "10:00",
        room: "",
        reason: "should never appear",
      }),
    );
    expect(res.status).toBe(403);

    const html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("should never appear");
  });

  it("rejects cancelling another tutorial group's exception, even via a direct request", async () => {
    // Week 9's seeded exceptions belong to shitao and bada, neither of
    // which is the signed-in tutor's own group.
    const html = await (await fetch(baseUrl)).text();
    const exceptionId = findExceptionId(html, "Monday 5 October is the ACT Labour Day public holiday");

    const res = await post(`/api/exceptions/${exceptionId}/cancel`, new URLSearchParams());
    expect(res.status).toBe(403);

    const htmlAfter = await (await fetch(baseUrl)).text();
    expect(htmlAfter).toContain("Monday 5 October is the ACT Labour Day public holiday");
  });
});

describe("live-reload reconnect gate", () => {
  // The client's EventSource reconnects on its own after any drop -- a
  // network blip, or on Fly.io the machine auto-stopping while idle -- but
  // the in-memory bus keeps no backlog of what it missed. Verified live with
  // agent-browser too (killing and restarting the preview server mid-session
  // to simulate a Fly auto-stop/wake cycle, see memory/now.md); this covers
  // the gate's own decision in isolation, cheaper than a browser round trip.
  it("does not reload on the first connect", () => {
    const shouldReloadOnOpen = createReconnectGate();
    expect(shouldReloadOnOpen()).toBe(false);
  });

  it("reloads on every reconnect after the first", () => {
    const shouldReloadOnOpen = createReconnectGate();
    shouldReloadOnOpen();
    expect(shouldReloadOnOpen()).toBe(true);
    expect(shouldReloadOnOpen()).toBe(true);
  });
});

describe("sessionDate", () => {
  // A session's date is derived from the week's Monday, never stored.
  // Every roster row on the page renders through this function, but
  // nothing had asserted the arithmetic itself -- only eyeballed the
  // rendered result against the real calendar.
  it("returns the Monday itself for a Mon session", () => {
    expect(sessionDate("2026-07-27", "Mon")).toBe("2026-07-27");
  });

  it("offsets forward within the same week for a later weekday", () => {
    expect(sessionDate("2026-07-27", "Wed")).toBe("2026-07-29");
  });

  it("crosses a month boundary using a real seeded week", () => {
    // Week 8's Monday (2026-09-28); its Friday session falls in October.
    expect(sessionDate("2026-09-28", "Fri")).toBe("2026-10-02");
  });
});

describe("dirty tracker", () => {
  // A `location.reload()` triggered by someone else's change is safe only when
  // there's nothing of the tutor's own to lose -- if they're mid-way through
  // filling in a reschedule, the same reload that shows the other tutor's
  // change also silently wipes whatever they'd already typed. `markDirty` is
  // meant to be wired to the reschedule form's own `input` event; `isDirty`
  // gates every reload site below on it.
  //
  // `markClean` exists because dirty isn't a one-way trip: a tutor who types a
  // draft and then clears it back out (or undoes it) has nothing left to lose
  // either, and without a way back to clean, that tab's live sync would stay
  // broken for the rest of its life over a draft that no longer exists.
  // index.astro calls markClean whenever the form's current values match its
  // snapshot at page load.
  //
  // Going clean isn't enough on its own, though: if a change already arrived
  // while dirty (a reload was skipped and the stale notice shown instead),
  // clearing the draft afterwards has nothing left to lose either, but
  // nothing re-checks that missed reload -- the tab would sit on the stale
  // notice until some unrelated further change happened to arrive, or the
  // tutor manually refreshed. `notePendingReload`/`claimPendingReload` close
  // that gap: a reload site calls `notePendingReload` whenever it skips a
  // reload because of `isDirty`, and index.astro's `input` handler calls
  // `claimPendingReload` right after `markClean` to fire the deferred reload
  // immediately, instead of waiting for a fresh trigger that might never come.
  it("starts clean and reports dirty once marked", () => {
    const dirty = createDirtyTracker();
    expect(dirty.isDirty()).toBe(false);
    dirty.markDirty();
    expect(dirty.isDirty()).toBe(true);
  });

  it("stays dirty across repeated checks and marks", () => {
    const dirty = createDirtyTracker();
    dirty.markDirty();
    dirty.markDirty();
    expect(dirty.isDirty()).toBe(true);
    expect(dirty.isDirty()).toBe(true);
  });

  // Found live the same way as the reload-vs-draft bug above: a tutor who
  // types into the reschedule form and then clears it back out (or the
  // browser autofills a default value they then remove) has nothing left
  // to lose, but a one-way dirty flag would leave this tab's live sync
  // broken for the rest of its life over a draft that no longer exists.
  it("goes clean again once marked clean", () => {
    const dirty = createDirtyTracker();
    dirty.markDirty();
    expect(dirty.isDirty()).toBe(true);
    dirty.markClean();
    expect(dirty.isDirty()).toBe(false);
  });

  // Found live the same way as the two bugs above: going clean stops
  // *future* reload attempts from being skipped, but a change that already
  // arrived while dirty (a reload skipped, the stale notice shown instead)
  // was never retried -- the tab sat on the stale notice until some
  // unrelated further change happened to arrive, or the tutor manually
  // refreshed. `notePendingReload` records that a reload was deferred;
  // `claimPendingReload` is what index.astro checks right after `markClean`
  // to fire that deferred reload immediately instead of waiting for one
  // that might never come.
  it("claims a pending reload once, after the deferring dirty state clears", () => {
    const dirty = createDirtyTracker();
    dirty.markDirty();
    dirty.notePendingReload();
    dirty.markClean();
    expect(dirty.claimPendingReload()).toBe(true);
    expect(dirty.claimPendingReload()).toBe(false);
  });

  it("has nothing pending when no reload was ever deferred", () => {
    const dirty = createDirtyTracker();
    dirty.markDirty();
    dirty.markClean();
    expect(dirty.claimPendingReload()).toBe(false);
  });
});

describe("cancelling a reschedule", () => {
  let exceptionId: string;

  beforeAll(async () => {
    await post(
      "/api/exceptions",
      new URLSearchParams({
        critGroupId: "3", // baishi
        date: "2026-08-14", // week 3, Fri
        startTime: "09:00",
        room: "",
        reason: "to be cancelled",
      }),
    );
    const html = await (await fetch(baseUrl)).text();
    exceptionId = findExceptionId(html, "to be cancelled");
  });

  it("reverts the week to the group's standing slot", async () => {
    const res = await post(`/api/exceptions/${exceptionId}/cancel`, new URLSearchParams());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");

    const html = await (await fetch(baseUrl)).text();
    expect(html).not.toContain("to be cancelled");
  });
});
