import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `app/codes/[code]/page.tsx` is a thin dispatcher: it gates, resolves the code
// (found/unknown/error), renders the shared chrome, then hands the body to the
// module's own `renderDetail`. The per-module detail content is tested against each
// module's component (conversation-stats / the writing savers list); here we pin
// only the gating + the dispatch. I/O is mocked; the component is invoked directly
// and its HTML rendered. No DB, runs in CI.

const isEffectiveTeacher = vi.hoisted(() => vi.fn());
const getCode = vi.hoisted(() => vi.fn());
const renderDetail = vi.hoisted(() => vi.fn());

vi.mock("@/lib/student-mode", () => ({ isEffectiveTeacher }));
vi.mock("@/lib/code-store", () => ({ getCode }));
// The registry is mocked entirely so the real descriptors (and their server-only
// transitive imports) never load; every module shares one renderDetail spy.
vi.mock("@/lib/code-modules/registry", () => ({
  codeModules: {
    tutor: { renderDetail },
    quiz: { renderDetail },
    writing: { renderDetail },
    coding: { renderDetail },
    cloze: { renderDetail },
  },
}));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import CodeStatsPage from "./page";

const CODE = "a1b2c3d4e5";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    code: CODE,
    module: "tutor",
    createdBy: "teacher-sub-1",
    fileUrl: "https://example.com/t.yaml",
    validFrom: new Date("2026-06-10T10:00:00Z"),
    validUntil: new Date("2026-06-10T14:00:00Z"),
    note: "My Class",
    origin: null,
    anonymous: true,
    createdAt: new Date("2026-06-09T09:00:00Z"),
    ...overrides,
  };
}

async function render(code = CODE, searchParams: Record<string, string> = {}) {
  const element = await CodeStatsPage({
    params: Promise.resolve({ code }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  isEffectiveTeacher.mockResolvedValue(true);
  renderDetail.mockResolvedValue(<div>detail-body</div>);
});

describe("gating", () => {
  it("denies a non-teacher before any lookup or dispatch", async () => {
    isEffectiveTeacher.mockResolvedValue(false);
    const html = await render();
    expect(html).toContain("Access denied");
    expect(getCode).not.toHaveBeenCalled();
    expect(renderDetail).not.toHaveBeenCalled();
  });

  it("shows a transient notice when the lookup fails", async () => {
    getCode.mockResolvedValue(undefined);
    const html = await render();
    expect(html).toContain("Stats temporarily unavailable");
    expect(renderDetail).not.toHaveBeenCalled();
  });

  it("shows 'not found' for an unknown code", async () => {
    getCode.mockResolvedValue(null);
    const html = await render();
    expect(html).toContain("Code not found");
    expect(renderDetail).not.toHaveBeenCalled();
  });
});

describe("dispatch", () => {
  beforeEach(() => {
    getCode.mockResolvedValue(entry());
  });

  it("renders the shared chrome + the module's renderDetail body", async () => {
    const html = await render();
    expect(html).toContain("Back to codes");
    expect(html).toContain("My Class");
    expect(html).toContain(CODE);
    expect(html).toContain("detail-body");
  });

  it("hands the entry + resolved search params to the module's renderDetail", async () => {
    await render(CODE, { q: "ada" });
    expect(renderDetail).toHaveBeenCalledTimes(1);
    expect(renderDetail).toHaveBeenCalledWith(
      expect.objectContaining({ code: CODE, module: "tutor" }),
      { q: "ada" },
    );
  });
});
