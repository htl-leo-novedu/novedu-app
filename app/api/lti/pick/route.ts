import { randomUUID } from "node:crypto";
import { resolveAppOrigin } from "@/lib/app-origin";
import { extractCode } from "@/lib/code-input";
import { getCode } from "@/lib/code-store";
import { moodleAvailable, signWithToolKey } from "@/lib/moodle-config";
import { notFound, seeOther } from "@/lib/moodle-http";
import { deepLinkingResponseClaims, verifyMoodleToken } from "@/lib/moodle-launch";
import { emitEvent } from "@/lib/telemetry";

// PUBLIC: the code picker's answer to Moodle (docs/moodle.md). A route handler,
// not a server action: it answers with a tiny HTML page that posts the signed
// `LtiDeepLinkingResponse` (field `JWT`) back to Moodle's return URL — taken
// from the signed pick token, never from the form. It checks the code exists, is
// a quiz and has the Moodle switch on — not its availability window — and on a
// wrong code redirects back to the picker with a fixed error key. Never reads
// or creates a session. 404 while the Moodle feature is not available.
export const dynamic = "force-dynamic";

function pickEvent(outcome: string): void {
  emitEvent("moodle.pick", { "novedu.moodle.outcome": outcome });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function POST(request: Request) {
  const connection = await moodleAvailable();
  if (!connection) return notFound();
  const origin = await resolveAppOrigin();

  const form = await request.formData().catch(() => null);
  const token = form?.get("t");
  const pick = await verifyMoodleToken("pick", token);
  if (!pick || typeof token !== "string") {
    pickEvent("expired");
    return seeOther(origin, "/lti/pick");
  }
  const back = (error: string) => {
    pickEvent(error);
    return seeOther(origin, `/lti/pick?${new URLSearchParams({ t: token, error })}`);
  };

  const input = form?.get("code");
  const code = typeof input === "string" ? extractCode(input) : undefined;
  if (!code) return back("unknown");
  const entry = await getCode(code);
  if (entry === undefined) return back("unavailable");
  if (entry === null) return back("unknown");
  if (entry.module !== "quiz") return back("not-quiz");
  if (!entry.moodle) return back("not-enabled");

  const jwt = await signWithToolKey(
    deepLinkingResponseClaims({
      connection,
      origin,
      code: entry.code,
      note: entry.note,
      data: pick.data,
      nonce: randomUUID(),
    }),
    connection.issuer,
  );
  pickEvent("picked");
  const html = `<!doctype html><meta charset="utf-8"><title>Novedu</title>
<form id="f" method="post" action="${escapeHtml(pick.returnUrl)}"><input type="hidden" name="JWT" value="${escapeHtml(jwt)}"><noscript><button type="submit">Continue to Moodle</button></noscript></form>
<script>document.getElementById("f").submit()</script>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
