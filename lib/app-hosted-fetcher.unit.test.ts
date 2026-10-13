import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The one app-hosted URL resolution: `<origin>/api/files/<name>` is read from the
// DATABASE (never a loopback HTTP fetch to our own origin), everything else goes to
// the network fetcher. The file store and the origin resolver are mocked; the
// network seam is the global `fetch`, so a loopback would show up there.

const mocks = vi.hoisted(() => ({
  getActiveFile: vi.fn(),
  resolveAppOriginOr: vi.fn(),
}));

vi.mock("@/lib/file-store", () => ({ getActiveFile: mocks.getActiveFile }));
vi.mock("@/lib/app-origin", () => ({ resolveAppOriginOr: mocks.resolveAppOriginOr }));

import { appHostedFetcher, serverYamlFetcher } from "@/lib/app-hosted-fetcher";

const ORIGIN = "https://app.test";
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response("remote: yaml", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  mocks.resolveAppOriginOr.mockResolvedValue(ORIGIN);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("appHostedFetcher", () => {
  it("serves an own-origin file from the database, with no network fetch", async () => {
    mocks.getActiveFile.mockResolvedValue({ content: "id: tutor" });
    const res = await appHostedFetcher(ORIGIN)(`${ORIGIN}/api/files/my-tutor`);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("id: tutor");
    expect(mocks.getActiveFile).toHaveBeenCalledWith("my-tutor");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a query/fragment and decodes the name", async () => {
    mocks.getActiveFile.mockResolvedValue({ content: "x" });
    await appHostedFetcher(ORIGIN)(`${ORIGIN}/api/files/my%2Dfile?v=1#top`);
    expect(mocks.getActiveFile).toHaveBeenCalledWith("my-file");
  });

  it("an unknown (or deleted) file is a 404", async () => {
    mocks.getActiveFile.mockResolvedValue(null);
    const res = await appHostedFetcher(ORIGIN)(`${ORIGIN}/api/files/gone`);
    expect(res).toMatchObject({ ok: false, status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a database error is a 503, never a 'not found'", async () => {
    mocks.getActiveFile.mockResolvedValue(undefined);
    const res = await appHostedFetcher(ORIGIN)(`${ORIGIN}/api/files/any`);
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a foreign URL over the network, without touching the database", async () => {
    const res = await appHostedFetcher(ORIGIN)("https://example.com/t.yaml");
    expect(await res.text()).toBe("remote: yaml");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/t.yaml", expect.any(Object));
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });

  it("another host's /api/files/ URL is foreign — fetched, not read from our DB", async () => {
    await appHostedFetcher(ORIGIN)("https://other.test/api/files/x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});

describe("serverYamlFetcher", () => {
  it("binds the resolved app origin", async () => {
    mocks.getActiveFile.mockResolvedValue({ content: "id: q" });
    const fetcher = await serverYamlFetcher();
    expect(await (await fetcher(`${ORIGIN}/api/files/q`)).text()).toBe("id: q");
    expect(mocks.resolveAppOriginOr).toHaveBeenCalledWith("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a resolvable origin degrades to a plain network fetch", async () => {
    mocks.resolveAppOriginOr.mockResolvedValue("");
    const fetcher = await serverYamlFetcher();
    await fetcher(`${ORIGIN}/api/files/q`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.getActiveFile).not.toHaveBeenCalled();
  });
});
