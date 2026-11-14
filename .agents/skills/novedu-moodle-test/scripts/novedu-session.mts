// Mints (or deletes) a throwaway Novedu student for a Moodle check, using the e2e
// suite's own helpers, and prints the session cookie value student-launch.mjs needs.
// Runs against the DATABASE_URL in the environment (else `.env`) — the same database
// the local Novedu runs on.
//
//   npx tsx .agents/skills/novedu-moodle-test/scripts/novedu-session.mts "Mia Moodle"
//   npx tsx .agents/skills/novedu-moodle-test/scripts/novedu-session.mts --delete <user-id>
import { randomUUID } from "node:crypto";
import { authSecret, deletePrincipal, mintSession } from "../../../../e2e/principal.utils";
import { sessionCookieValue } from "../../../../e2e/session-cookie";

const [first, second] = process.argv.slice(2);
if (first === "--delete" && second) {
  await deletePrincipal(second);
  console.log(`deleted ${second}`);
} else {
  const id = `e2e-moodle-${randomUUID()}`;
  const principal = { id, name: first ?? "Moodle Check", email: `${id}@example.com` };
  const token = await mintSession(principal, false);
  console.log(JSON.stringify({ userId: id, cookie: await sessionCookieValue(token, authSecret()) }));
}
process.exit(0);
