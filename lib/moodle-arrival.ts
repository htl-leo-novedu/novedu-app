import type { MoodleConnection } from "@/lib/moodle-config";
import { moodleAvailable } from "@/lib/moodle-config";
import {
  type ArrivalDecision,
  type ArrivalToken,
  decideArrival,
  verifyMoodleToken,
} from "@/lib/moodle-launch";
import { findLinkState } from "@/lib/moodle-store";

// The one arrival check (docs/moodle.md), shared by `/lti/arrive`, the
// confirmation page and its two actions: the signed arrival cookie, the
// availability of the feature, both directions of the account link, and the
// decision. The callers own the cookie and the redirects.
//
// SERVER-ONLY.

export type ArrivalCheck =
  | {
      decision: ArrivalDecision;
      connection: MoodleConnection;
      arrival: ArrivalToken;
    }
  | { decision: "expired" | "unavailable"; connection?: undefined; arrival?: ArrivalToken };

/** Checks the arrival in `cookieValue` for the signed-in `userId`. Never throws. */
export async function checkArrival(userId: string, cookieValue: unknown): Promise<ArrivalCheck> {
  const arrival = await verifyMoodleToken("arrival", cookieValue);
  const connection = await moodleAvailable();
  if (!connection || !arrival) return { decision: "expired", arrival };
  const links = await findLinkState(connection.issuer, userId, arrival.sub);
  if (!links) return { decision: "unavailable", arrival };
  return { decision: decideArrival(userId, arrival, links), connection, arrival };
}
