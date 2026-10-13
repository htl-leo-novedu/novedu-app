import { expect, test } from "@playwright/test";
import { mintSessionToken } from "./api-auth.utils";

// The /api/codes bearer channel's ACCESS CONTROL over real HTTP: the
// proxy-matcher exclusion (a bare request gets 401 from the route, not a
// sign-in redirect) and the teacher requirement (403 for a valid non-teacher
// token) — for GET and POST alike. The bearer PUT on the public /api/files
// prefix is probed too: the GET being public must never extend to writes.
// Everything DB-backed (actually listing/creating) lives in the @live-db
// lifecycle spec (api-management.live.spec.ts); every assertion here fails
// inside the gate, before any code store call. The bearer credential is a real
// better-auth session token minted straight into `novedu_session`
// (api-auth.utils.ts) — there is no test seam on this channel.

// No cookies: these requests must succeed or fail on the bearer token ALONE. A
// proxy-matcher regression would turn the expected 401 into a sign-in redirect.
test.use({ storageState: { cookies: [], origins: [] } });

test("bare GET /api/codes → 401 with WWW-Authenticate, not a sign-in redirect", async ({
  request,
}) => {
  const response = await request.get("/api/codes", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toBe("Bearer");
});

test("bare POST /api/codes → 401, not a sign-in redirect", async ({ request }) => {
  const response = await request.post("/api/codes", {
    data: { module: "tutor", fileUrl: "https://example.com/t.yaml" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(401);
});

test("valid non-teacher token → 403 on GET and POST /api/codes", async ({ request }) => {
  const token = await mintSessionToken();
  const list = await request.get("/api/codes", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(list.status()).toBe(403);

  const create = await request.post("/api/codes", {
    headers: { authorization: `Bearer ${token}` },
    data: { module: "tutor", fileUrl: "https://example.com/t.yaml" },
  });
  expect(create.status()).toBe(403);
});

// The per-code conversation export rides the same `api/codes(?:/|$)` exclusion;
// this pair is what keeps a sub-path from ever falling back to the session gate.
test("bare GET /api/codes/<code>/conversations → 401, not a sign-in redirect", async ({
  request,
}) => {
  const response = await request.get("/api/codes/x/conversations", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toBe("Bearer");
  expect(response.headers()).not.toHaveProperty("location");
});

test("valid non-teacher token → 403 on GET /api/codes/<code>/conversations", async ({
  request,
}) => {
  const token = await mintSessionToken();
  const response = await request.get("/api/codes/x/conversations", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(403);
});

test("bare GET /api/files/<name> → 401 — uploaded YAML is teacher-only", async ({ request }) => {
  const response = await request.get("/api/files/e2e-api-gate-probe", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toBe("Bearer");
});

test("valid non-teacher token → 403 on GET /api/files/<name>", async ({ request }) => {
  const token = await mintSessionToken();
  const response = await request.get("/api/files/e2e-api-gate-probe", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(403);
});

test("bare PUT /api/files/<name> → 401", async ({ request }) => {
  const response = await request.put("/api/files/e2e-api-gate-probe", {
    data: { kind: "fragment", content: "id: x\n" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toBe("Bearer");
});

test("bare GET /api/files (list) → 401", async ({ request }) => {
  const response = await request.get("/api/files", { maxRedirects: 0 });
  expect(response.status()).toBe(401);
});
