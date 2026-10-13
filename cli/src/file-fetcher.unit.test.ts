import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSessions } from "./auth";
import { createCliFetcher } from "./file-fetcher";

// The CLI's fetcher: `file:` from disk, http(s) over the network — with the stored
// session's bearer token ONLY for an origin the CLI is signed in to (uploaded files
// are teacher-only), never for any other host, and never across a redirect. Offline:
// the global `fetch` is stubbed and the session file lives in a temp dir.

const APP = "https://app.novedu.at";
const fetchMock = vi.fn();

function sessionsWith(origins: Record<string, string>): string {
  const path = join(mkdtempSync(join(tmpdir(), "novedu-fetcher-test-")), "sessions.json");
  writeSessions(
    Object.fromEntries(Object.entries(origins).map(([o, token]) => [o, { token, name: "T" }])),
    path,
  );
  return path;
}

/** The headers and redirect mode the stubbed fetch received for its `n`th call. */
function call(n = 0): { headers?: Record<string, string>; redirect?: string } {
  return fetchMock.mock.calls[n]?.[1] ?? {};
}

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response("id: x", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NOVEDU_TOKEN", "");
  vi.stubEnv("NOVEDU_SERVER", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createCliFetcher", () => {
  it("reads a file: URL from disk without any network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "novedu-fetcher-file-"));
    writeFileSync(join(dir, "t.yaml"), "id: local");
    const { fetch } = createCliFetcher(sessionsWith({}));
    const res = await fetch(pathToFileURL(join(dir, "t.yaml")).href);
    expect(await res.text()).toBe("id: local");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the stored bearer to its own origin, refusing redirects", async () => {
    const { fetch } = createCliFetcher(sessionsWith({ [APP]: "app-token" }));
    await fetch(`${APP}/api/files/exam`);
    expect(call().headers).toEqual({ authorization: "Bearer app-token" });
    expect(call().redirect).toBe("error");
  });

  it("never sends a token to another origin", async () => {
    const { fetch } = createCliFetcher(
      sessionsWith({ [APP]: "app-token", "http://localhost:3000": "local-token" }),
    );
    await fetch("https://raw.githubusercontent.com/org/repo/main/tutor.yaml");
    await fetch("https://dev.novedu.at/api/files/exam");
    for (const n of [0, 1]) {
      expect(call(n).headers).toBeUndefined();
      expect(call(n).redirect).toBe("follow");
    }
  });

  it("uses NOVEDU_TOKEN for the resolved server only", async () => {
    vi.stubEnv("NOVEDU_TOKEN", "env-token");
    vi.stubEnv("NOVEDU_SERVER", "http://localhost:3000");
    const { fetch } = createCliFetcher(sessionsWith({ [APP]: "app-token" }));
    await fetch("http://localhost:3000/api/files/x");
    await fetch(`${APP}/api/files/x`);
    expect(call(0).headers).toEqual({ authorization: "Bearer env-token" });
    expect(call(1).headers).toEqual({ authorization: "Bearer app-token" });
  });

  it("turns a refused uploaded file into one sign-in hint per origin", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    const fetcher = createCliFetcher(sessionsWith({}));
    await fetcher.fetch(`${APP}/api/files/a`);
    await fetcher.fetch(`${APP}/api/files/b`);
    const [hint, ...rest] = fetcher.signInErrors();
    expect(rest).toEqual([]);
    expect(hint).toMatchObject({ code: "FETCH_FAILED", url: APP });
    expect(hint?.message).toContain(`novedu-cli login --server ${APP}`);
  });

  it("a 401 from a non-upload URL gives no sign-in hint", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 401 }));
    const fetcher = createCliFetcher(sessionsWith({}));
    await fetcher.fetch("https://example.com/private/t.yaml");
    expect(fetcher.signInErrors()).toEqual([]);
  });
});
