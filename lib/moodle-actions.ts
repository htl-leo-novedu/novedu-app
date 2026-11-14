"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CODE_REJECTION_MESSAGES } from "@/lib/activity-gate";
import { postScore } from "@/lib/moodle-ags";
import { checkArrival } from "@/lib/moodle-arrival";
import { moodleAvailable } from "@/lib/moodle-config";
import { ARRIVAL_COOKIE, donePath } from "@/lib/moodle-launch";
import { countReceipts, getReceiptSecret } from "@/lib/moodle-receipt";
import { moodleComment, moodlePercent, moodleScore } from "@/lib/moodle-score";
import {
  getOwnLink,
  getOwnTarget,
  linkAndStoreTarget,
  markHandedIn,
  storeTarget,
  unlinkOwn,
} from "@/lib/moodle-store";
import { attemptLength, verifyAndLoadQuiz } from "@/lib/quiz-verify";
import { getSession } from "@/lib/session";
import { emitEvent } from "@/lib/telemetry";

// The Moodle server actions (docs/moodle.md). Every action acts on the SESSION
// user only. The two confirmation-page actions read the signed arrival cookie
// AGAIN (never a form field), re-run the arrival check, clear the cookie and
// redirect. No type re-exports here: a `"use server"` module may export async
// functions only.

const NOT_SIGNED_IN = "Please sign in to continue.";

export type UnlinkResult = { ok: true } | { ok: false; message: string };

/** `retry`: whether "Try again" can help (Moodle unreachable, the activity gone). */
export type HandInResult =
  | { ok: true; handedInAt: string; percent: number }
  | { ok: false; message: string; retry: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNREACHABLE = "Moodle could not be reached right now. Please try again.";
const ACTIVITY_GONE = "This activity no longer exists in Moodle. Ask your teacher.";
const QUIZ_ENDED = "This quiz has ended, so the result can't be handed in.";
const REFUSED = "This result can't be handed in.";

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

function handInEvent(outcome: string): void {
  emitEvent("moodle.handin", { "novedu.moodle.outcome": outcome });
}

function refuse(outcome: string, message: string, retry: boolean): HandInResult {
  handInEvent(outcome);
  return { ok: false, message, retry };
}

/**
 * The Finish page's "Hand in": counts the attempt from its signed receipts on
 * the server and posts the score to the student's hand-in target. In order: the
 * quiz preamble (session, the code re-checked, the quiz re-loaded); Moodle
 * available, the code switched on, the session user linked with a target for
 * this code; every receipt verified (the whole call is refused on any bad one,
 * never clamped); the score posted; on Moodle's success, the time recorded.
 */
export async function handInToMoodle(input: {
  code: string;
  attemptId: string;
  receipts: unknown;
}): Promise<HandInResult> {
  if (typeof input?.attemptId !== "string" || !UUID.test(input.attemptId)) {
    return refuse("invalid", REFUSED, false);
  }
  const ctx = await verifyAndLoadQuiz({ code: input.code });
  if (!ctx.ok) {
    if (ctx.message === CODE_REJECTION_MESSAGES.expired) return refuse("ended", QUIZ_ENDED, false);
    const retry = ctx.message === CODE_REJECTION_MESSAGES["lookup-failed"];
    return refuse("quiz-refused", ctx.message, retry);
  }

  const connection = await moodleAvailable();
  if (!connection) {
    return refuse("unavailable", "Hand-in to Moodle is not set up on this Novedu.", false);
  }
  if (!ctx.moodle) {
    return refuse("switched-off", "Hand-in to Moodle is switched off for this quiz.", false);
  }
  const [link, target] = await Promise.all([
    getOwnLink(connection.issuer, ctx.userId),
    getOwnTarget(connection.issuer, ctx.userId, ctx.code),
  ]);
  if (link === undefined || target === undefined) return refuse("store", UNREACHABLE, true);
  if (!link || !target) {
    return refuse("no-target", "Open this quiz from Moodle to hand in a result.", false);
  }

  const total = attemptLength(ctx.quiz);
  const counted = countReceipts(
    input.receipts,
    { code: ctx.code, userId: ctx.userId, attemptId: input.attemptId.toLowerCase() },
    { attemptLength: total, poolSize: ctx.quiz.questions.length },
    getReceiptSecret(),
  );
  if (!counted.ok) return refuse("receipts", REFUSED, false);

  const now = new Date();
  const posted = await postScore(
    connection,
    target.lineitemUrl,
    {
      userId: link.moodleUserId,
      scoreGiven: moodleScore(counted.counts),
      scoreMaximum: total,
      comment: moodleComment(counted.counts, total),
    },
    now,
  );
  if (posted === "not-found") return refuse("not-found", ACTIVITY_GONE, true);
  if (posted === "failed") return refuse("failed", UNREACHABLE, true);

  // Moodle has the score; a failed bookkeeping write only loses the "already
  // handed in" note, never the hand-in itself.
  await markHandedIn(
    connection.issuer,
    ctx.userId,
    { code: ctx.code, lineitemUrl: target.lineitemUrl },
    now,
  );
  handInEvent("ok");
  return { ok: true, handedInAt: now.toISOString(), percent: moodlePercent(counted.counts, total) };
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
  // No revalidation: the Settings section stays mounted to confirm the unlink,
  // and is gone on the next visit (it renders only while a link exists).
  linkEvent("unlinked");
  return { ok: true };
}
