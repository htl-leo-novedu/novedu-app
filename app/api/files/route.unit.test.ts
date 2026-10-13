import { beforeEach, describe, expect, it, vi } from "vitest";

// The bearer file-list route: real auth gate over a stubbed `getSession`, mocked
// store. Pins the 401/403 matrix, the /files page's filter parsing (mine
// default ON), the 503 mapping, and the wire shape (public download url,
// createdAt = the active version's validFrom, no content).

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  resolveAppOriginOr: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/file-store")>();
  return { ...actual, listFiles: mocks.listFiles };
});
vi.mock("@/lib/app-origin", () => ({ resolveAppOriginOr: mocks.resolveAppOriginOr }));

vi.mock("@/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

import { auth } from "@/auth";
import { unpagedResult } from "@/lib/db/paging";
import { bearerSession } from "@/tests/mock-auth-session";
import { GET } from "./route";

const getSession = vi.mocked(auth.api.getSession);

async function mint(teacher = true): Promise<string> {
  getSession.mockResolvedValue(
    bearerSession({ id: "teacher-oid-1", name: "Test Teacher", isTeacher: teacher }),
  );
  return "session-token";
}

async function getRequest(query = "", token?: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/files${query}`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    }),
  );
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
  mocks.listFiles.mockResolvedValue(
    unpagedResult([
      {
        id: "v1-id",
        name: "linked-lists",
        kind: "tutor",
        title: "Linked Lists",
        description: "Intro",
        validFrom: new Date("2026-07-07T08:00:00Z"),
        createdBy: "teacher-oid-1",
        ownerName: "Test Teacher",
      },
    ]),
  );
  mocks.resolveAppOriginOr.mockResolvedValue("https://app.example");
});

describe("GET /api/files auth", () => {
  it("401s without a token, with WWW-Authenticate", async () => {
    const res = await getRequest();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(mocks.listFiles).not.toHaveBeenCalled();
  });

  it("403s a valid non-teacher token", async () => {
    const res = await getRequest("", await mint(false));
    expect(res.status).toBe(403);
    expect(mocks.listFiles).not.toHaveBeenCalled();
  });
});

describe("GET /api/files", () => {
  it("defaults to only the caller's files and returns the wire shape (no content)", async () => {
    const res = await getRequest("", await mint());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // No `paging` key: this route returns the full match set (the CLI reads it
    // whole), so it must never ask the store for a page.
    expect(mocks.listFiles).toHaveBeenCalledWith({
      search: undefined,
      createdBy: "teacher-oid-1",
    });
    expect(await res.json()).toEqual([
      {
        name: "linked-lists",
        kind: "tutor",
        title: "Linked Lists",
        description: "Intro",
        createdBy: "teacher-oid-1",
        ownerName: "Test Teacher",
        createdAt: "2026-07-07T08:00:00.000Z",
        url: "https://app.example/api/files/linked-lists",
      },
    ]);
  });

  it("widens to all teachers with mine=0 and passes q through trimmed", async () => {
    await getRequest("?mine=0&q=%20lists%20", await mint());
    expect(mocks.listFiles).toHaveBeenCalledWith({ search: "lists", createdBy: undefined });
  });

  it("503s when the store is unreachable", async () => {
    mocks.listFiles.mockResolvedValue(undefined);
    const res = await getRequest("", await mint());
    expect(res.status).toBe(503);
  });
});
