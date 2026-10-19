import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeListRow } from "@/lib/code-store";

// `/codes` on the new list engine, rendered on the server with the stores
// mocked: the URL reaches the store as SQL filters (never filtered here), the
// summary line names them, the empty and no-match states differ, a failed interaction count shows "—" rather
// than a wrong zero, and an unavailable store shows the notice. `?view=` picks the
// columns, and a view computes only the page columns it shows.

const listCodes = vi.hoisted(() => vi.fn());
const listCodeOwners = vi.hoisted(() => vi.fn());
const getInteractionCounts = vi.hoisted(() => vi.fn());
const yamlModels = vi.hoisted(() => vi.fn());

vi.mock("@/lib/code-store", () => ({ listCodes, listCodeOwners }));
vi.mock("@/lib/code-stats-store", () => ({ getInteractionCounts }));
vi.mock("@/lib/activity-llm", () => ({ yamlModels }));
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
  llm: null,
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
  yamlModels.mockReset().mockResolvedValue(new Map());
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

  it("sums up the applied filters under the toolbar and offers the views", async () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    const plain = text(await render());
    expect(plain).toContain("1 code·Owner: mine");
    expect(plain).not.toContain("Clear all");

    const filtered = text(await render({ owner: "all", status: "active,expired" }));
    expect(filtered).toContain("1 code·Owner: all owners·Status: Active, Expired·Clear all");
    expect(filtered).toContain("Overview");
    expect(filtered).toContain("Which model each code runs on");
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

  it("links each view with the filters kept and the sort and page dropped", async () => {
    const html = await render({ q: "frac", sort: "note", page: "2" });
    expect(html).toContain('href="/codes?q=frac&amp;view=models"');
    expect(html).toContain('href="/codes?q=frac"');
  });

  it("the Overview reads no YAML", async () => {
    const text = (await render()).replace(/<[^>]+>/g, "");
    expect(yamlModels).not.toHaveBeenCalled();
    expect(text).toContain("Owner↕");
    expect(text).not.toContain("YAML model");
  });

  it("an unknown view is the Overview", async () => {
    await render({ view: "nope" });
    expect(yamlModels).not.toHaveBeenCalled();
    expect(getInteractionCounts).toHaveBeenCalled();
  });

  describe("the models view", () => {
    const QUIZ_URL = "https://example.test/quiz.yaml";
    const OVERRIDE: CodeListRow = {
      ...ROW,
      code: "over123456",
      note: "Overridden tutor",
      llm: { provider: "OpenRouter", model: "openai/gpt-6.1-sol", reasoning: "high" },
    };
    const BROKEN: CodeListRow = {
      ...ROW,
      code: "broken1234",
      note: "Broken YAML",
      fileUrl: QUIZ_URL,
    };

    beforeEach(() => {
      listCodes.mockResolvedValue(page([OVERRIDE, ROW, BROKEN]));
      yamlModels.mockResolvedValue(
        new Map([
          [ROW.fileUrl, { provider: "SCCH", model: "qwen3-coder" }],
          [QUIZ_URL, null],
        ]),
      );
    });

    it("loads the page's YAMLs, overridden codes' too, and keeps the newest-first order", async () => {
      await render({ view: "models" });
      expect(yamlModels).toHaveBeenCalledWith([ROW.fileUrl, ROW.fileUrl, QUIZ_URL]);
      expect(getInteractionCounts).not.toHaveBeenCalled();
      expect(listCodes.mock.calls[0]?.[0].sort).toBeUndefined();

      await render({ view: "models", sort: "override" });
      expect(listCodes.mock.calls[1]?.[0].sort).toEqual({ key: "override", dir: "asc" });
    });

    it("drops a sort on a column the view doesn't show", async () => {
      await render({ view: "models", sort: "owner" });
      expect(listCodes.mock.calls[0]?.[0].sort).toBeUndefined();
    });

    it("shows each code's YAML model, struck through under an override", async () => {
      const html = await render({ view: "models" });
      const text = html.replace(/<[^>]+>/g, "");
      expect(text).toContain("YAML model");
      expect(text).toContain("Override model");
      expect(text).toContain("OpenRouter · openai/gpt-6.1-sol");
      expect(text).not.toContain("openai/gpt-6.1-sol · high");
      expect(text).toContain("SCCH · qwen3-coder");
      expect(text).toContain("override openai/gpt-6.1-sol");
      expect(text).not.toContain("Owner↕");
      // Only the overridden code's YAML model is struck — in its cell and its phone
      // fact, both also saying so to a screen reader. The other row's runs.
      expect(html.match(/line-through/g)).toHaveLength(2);
      expect(html.match(/\(replaced by the override\)/g)).toHaveLength(2);
      expect(html).toContain('title="Replaced by this code&#x27;s override"');
    });

    it("shows the reasoning level that runs: the override's, else the YAML's", async () => {
      yamlModels.mockResolvedValue(
        new Map([
          [ROW.fileUrl, { provider: "SCCH", model: "qwen3-coder", reasoning: "low" }],
          [QUIZ_URL, null],
        ]),
      );
      const cells = (html: string) =>
        [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)]
          .map((row) =>
            [...(row[1] ?? "").matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) =>
              (cell[1] ?? "").replace(/<[^>]+>/g, ""),
            ),
          )
          .filter((row) => row.length > 0); // the header row has no <td>
      const html = await render({ view: "models" });
      expect(html.replace(/<[^>]+>/g, "")).toContain("Reasoning");
      // Desktop cells: checkbox, activity, note, YAML model, override, reasoning, actions.
      const reasoning = cells(html).map((row) => row[5]);
      // The override's `high` beats the YAML's `low`; the YAML's `low` runs
      // without one; an unreadable YAML without an override is unknown.
      expect(reasoning).toEqual(["high", "low", "—"]);
      expect(html).toContain("reasoning high");
      expect(html).toContain("reasoning low");

      yamlModels.mockResolvedValue(new Map([[ROW.fileUrl, { provider: "SCCH", model: "m" }]]));
      listCodes.mockResolvedValue(page([ROW]));
      const unpinned = await render({ view: "models" });
      expect(cells(unpinned).map((row) => row[5])).toEqual(["provider default"]);
      // No phone fact for the provider default.
      expect(unpinned).not.toMatch(/reasoning (none|minimal|low|medium|high|xhigh)\b/);
    });

    it("shows — for a YAML that can't be read and nothing without an override", async () => {
      listCodes.mockResolvedValue(page([BROKEN]));
      const html = await render({ view: "models" });
      expect(html).toMatch(/<td[^>]*>—<\/td>/);
      expect(html).toMatch(/<td[^>]*><\/td>/);
    });
  });

  it("shows the notice when the store is unavailable", async () => {
    listCodes.mockResolvedValue(undefined);
    const html = await render();
    expect(html).toContain("Codes temporarily unavailable");
    expect(getInteractionCounts).not.toHaveBeenCalled();
  });
});
