import { resolveAppOrigin } from "@/lib/app-origin";
import { getCode } from "@/lib/code-store";
import { moodleAvailable } from "@/lib/moodle-config";
import { launchEvent, moodleKeySet, notFound, plain, seeOther } from "@/lib/moodle-http";
import {
  ARRIVAL_COOKIE,
  ARRIVAL_TTL_SECONDS,
  readLaunch,
  signMoodleToken,
  verifyMoodleToken,
} from "@/lib/moodle-launch";

// PUBLIC: Moodle's signed launch message arrives here (the "Tool URL" and the
// redirect URI; docs/moodle.md). It verifies the login state and Moodle's
// `id_token`, then redirects:
//   - a deep-linking request (the teacher's "Select content") → the code picker;
//   - a learner's launch of a Moodle-enabled code with a grade column → sets the
//     signed arrival cookie and goes to `/lti/arrive`, which needs a session;
//   - anything else with a code → `/<code>` (nothing stored); no code → `/`.
// The only database read is the code row. Never reads or creates a session,
// and never logs a claim. 404 while the Moodle feature is not available.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const connection = await moodleAvailable();
  if (!connection) return notFound();

  const form = await request.formData().catch(() => null);
  const state = await verifyMoodleToken("state", form?.get("state"));
  if (!state) {
    launchEvent("state-invalid");
    return plain(401, "This launch from Moodle has expired. Open the activity in Moodle again.");
  }

  const message = await readLaunch(
    form?.get("id_token"),
    connection,
    state.nonce,
    moodleKeySet(connection.jwksUrl),
  );
  const origin = await resolveAppOrigin();

  if (message.kind === "refused") {
    launchEvent(`refused-${message.reason}`);
    return plain(
      message.reason === "token" ? 401 : 400,
      "Novedu could not accept this launch from Moodle.",
    );
  }

  if (message.kind === "deep-link") {
    launchEvent("deep-link");
    const pick = await signMoodleToken("pick", message.pick);
    return seeOther(origin, `/lti/pick?${new URLSearchParams({ t: pick })}`);
  }

  if (message.code === null) {
    launchEvent("no-code");
    return seeOther(origin, "/");
  }
  const quizPath = `/${message.code}`;
  const entry = await getCode(message.code);
  if (!entry || !entry.moodle) {
    launchEvent(entry === undefined ? "code-unavailable" : "code-not-enabled");
    return seeOther(origin, quizPath);
  }
  if (!message.learner || !message.arrival) {
    launchEvent(message.learner ? "no-lineitem" : "not-learner");
    return seeOther(origin, quizPath);
  }

  const arrival = await signMoodleToken("arrival", { ...message.arrival, code: entry.code });
  const response = seeOther(origin, "/lti/arrive");
  response.cookies.set(ARRIVAL_COOKIE, arrival, {
    httpOnly: true,
    sameSite: "lax",
    path: "/lti",
    maxAge: ARRIVAL_TTL_SECONDS,
    secure: origin.startsWith("https:"),
  });
  launchEvent("arrival");
  return response;
}
