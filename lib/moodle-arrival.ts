import { createHash } from "node:crypto";
import { getCode } from "@/lib/code-store";
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

/**
 * `code-off`: the code was deleted or its Moodle switch turned off since the
 * launch — open the quiz page, store nothing.
 */
export type ArrivalCheck =
  | {
      decision: ArrivalDecision;
      connection: MoodleConnection;
      arrival: ArrivalToken;
    }
  | {
      decision: "expired" | "unavailable" | "code-off";
      connection?: undefined;
      arrival?: ArrivalToken;
    };

/** Checks the arrival in `cookieValue` for the signed-in `userId`. Never throws. */
export async function checkArrival(userId: string, cookieValue: unknown): Promise<ArrivalCheck> {
  const arrival = await verifyMoodleToken("arrival", cookieValue);
  const connection = await moodleAvailable();
  if (!connection || !arrival) return { decision: "expired", arrival };
  const links = await findLinkState(connection.issuer, userId, arrival.sub);
  if (!links) return { decision: "unavailable", arrival };
  const decision = decideArrival(userId, arrival, links);
  if (decision === "linked" || decision === "confirm") {
    // Re-read the code row before anything is stored for it: the cookie is up
    // to 15 minutes old.
    const entry = await getCode(arrival.code);
    if (entry === undefined) return { decision: "unavailable", arrival };
    if (!entry?.moodle) return { decision: "code-off", arrival };
  }
  return { decision, connection, arrival };
}

/**
 * A short fingerprint of the arrival cookie the confirmation page showed, sent
 * back with "Yes, these are both me": if another launch replaced the cookie in
 * between, the confirmation is shown again for the new arrival instead of
 * linking an account the student never saw.
 */
export function arrivalFingerprint(cookieValue: string | undefined): string {
  return createHash("sha256")
    .update(cookieValue ?? "")
    .digest("hex")
    .slice(0, 32);
}
