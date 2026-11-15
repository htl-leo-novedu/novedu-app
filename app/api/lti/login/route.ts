import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-origin";
import { moodleAvailable } from "@/lib/moodle-config";
import { launchEvent, notFound, plain } from "@/lib/moodle-http";
import { signMoodleToken } from "@/lib/moodle-launch";

// PUBLIC: the start of an LTI 1.3 launch (docs/moodle.md). Moodle sends the
// browser here (GET or POST) with `iss`, `client_id`, `login_hint` and
// `lti_message_hint`; Novedu answers with a redirect to Moodle's authorization
// endpoint. The login state is a signed, 10-minute token (no cookie, no table:
// Moodle's launch is a cross-site POST a Lax cookie would not survive). 404
// while the Moodle feature is not available. Never reads or creates a session.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return login(new URL(request.url).searchParams);
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const params = new URLSearchParams();
  for (const [key, value] of form?.entries() ?? []) {
    if (typeof value === "string") params.set(key, value);
  }
  return login(params);
}

async function login(params: URLSearchParams): Promise<Response> {
  const connection = await moodleAvailable();
  if (!connection) return notFound();

  const issuer = params.get("iss")?.replace(/\/+$/, "");
  const clientId = params.get("client_id");
  const loginHint = params.get("login_hint");
  if (issuer !== connection.issuer || (clientId !== null && clientId !== connection.clientId)) {
    launchEvent("login-unknown-platform");
    return plain(400, "This Moodle is not connected to Novedu.");
  }
  if (!loginHint) {
    launchEvent("login-incomplete");
    return plain(400, "The login request from Moodle is incomplete.");
  }

  const nonce = randomUUID();
  const state = await signMoodleToken("state", { nonce });
  const origin = await resolveAppOrigin();
  const target = new URL(connection.authUrl);
  const query: Record<string, string | null> = {
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: connection.clientId,
    redirect_uri: `${origin}/api/lti/launch`,
    login_hint: loginHint,
    lti_message_hint: params.get("lti_message_hint"),
    state,
    nonce,
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) target.searchParams.set(key, value);
  }
  return NextResponse.redirect(target, 302);
}
