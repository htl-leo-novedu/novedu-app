import { expect, test } from "@playwright/test";
import { mintSessionToken } from "./api-auth.utils";

// The proxy-matcher exclusions that had NO hermetic HTTP coverage: `/api/eval`
// and `/api/coding`. Both are listed in the `matcher` in `proxy.ts` so the
// cookie gate skips them and the route's own gate answers instead — and both
// had their gates proven only in-process (route unit tests) or behind specs
// that need a minted key or a real model. An edit dropping either exclusion
// from that regex would turn every 401 below into a 302 to the Microsoft
// sign-in page and still ship through a green CI.
//
// Table-driven on purpose: adding a bearer route here is one row, and the row
// is what proves the exclusion, so new endpoints cannot quietly land untested
// (AGENTS.md: a bearer endpoint = gate + path-bounded exclusion + docs entry).
//
// Everything here fails INSIDE the gate — `requireBearerTeacher` for eval,
// `parseBearerKey` for coding, both before any store, LLM or blob call. The
// eval token is a real better-auth session token minted straight into
// `novedu_session` (api-auth.utils.ts) — there is no test seam on this channel.

// No cookies: these must succeed or fail on the bearer credential ALONE. With a
// session cookie present, a matcher regression would be invisible; with an empty
// storage state it turns the expected 401 into a sign-in redirect.
test.use({ storageState: { cookies: [], origins: [] } });

// The Entra-bearer eval routes. Teacher-only, stateless, one request = one LLM
// call; the CLI is the only real caller (docs/cli-eval.md).
const EVAL_ROUTES = [
  { path: "/api/eval/grade", body: { subject: "x", systemPrompt: "x" } },
  { path: "/api/eval/judge", body: { subject: "x", systemPrompt: "x", criteria: ["x"] } },
  { path: "/api/eval/respond", body: { systemPrompt: "x", messages: [] } },
] as const;

for (const { path, body } of EVAL_ROUTES) {
  test(`bare POST ${path} → 401 from the route, not a sign-in redirect`, async ({ request }) => {
    const response = await request.post(path, { data: body, maxRedirects: 0 });

    expect(response.status()).toBe(401);
    // The bearer channel's marker. A sign-in redirect would be a 3xx with a
    // `location` instead, which is exactly the regression this guards.
    expect(response.headers()["www-authenticate"]).toBe("Bearer");
    expect(response.headers()).not.toHaveProperty("location");
  });

  test(`valid non-teacher token → 403 on POST ${path}`, async ({ request }) => {
    const response = await request.post(path, {
      headers: { authorization: `Bearer ${await mintSessionToken()}` },
      data: body,
    });

    expect(response.status()).toBe(403);
  });
}

// The two PUBLIC, non-Entra coding routes (AGENTS.md lists exactly two such
// surfaces besides GET /api/files). They authenticate with a per-user API key,
// so their rejection is OpenAI-shaped rather than WWW-Authenticate — but the
// "not a sign-in redirect" property is identical, and it is the whole reason
// they carry their own exclusion.
const CODING_ROUTES = [
  { method: "post" as const, path: "/api/coding/v1/chat/completions" },
  { method: "get" as const, path: "/api/coding/v1/models" },
];

for (const { method, path } of CODING_ROUTES) {
  test(`bare ${method.toUpperCase()} ${path} → OpenAI-shaped 401, not a sign-in redirect`, async ({
    request,
  }) => {
    const response = await request[method](path, { maxRedirects: 0 });

    expect(response.status()).toBe(401);
    expect(response.headers()).not.toHaveProperty("location");
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_api_key", type: "invalid_request_error" },
    });
  });
}

// The cheap key check must not be an oracle the expensive one is not: both
// routes reject through the same `lib/coding-http.ts` helper, so a caller
// cannot tell them apart. Asserted on the no-credential path, which returns
// before `lookupCodingKey` touches the database — keeping this hermetic.
test("both coding routes reject an absent key byte-identically", async ({ request }) => {
  const completions = await request.post("/api/coding/v1/chat/completions", { maxRedirects: 0 });
  const models = await request.get("/api/coding/v1/models", { maxRedirects: 0 });

  expect(completions.status()).toBe(models.status());
  expect(await completions.text()).toBe(await models.text());
});

// A non-Bearer scheme is rejected by the same path as no header at all, so it
// also never reaches the store. Proves the gate keys on the scheme, not merely
// on the header's presence.
test("a non-Bearer authorization scheme is rejected like no key at all", async ({ request }) => {
  const response = await request.get("/api/coding/v1/models", {
    headers: { authorization: "Basic ZTJlOnRlc3Q=" },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
});
