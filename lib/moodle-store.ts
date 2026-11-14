import { and, eq, sql } from "drizzle-orm";
import { type DbExecutor, getDb } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db/errors";
import { affectedRows } from "@/lib/db/result";
import { moodleLinks, moodleTargets } from "@/lib/db/schema";
import type { LinkState } from "@/lib/moodle-launch";
import { reportStoreFailure } from "@/lib/store-failure";

// Moodle account links and hand-in targets (docs/moodle.md) — the FOURTH
// sanctioned user↔code link. The ONLY access to `novedu_moodle_links` and
// `novedu_moodle_targets`, with NO teacher reader by construction: every
// function is keyed by the session user id its caller resolved, except
// `deleteTargetsForCode` (the code-delete path), which returns nothing.
// Guard-tested (lib/moodle-store-isolation.unit.test.ts).
//
// Every statement is filtered by `issuer` — the CONFIGURED Plattform-ID, which
// the caller takes from `moodleAvailable()` — so rows of another Moodle sharing
// the database are never read or changed.
//
// Never throws (a failure is reported with a fixed message and the SQLSTATE
// only, then answered as `undefined`/`false`/"error"), except
// `deleteTargetsForCode`, which runs inside the code-delete transaction and
// must roll it back.
//
// SERVER-ONLY: uses the database. Never import from client components.

const STORE = "moodle-store";

export interface OwnLink {
  moodleUserId: string;
  linkedAt: Date;
}

/** The session user's link on this Moodle, `null` without one, `undefined` on a failure. */
export async function getOwnLink(
  issuer: string,
  userId: string,
): Promise<OwnLink | null | undefined> {
  try {
    const rows = await getDb()
      .select({ moodleUserId: moodleLinks.moodleUserId, linkedAt: moodleLinks.linkedAt })
      .from(moodleLinks)
      .where(and(eq(moodleLinks.issuer, issuer), eq(moodleLinks.userId, userId)));
    return rows[0] ?? null;
  } catch (error) {
    reportStoreFailure(STORE, "get own link", error);
    return undefined;
  }
}

/**
 * Who holds which link for an arrival: the session user's own Moodle user id,
 * and the Novedu user linked to the arriving Moodle user id. Both are compared
 * by the caller (`decideArrival`); neither ever leaves the server.
 */
export async function findLinkState(
  issuer: string,
  userId: string,
  moodleUserId: string,
): Promise<LinkState | undefined> {
  try {
    const [own, owner] = await Promise.all([
      getDb()
        .select({ moodleUserId: moodleLinks.moodleUserId })
        .from(moodleLinks)
        .where(and(eq(moodleLinks.issuer, issuer), eq(moodleLinks.userId, userId))),
      getDb()
        .select({ userId: moodleLinks.userId })
        .from(moodleLinks)
        .where(and(eq(moodleLinks.issuer, issuer), eq(moodleLinks.moodleUserId, moodleUserId))),
    ]);
    return {
      ownMoodleUserId: own[0]?.moodleUserId ?? null,
      moodleUserOwner: owner[0]?.userId ?? null,
    };
  } catch (error) {
    reportStoreFailure(STORE, "find link state", error);
    return undefined;
  }
}

export interface TargetInput {
  code: string;
  lineitemUrl: string;
}

/**
 * Upserts the hand-in target. A different grade column (another Moodle
 * activity) clears `handed_in_at`; the same one keeps it.
 */
async function upsertTarget(
  executor: DbExecutor,
  issuer: string,
  userId: string,
  target: TargetInput,
  now: Date,
): Promise<void> {
  await executor
    .insert(moodleTargets)
    .values({
      issuer,
      userId,
      code: target.code,
      lineitemUrl: target.lineitemUrl,
      arrivedAt: now,
      handedInAt: null,
    })
    .onConflictDoUpdate({
      target: [moodleTargets.issuer, moodleTargets.userId, moodleTargets.code],
      set: {
        lineitemUrl: sql`excluded.lineitem_url`,
        arrivedAt: sql`excluded.arrived_at`,
        handedInAt: sql`CASE WHEN ${moodleTargets.lineitemUrl} = excluded.lineitem_url THEN ${moodleTargets.handedInAt} ELSE NULL END`,
      },
    });
}

