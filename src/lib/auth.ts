// There's no login system yet. Until there is, every request is treated as
// this one tutor, identified the same way the schema already identifies a
// crit group: its agent slug. Every call site that needs "who's asking"
// reads it through here rather than assuming a group id directly, so wiring
// up real auth later (a session, a cookie) means changing this one function,
// not the permission checks in src/lib/db.ts or the route handlers that call
// them.
const CURRENT_TUTOR_AGENT = "baishi";

export function currentTutorAgent(): string {
  return CURRENT_TUTOR_AGENT;
}
