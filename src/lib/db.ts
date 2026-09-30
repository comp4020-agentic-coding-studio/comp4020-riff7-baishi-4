import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { type CritGroup, type Exception, critGroups, exceptions, weeks } from "./schema";

// One SQLite file is the app's whole persistent state. In production
// fly.toml points DATABASE_PATH at the machine's volume (/data), which is
// how state survives a reload and a redeploy; locally it defaults to an
// untracked file in .data/.
const path = process.env.DATABASE_PATH ?? "./.data/app.db";
mkdirSync(dirname(path), { recursive: true });

const client = new Database(path);
client.pragma("journal_mode = WAL");

export const db = drizzle(client);

// Migrations run at boot, on whatever machine holds the volume — the
// recommended shape for SQLite on Fly, where there's no separate machine to
// run them from. The flow: edit src/lib/schema.ts, `pnpm db:generate`,
// commit the migration it writes to drizzle/.
migrate(db, { migrationsFolder: "./drizzle" });

const DEFAULT_ROOM = "Marie Reay Building (155), Room 4.03";

// The real crit groups and 2026-S2 teaching weeks, as published by the
// course website's own api/crit-groups.json — the system this app models a
// slice of. Seeded once, on first boot against an empty database; a
// redeploy or a reload never re-runs this against real rows.
const SEED_GROUPS: Omit<CritGroup, "id">[] = [
  { agent: "shitao", name: "Shitao", tutorName: "Ushini Attanayake", day: "Mon", startTime: "14:00", endTime: "15:30", room: DEFAULT_ROOM },
  { agent: "bada", name: "Bada", tutorName: "Ushini Attanayake", day: "Mon", startTime: "15:30", endTime: "17:00", room: DEFAULT_ROOM },
  { agent: "baishi", name: "Baishi", tutorName: "Tom Griffiths", day: "Wed", startTime: "09:00", endTime: "10:30", room: DEFAULT_ROOM },
  { agent: "dachi", name: "Dachi", tutorName: "Tom Griffiths", day: "Wed", startTime: "10:30", endTime: "12:00", room: DEFAULT_ROOM },
  { agent: "yunlin", name: "Yunlin", tutorName: "Bill McAlister", day: "Wed", startTime: "14:00", endTime: "15:30", room: DEFAULT_ROOM },
  { agent: "liuru", name: "Liuru", tutorName: "Bill McAlister", day: "Wed", startTime: "15:30", endTime: "17:00", room: DEFAULT_ROOM },
];

const SEED_WEEKS: Omit<import("./schema").Week, never>[] = [
  { week: 1, monday: "2026-07-27" },
  { week: 2, monday: "2026-08-03" },
  { week: 3, monday: "2026-08-10" },
  { week: 4, monday: "2026-08-17" },
  { week: 5, monday: "2026-08-24" },
  { week: 6, monday: "2026-08-31" },
  { week: 7, monday: "2026-09-21" },
  { week: 8, monday: "2026-09-28" },
  { week: 9, monday: "2026-10-05" },
  { week: 10, monday: "2026-10-12" },
  { week: 11, monday: "2026-10-19" },
  { week: 12, monday: "2026-10-26" },
];

// Week 9's real, already-published exceptions (both groups sharing the
// 14:00 tutor's Monday slot, moved off the ACT Labour Day public holiday) —
// seeded so the roster starts from the schedule as it actually stands, not
// an empty one.
const SEED_EXCEPTIONS: Array<Omit<Exception, "id" | "createdAt" | "critGroupId"> & { agent: string }> = [
  {
    agent: "shitao",
    week: 9,
    day: "Tue",
    startTime: "14:00",
    endTime: "15:30",
    room: null,
    reason: "Monday 5 October is the ACT Labour Day public holiday",
  },
  {
    agent: "bada",
    week: 9,
    day: "Wed",
    startTime: "15:30",
    endTime: "17:00",
    room: "Marie Reay Building (155), Room 3.05",
    reason: "Monday 5 October is the ACT Labour Day public holiday",
  },
];

function seed(): void {
  if (db.select().from(critGroups).limit(1).all().length > 0) return;
  for (const group of SEED_GROUPS) db.insert(critGroups).values(group).run();
  for (const w of SEED_WEEKS) db.insert(weeks).values(w).run();
  for (const { agent, ...exception } of SEED_EXCEPTIONS) {
    const group = db.select().from(critGroups).where(eq(critGroups.agent, agent)).get();
    if (group) db.insert(exceptions).values({ ...exception, critGroupId: group.id }).run();
  }
}

seed();

const DAY_OFFSET: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };

