import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The cookie-session byte route. Pins the gate order (session → id shape → active
// row → object), the shared authenticated-asset policy (a STUDENT session is
// enough; no code or thread token is consulted), the status matrix, the six
// response headers (the hardening ones on every failure too), and that a
// conditional request still pays for the session and row checks. The session,
// the store and the adapter are mocked.

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveImageById: vi.fn(),
  openObject: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/image-store", () => ({ getActiveImageById: mocks.getActiveImageById }));
vi.mock("@/lib/image-fs", () => ({ openObject: mocks.openObject }));

import { GET } from "./route";

const ID = "11111111-2222-3333-4444-555555555555";
const PAYLOAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function session(isTeacher: boolean) {
  return { session: { id: "s1" }, user: { id: "u1", name: "U", isTeacher } };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "diagram",
    blobPath: "11111111-2222-3333-4444-555555555555.png",
    mimeType: "image/png",
    byteSize: PAYLOAD.byteLength,
    credit: null,
    validFrom: new Date("2026-07-07T08:00:00Z"),
    createdBy: "teacher-1",
    ...overrides,
  };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function get(id = ID, headers: HeadersInit = {}) {
  return GET(new Request(`http://localhost/api/image-content/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

// Every failure response carries the same hardening headers as a success.
function expectFailureHeaders(res: Response) {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(res.headers.get("cache-control")).toBe("no-store");
}

beforeEach(() => {
  mocks.getSession.mockResolvedValue(session(false));
  mocks.getActiveImageById.mockResolvedValue(row());
  mocks.openObject.mockResolvedValue({
    ok: true,
    stream: stream(PAYLOAD),
  });
});

describe("GET /api/image-content/<id> — access", () => {
  it("401s without a session and never touches the store", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expectFailureHeaders(res);
    expect(await res.json()).toEqual({ message: "Unauthorized" });
    expect(mocks.getActiveImageById).not.toHaveBeenCalled();
    expect(mocks.openObject).not.toHaveBeenCalled();
  });

  it("503s when the session lookup itself throws (fails closed, no store touch)", async () => {
    mocks.getSession.mockRejectedValue(new Error("auth db down"));
    const res = await get();
    expect(res.status).toBe(503);
    expectFailureHeaders(res);
    expect(mocks.getActiveImageById).not.toHaveBeenCalled();
  });

  it("serves a STUDENT session — hosted images are shared authenticated assets", async () => {
    mocks.getSession.mockResolvedValue(session(false));
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("serves a teacher session the same way", async () => {
    mocks.getSession.mockResolvedValue(session(true));
    const res = await get();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/image-content/<id> — lookup", () => {
  it("404s a malformed id without a store call", async () => {
    for (const bad of ["not-a-uuid", "..%2Fetc%2Fpasswd", `${ID}x`]) {
      const res = await get(bad);
      expect(res.status).toBe(404);
      expectFailureHeaders(res);
    }
    expect(mocks.getActiveImageById).not.toHaveBeenCalled();
  });

  it("404s a closed / unknown row", async () => {
    mocks.getActiveImageById.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expectFailureHeaders(res);
    expect(mocks.openObject).not.toHaveBeenCalled();
  });

  it("404s a closed row for a CONDITIONAL request too", async () => {
    mocks.getActiveImageById.mockResolvedValue(null);
    const res = await get(ID, { "if-none-match": `"${ID}"` });
    expect(res.status).toBe(404);
    expectFailureHeaders(res);
  });

  it("503s when the store is unreachable", async () => {
    mocks.getActiveImageById.mockResolvedValue(undefined);
    const res = await get();
    expect(res.status).toBe(503);
    expectFailureHeaders(res);
    expect(mocks.openObject).not.toHaveBeenCalled();
  });

  it("404s when the row's object is gone", async () => {
    mocks.openObject.mockResolvedValue({ ok: true, missing: true });
    const res = await get();
    expect(res.status).toBe(404);
    expectFailureHeaders(res);
  });

  it("503s when the storage root is unavailable", async () => {
    mocks.openObject.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      detail: "/novedu-files does not exist.",
    });
    const res = await get();
    expect(res.status).toBe(503);
    expectFailureHeaders(res);
  });
});

describe("GET /api/image-content/<id> — response", () => {
  it("streams the exact bytes with the ROW's MIME", async () => {
    mocks.getActiveImageById.mockResolvedValue(row({ mimeType: "image/svg+xml" }));
    const res = await get();

    expect(res.status).toBe(200);
    expect(mocks.openObject).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555.png");
    // The declared MIME comes from the row, never from sniffing the bytes.
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PAYLOAD);
  });

  it("carries all five headers on a 200", async () => {
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBe(`"${ID}"`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  it("answers 304 for a matching If-None-Match — after the session and row checks", async () => {
    const res = await get(ID, { "if-none-match": `"${ID}"` });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${ID}"`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(mocks.getSession).toHaveBeenCalled();
    expect(mocks.getActiveImageById).toHaveBeenCalledWith(ID);
    // The bytes are never opened for a revalidation.
    expect(mocks.openObject).not.toHaveBeenCalled();
  });

  it("ignores a non-matching If-None-Match and serves the bytes", async () => {
    const res = await get(ID, { "if-none-match": '"some-other-id"' });
    expect(res.status).toBe(200);
    expect(mocks.openObject).toHaveBeenCalled();
  });
});

// The route deliberately has NO proxy exclusion: it is a cookie-session route,
// so a browser with no cookie is redirected to sign-in before it ever arrives.
describe("the proxy matcher", () => {
  it("does not exclude api/image-content", () => {
    const matcher = readFileSync("proxy.ts", "utf8").match(/matcher:\s*\[([\s\S]*?)\]/)?.[1];
    expect(matcher).toBeDefined();
    // The sibling `api/images` exclusion is anchored, so it cannot widen to this
    // route — and no exclusion of its own exists.
    expect(matcher).toContain("api/images(?:/|$)");
    expect(matcher).not.toContain("image-content");
  });
});