/**
 * The confirmed link: inserts the link and upserts the target in ONE
 * transaction. A unique violation on either key (this Novedu user or this
 * Moodle user is linked already) is a mismatch and stores nothing.
 */
export async function linkAndStoreTarget(
  issuer: string,
  userId: string,
  moodleUserId: string,
  target: TargetInput,
  now: Date = new Date(),
): Promise<"linked" | "mismatch" | "error"> {
  try {
    await getDb().transaction(async (tx) => {
      await tx.insert(moodleLinks).values({ issuer, userId, moodleUserId, linkedAt: now });
      await upsertTarget(tx, issuer, userId, target, now);
    });
    return "linked";
  } catch (error) {
    if (isUniqueViolation(error)) return "mismatch";
    reportStoreFailure(STORE, "link", error);
    return "error";
  }
}

/** The arrival of an already-linked student: upserts the target only. */
export async function storeTarget(
  issuer: string,
  userId: string,
  target: TargetInput,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await upsertTarget(getDb(), issuer, userId, target, now);
    return true;
  } catch (error) {
    reportStoreFailure(STORE, "store target", error);
    return false;
  }
}

export interface OwnTarget {
  lineitemUrl: string;
  handedInAt: Date | null;
}

/** The session user's target for `code`, `null` without one, `undefined` on a failure. */
export async function getOwnTarget(
  issuer: string,
  userId: string,
  code: string,
): Promise<OwnTarget | null | undefined> {
  try {
    const rows = await getDb()
      .select({ lineitemUrl: moodleTargets.lineitemUrl, handedInAt: moodleTargets.handedInAt })
      .from(moodleTargets)
      .where(
        and(
          eq(moodleTargets.issuer, issuer),
          eq(moodleTargets.userId, userId),
          eq(moodleTargets.code, code),
        ),
      );
    return rows[0] ?? null;
  } catch (error) {
    reportStoreFailure(STORE, "get own target", error);
    return undefined;
  }
}

/**
 * Records a hand-in — only while the target still points at the grade column
 * the score went to (an arrival from another activity in between wins).
 */
export async function markHandedIn(
  issuer: string,
  userId: string,
  target: TargetInput,
  at: Date,
): Promise<boolean> {
  try {
    const updated = await getDb()
      .update(moodleTargets)
      .set({ handedInAt: at })
      .where(
        and(
          eq(moodleTargets.issuer, issuer),
          eq(moodleTargets.userId, userId),
          eq(moodleTargets.code, target.code),
          eq(moodleTargets.lineitemUrl, target.lineitemUrl),
        ),
      );
    return affectedRows(updated) > 0;
  } catch (error) {
    reportStoreFailure(STORE, "mark handed in", error);
    return false;
  }
}

/** Unlink: deletes the session user's link and all their targets on this Moodle, together. */
export async function unlinkOwn(issuer: string, userId: string): Promise<boolean> {
  try {
    await getDb().transaction(async (tx) => {
      await tx
        .delete(moodleTargets)
        .where(and(eq(moodleTargets.issuer, issuer), eq(moodleTargets.userId, userId)));
      await tx
        .delete(moodleLinks)
        .where(and(eq(moodleLinks.issuer, issuer), eq(moodleLinks.userId, userId)));
    });
    return true;
  } catch (error) {
    reportStoreFailure(STORE, "unlink", error);
    return false;
  }
}

/**
 * The code delete (lib/code-stats-store.ts): drops every target of `code`, on
 * every Moodle site. Returns nothing; throws so the delete rolls back.
 */
export async function deleteTargetsForCode(executor: DbExecutor, code: string): Promise<void> {
  await executor.delete(moodleTargets).where(eq(moodleTargets.code, code));
}
