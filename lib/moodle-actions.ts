"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkArrival } from "@/lib/moodle-arrival";
import { moodleAvailable } from "@/lib/moodle-config";
import { ARRIVAL_COOKIE, donePath } from "@/lib/moodle-launch";
import { linkAndStoreTarget, storeTarget, unlinkOwn } from "@/lib/moodle-store";
import { getSession } from "@/lib/session";
import { emitEvent } from "@/lib/telemetry";

// The Moodle server actions (docs/moodle.md). Every action acts on the SESSION
// user only. The two confirmation-page actions read the signed arrival cookie
// AGAIN (never a form field), re-run the arrival check, clear the cookie and
// redirect. No type re-exports here: a `"use server"` module may export async
// functions only.

const NOT_SIGNED_IN = "Please sign in to continue.";

export type UnlinkResult = { ok: true } | { ok: false; message: string };

function linkEvent(outcome: string): void {
  emitEvent("moodle.link", { "novedu.moodle.outcome": outcome });
}

async function clearArrival(): Promise<void> {
  (await cookies()).delete({ name: ARRIVAL_COOKIE, path: "/lti" });
}

/** "Yes, these are both me": links the two accounts and stores the hand-in target. */
export async function confirmMoodleLink(): Promise<void> {
  const userId = (await getSession())?.user?.id;
  if (!userId) redirect("/sign-in?callbackURL=%2Flti%2Farrive");

  const jar = await cookies();
  const check = await checkArrival(userId, jar.get(ARRIVAL_COOKIE)?.value);
  let path: string;
  if (check.decision === "confirm" || check.decision === "linked") {
    const { connection, arrival } = check;
    const target = { code: arrival.code, lineitemUrl: arrival.lineitem };
    const outcome =
      check.decision === "linked"
        ? (await storeTarget(connection.issuer, userId, target))
          ? "linked"
          : "error"
        : await linkAndStoreTarget(connection.issuer, userId, arrival.sub, target);
    linkEvent(outcome === "linked" ? "confirmed" : outcome);
    path =
      outcome === "linked"
        ? `/${arrival.code}`
        : donePath(outcome === "mismatch" ? "mismatch-moodle" : "unavailable", arrival.code);
  } else {
    linkEvent(check.decision);
    path = donePath(check.decision, check.arrival?.code);
  }
  await clearArrival();
  redirect(path);
}

/** "That's not me": stores nothing. */
export async function declineMoodleLink(): Promise<void> {
  const userId = (await getSession())?.user?.id;
  if (!userId) redirect("/sign-in?callbackURL=%2Flti%2Farrive");
  const check = await checkArrival(userId, (await cookies()).get(ARRIVAL_COOKIE)?.value);
  linkEvent("declined");
  await clearArrival();
  redirect(donePath("declined", check.arrival?.code));
}

/** Settings → "Unlink my Moodle account": deletes the session user's link and all their targets. */
export async function unlinkMoodleAccount(): Promise<UnlinkResult> {
  const userId = (await getSession())?.user?.id;
  if (!userId) return { ok: false, message: NOT_SIGNED_IN };
  const connection = await moodleAvailable();
  if (!connection) {
    return { ok: false, message: "Moodle hand-in is not set up on this Novedu." };
  }
  if (!(await unlinkOwn(connection.issuer, userId))) {
    return {
      ok: false,
      message: "Your Moodle account could not be unlinked right now. Please try again.",
    };
  }
  linkEvent("unlinked");
  revalidatePath("/settings");
  return { ok: true };
}