// The real calendar date a (week, day) pair falls on, derived from the
// week's Monday rather than stored — the same relationship the source
// JSON's own comment describes ("the cutoff moves with the session").
export function sessionDate(monday: string, day: string): string {
  const date = new Date(`${monday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (DAY_OFFSET[day] ?? 0));
  return date.toISOString().slice(0, 10);
}

export type RosterGroup = CritGroup & {
  sessions: Array<{
    week: number;
    date: string;
    day: string;
    startTime: string;
    endTime: string;
    room: string;
    reason: string | null;
    exceptionId: number | null;
  }>;
};

export function listWeeks() {
  return db.select().from(weeks).orderBy(asc(weeks.week)).all();
}

export function listRoster(): RosterGroup[] {
  const groups = db.select().from(critGroups).orderBy(asc(critGroups.day), asc(critGroups.startTime)).all();
  const allWeeks = listWeeks();
  const allExceptions = db.select().from(exceptions).all();

  return groups.map((group) => ({
    ...group,
    sessions: allWeeks.map((w) => {
      const exception = allExceptions.find((e) => e.critGroupId === group.id && e.week === w.week);
      if (exception) {
        return {
          week: w.week,
          date: sessionDate(w.monday, exception.day),
          day: exception.day,
          startTime: exception.startTime,
          endTime: exception.endTime,
          room: exception.room ?? group.room,
          reason: exception.reason,
          exceptionId: exception.id,
        };
      }
      return {
        week: w.week,
        date: sessionDate(w.monday, group.day),
        day: group.day,
        startTime: group.startTime,
        endTime: group.endTime,
        room: group.room,
        reason: null,
        exceptionId: null,
      };
    }),
  }));
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SESSION_MINUTES = 90;

export class ValidationError extends Error {}

// Thrown when the acting tutor doesn't own the crit group a write targets —
// a request the UI never offers (edit/cancel controls only render for a
// tutor's own group, see index.astro), so this only fires against a
// hand-crafted request. Kept distinct from ValidationError so the route
// handlers can answer it with a flat 403 instead of the friendly
// redirect-with-message a genuine form mistake gets.
export class PermissionError extends Error {}

// Every date a (week, day) pair can resolve to, so a raw calendar date typed
// into the reschedule form can be resolved back to the week/day pair the
// table actually keys exceptions by — the inverse of sessionDate.
export function resolveSessionDate(date: string): { week: number; day: string } | undefined {
  for (const w of listWeeks()) {
    for (const day of DAY_NAMES) {
      if (sessionDate(w.monday, day) === date) return { week: w.week, day };
    }
  }
  return undefined;
}

// Every session is exactly 90 minutes — the form only takes a start time,
// this is the one place the end time is computed from it.
function addSessionMinutes(startTime: string): string {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + SESSION_MINUTES;
  if (total >= 24 * 60) throw new ValidationError("a 90-minute session starting this late would run past midnight");
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export type AddExceptionInput = {
  critGroupId: number;
  date: string;
  startTime: string;
  room: string;
  reason: string;
  actingAgent: string;
};

// The one write this app makes to a group's schedule: reschedule a single
// week's session. Validated at this boundary — everything downstream (the
// roster view, the derived date) trusts what's in the table.
export function addException(input: AddExceptionInput): Exception {
  const group = db.select().from(critGroups).where(eq(critGroups.id, input.critGroupId)).get();
  if (!group) throw new ValidationError("unknown crit group");
  if (group.agent !== input.actingAgent) {
    throw new PermissionError(`only ${group.tutorName} can reschedule ${group.name}'s sessions`);
  }

  const resolved = resolveSessionDate(input.date);
  if (!resolved) throw new ValidationError("date must be a Mon–Fri session date within a teaching week this semester");

  if (!TIME_RE.test(input.startTime)) throw new ValidationError("start time must be a 24-hour time, e.g. 14:00");
  const endTime = addSessionMinutes(input.startTime);

  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("a reason is required");

  const existing = db
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.critGroupId, input.critGroupId), eq(exceptions.week, resolved.week)))
    .get();
  if (existing) {
    db.delete(exceptions).where(eq(exceptions.id, existing.id)).run();
  }

  return db
    .insert(exceptions)
    .values({
      critGroupId: input.critGroupId,
      week: resolved.week,
      day: resolved.day,
      startTime: input.startTime,
      endTime,
      room: input.room.trim() || null,
      reason,
    })
    .returning()
    .get();
}

export function cancelException(id: number, actingAgent: string): void {
  const exception = db.select().from(exceptions).where(eq(exceptions.id, id)).get();
  if (!exception) return;

  const group = db.select().from(critGroups).where(eq(critGroups.id, exception.critGroupId)).get();
  if (group && group.agent !== actingAgent) {
    throw new PermissionError(`only ${group.tutorName} can cancel ${group.name}'s sessions`);
  }

  db.delete(exceptions).where(eq(exceptions.id, id)).run();
}

export function getCritGroup(id: number): CritGroup | undefined {
  return db.select().from(critGroups).where(eq(critGroups.id, id)).get();
}

export function getCritGroupByAgent(agent: string): CritGroup | undefined {
  return db.select().from(critGroups).where(eq(critGroups.agent, agent)).get();
}
