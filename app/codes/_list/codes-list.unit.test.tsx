import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeListRow } from "@/lib/code-store";

// `/codes` on the new list engine, rendered on the server with the stores
// mocked: the URL reaches the store as SQL filters (never filtered here), the
// empty and no-match states differ, a failed interaction count shows "—" rather
// than a wrong zero, and an unavailable store shows the notice.

const listCodes = vi.hoisted(() => vi.fn());
const listCodeOwners = vi.hoisted(() => vi.fn());
const getInteractionCounts = vi.hoisted(() => vi.fn());

vi.mock("@/lib/code-store", () => ({ listCodes, listCodeOwners }));
vi.mock("@/lib/code-stats-store", () => ({ getInteractionCounts }));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: "user-me" } }) }));
vi.mock("@/lib/code-actions", () => ({ deleteSelectedCodesAction: vi.fn() }));
vi.mock("@/lib/list-engine-actions", () => ({ switchListEngineAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import { CodesList } from "./codes-list";

const ROW: CodeListRow = {
  code: "abc123defg",
  module: "tutor",
  note: "Fractions week 3",
  fileUrl: "https://example.test/tutor.yaml",
  createdBy: "user-me",
  ownerName: "Me Myself",
  validFrom: null,
  validUntil: null,
  origin: null,
} as CodeListRow;

const page = (rows: CodeListRow[], total = rows.length) => ({
  rows,
  total,
  page: 1,
  pageSize: 20,
});

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await CodesList({ sp }));

beforeEach(() => {
  listCodes.mockReset().mockResolvedValue(page([ROW]));
  listCodeOwners.mockReset().mockResolvedValue([]);
  getInteractionCounts.mockReset().mockResolvedValue(new Map([[ROW.code, 7]]));
});

describe("CodesList", () => {
  it("hands the URL's filters, sort and paging to the store as one query", async () => {
    await render({
      q: "frac",
      owner: "all",
      module: "quiz,tutor",
      status: "active",
      sort: "-until",
      page: "2",
    });
    expect(listCodes).toHaveBeenCalledOnce();
    const opts = listCodes.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      search: "frac",
      createdBy: undefined,
      modules: ["tutor", "quiz"],
      statuses: ["active"],
      sort: { key: "until", dir: "desc" },
      paging: { page: 2 },
    });
    expect(opts.now).toBeInstanceOf(Date);
  });

  it("defaults to my codes in the view's default order", async () => {
    await render();
    expect(listCodes.mock.calls[0]?.[0]).toMatchObject({
      createdBy: "user-me",
      modules: [],
      statuses: [],
      sort: undefined,
    });
  });

  it("renders the rows with their page-column count", async () => {
    const html = await render();
    expect(html).toContain("1 code");
    expect(html).toContain("Fractions week 3");
    expect(html).toContain("Actions for Fractions week 3");
    expect(getInteractionCounts).toHaveBeenCalledWith([ROW.code]);
    expect(html).toMatch(/>7</);
    expect(html).toContain("7 interactions");
  });

  it("shows — when the interaction count fails, never a wrong zero", async () => {
    getInteractionCounts.mockResolvedValue(undefined);
    const html = await render();
    expect(html).toContain("—");
    expect(html).not.toContain("0 interactions");
  });

  it("tells an empty list from a filter that matches nothing", async () => {
    listCodes.mockResolvedValue(page([]));
    const empty = await render();
    expect(empty).toContain("No codes yet.");
    expect(empty).toContain('href="/codes?owner=all"');
    expect(getInteractionCounts).toHaveBeenCalledWith([]);

    const filtered = await render({ status: "expired" });
    expect(filtered).toContain("No codes match your filter.");
    expect(filtered).not.toContain("No codes yet.");
  });

  it("shows the notice when the store is unavailable", async () => {
    listCodes.mockResolvedValue(undefined);
    const html = await render();
    expect(html).toContain("Codes temporarily unavailable");
    expect(getInteractionCounts).not.toHaveBeenCalled();
  });
});
