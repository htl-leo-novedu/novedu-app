"use server";

import { after } from "next/server";
import { verifyStudentActivity } from "@/lib/activity-gate";
import { recordWritingSave } from "@/lib/usage-store";
import { loadWriting } from "@/lib/writing-fetch";
import { saveSubmission } from "@/lib/writing-store";

// The student-facing writing server action. The whole app sits behind the Entra
// gate, so any caller is authenticated; the writing CODE (a `novedu_codes` row
// with `module: "writing"`) is what authorizes the activity, and it is
// RE-VERIFIED on every save (so a code outside its window stops accepting saves
// mid-session). A student may write ONLY their own `(code, user_id)` row — the
// row key is the session user id, never client-supplied.
//
// Writing DEFAULTS `anonymous: false` (the writing divergence): saving needs
// attribution. As defense in depth this action re-reads the privacy flag LIVE
// from the YAML and REJECTS the save when the activity is anonymous, so an
// anonymous writing code never accumulates attributed rows even if the client
// tries.

export interface SaveWritingInput {
  code: string;
  text: string;
}

export type SaveWritingResult = { ok: true } | { ok: false; message: string };

/**
 * Saves a student's writing text for a code. Resolves the authenticated session user
 * id as the row owner and re-verifies the code is valid, in its window and a writing
 * code (the shared student gate), re-reads the activity's `anonymous` flag LIVE
 * (rejecting an anonymous activity), then upserts the student's single row. Nothing
 * is graded or echoed back.
 */
export async function saveWriting(input: SaveWritingInput): Promise<SaveWritingResult> {
  const text = typeof input.text === "string" ? input.text.trim() : "";

  const gate = await verifyStudentActivity(input.code, "writing");
  if (!gate.ok) return gate;
  const { userId, entry } = gate;

  // Re-read the privacy flag LIVE from the YAML (defense in depth): an anonymous
  // writing activity never stores attributed text, so saving is disabled for it.
  const loaded = await loadWriting(entry.fileUrl);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  if (loaded.writing.anonymous) {
    return { ok: false, message: "This writing activity does not save your text." };
  }

  try {
    await saveSubmission({ code: entry.code, userId, text });
    // Count the save off the response path (the store never throws).
    after(() => recordWritingSave({ code: entry.code, userId }));
    return { ok: true };
  } catch (error) {
    console.error("writing-actions: saving a submission failed", error);
    return { ok: false, message: "Your text could not be saved right now. Please try again." };
  }
}
