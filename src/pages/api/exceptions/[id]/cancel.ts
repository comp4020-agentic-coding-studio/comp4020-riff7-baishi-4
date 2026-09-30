import type { APIRoute } from "astro";
import { currentTutorAgent } from "../../../../lib/auth";
import { PermissionError, cancelException } from "../../../../lib/db";
import { bus } from "../../../../lib/events";

// Reverting a reschedule: delete the one week's exception row, which drops
// that group's roster row back to its standing slot (listRoster falls back
// to the group's own day/time/room whenever no exception matches the week).
export const POST: APIRoute = async ({ params, redirect }) => {
  const id = Number(params.id);
  if (Number.isInteger(id)) {
    try {
      cancelException(id, currentTutorAgent());
    } catch (error) {
      // Only a hand-crafted request reaches this — the cancel button never
      // renders for a session outside the signed-in tutor's own group.
      if (error instanceof PermissionError) {
        return new Response(error.message, { status: 403 });
      }
      throw error;
    }
    bus.emit("changed");
  }
  return redirect("/", 303);
};
