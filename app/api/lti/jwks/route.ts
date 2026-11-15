import { publicJwks } from "@/lib/moodle-config";

// PUBLIC, unauthenticated: Novedu's public LTI key as a JWK set, fetched by
// Moodle's server when Novedu asks for a grade-service token (docs/moodle.md).
// Needs only the key, not the connection: the Moodle admin registers Novedu
// before Moodle's values exist. Without a usable key it answers 404. Excluded
// from the cookie gate by `api/lti(?:/|$)` in proxy.ts; it never reads a session.
export const dynamic = "force-dynamic";

export async function GET() {
  const jwks = await publicJwks();
  if (!jwks) return new Response("Not found", { status: 404 });
  return Response.json(jwks, { headers: { "cache-control": "no-store" } });
}
