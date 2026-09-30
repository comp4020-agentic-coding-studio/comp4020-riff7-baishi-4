import type { APIRoute } from "astro";
import { currentTutorAgent } from "../../lib/auth";
import { PermissionError, ValidationError, addException } from "../../lib/db";
import { bus } from "../../lib/events";

// The write half of the roster: reschedule one crit group's session for one
// teaching week. A plain HTML form POSTs here; the 303 redirect makes it
// work with no client-side JavaScript — the submitting tab re-renders from
// SQLite, and every other open tab hears about the change over the SSE
// stream (see api/events.ts) and reloads to pick it up.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();

  try {
    addException({
      critGroupId: Number(field("critGroupId")),
      date: field("date"),
      startTime: field("startTime"),
      room: field("room"),
      reason: field("reason"),
      actingAgent: currentTutorAgent(),
    });
  } catch (error) {
    // A PermissionError only reaches here from a hand-crafted request — the
    // form never submits a critGroupId other than the signed-in tutor's own
    // — so it gets a flat 403, not the friendly redirect a genuine mistake
    // (a bad date, a missing reason) gets from ValidationError.
    if (error instanceof PermissionError) {
      return new Response(error.message, { status: 403 });
    }
    if (error instanceof ValidationError) {
      return redirect(`/?error=${encodeURIComponent(error.message)}`, 303);
    }
    throw error;
  }

  bus.emit("changed");
  return redirect("/", 303);
};
