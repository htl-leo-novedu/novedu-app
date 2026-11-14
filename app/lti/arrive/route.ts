import type { NextRequest } from "next/server";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { checkArrival } from "@/lib/moodle-arrival";
import { seeOther } from "@/lib/moodle-http";
import { ARRIVAL_COOKIE, donePath } from "@/lib/moodle-launch";
import { storeTarget } from "@/lib/moodle-store";
import { getSession } from "@/lib/session";
import { emitEvent } from "@/lib/telemetry";

// Where a learner lands after Moodle's launch (docs/moodle.md). A gated ROUTE
// HANDLER, not a page, because the arrival cookie must be cleared on every
// outcome and a page cannot delete a cookie while it renders. Without a session
// it sends the student to sign-in and back here (the cookie waits in the same
// browser). With one it checks the signed arrival cookie and decides:
//   - this Novedu account is linked to this Moodle account → store the hand-in
//     target, clear the cookie, open the quiz;
//   - no link on either side → the confirmation page `/lti/link` (the cookie stays);
//   - anything else → clear the cookie and show `/lti/done` with the matching message.
// Nothing personal ever travels in the address.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const origin = await resolveAppOriginOr(new URL(request.url).origin);
  const userId = (await getSession())?.user?.id;
  if (!userId) return seeOther(origin, "/sign-in?callbackURL=%2Flti%2Farrive");

  const check = await checkArrival(userId, request.cookies.get(ARRIVAL_COOKIE)?.value);
  if (check.decision === "confirm") return seeOther(origin, "/lti/link");

  let path: string;
  if (check.decision === "linked") {
    const { connection, arrival } = check;
    const stored = await storeTarget(connection.issuer, userId, {
      code: arrival.code,
      lineitemUrl: arrival.lineitem,
    });
    path = stored ? `/${arrival.code}` : donePath("unavailable", arrival.code);
    emitEvent("moodle.link", { "novedu.moodle.outcome": stored ? "arrived" : "unavailable" });
  } else {
    path = donePath(check.decision, check.arrival?.code);
    emitEvent("moodle.link", { "novedu.moodle.outcome": check.decision });
  }

  const response = seeOther(origin, path);
  response.cookies.delete({ name: ARRIVAL_COOKIE, path: "/lti" });
  return response;
}
