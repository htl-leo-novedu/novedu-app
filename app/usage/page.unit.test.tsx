import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `app/usage/page.tsx` is the teacher gate + shell. Non-teachers (incl. a teacher in
// student mode) must get "Access denied" WITHOUT any section rendering; a teacher
// gets the range tabs + the Suspense sections, both cost cards among them. The sections + client range
// tabs are stubbed — dispatch/gating is what this test asserts. No DB, runs in CI.

const isEffectiveTeacher = vi.hoisted(() => vi.fn());

vi.mock("@/lib/student-mode", () => ({ isEffectiveTeacher }));
vi.mock("./range-tabs", () => ({ RangeTabs: () => <div data-testid="range-tabs" /> }));
vi.mock("./kpi-section", () => ({ KpiSection: () => <div data-testid="kpi-section" /> }));
vi.mock("./token-section", () => ({ TokenSection: () => <div data-testid="token-section" /> }));
vi.mock("./breakdown-section", () => ({
  BreakdownSection: () => <div data-testid="breakdown-section" />,
}));
vi.mock("./cost-section", () => ({
  COST_TITLE: "Cost title",
  SPEND_TITLE: "Spend title",
  CostSection: () => <div data-testid="cost-section" />,
  SpendSection: () => <div data-testid="spend-section" />,
}));

import UsagePage from "./page";

async function renderPage(range?: string) {
  const element = await UsagePage({ searchParams: Promise.resolve(range ? { range } : {}) });
  return renderToStaticMarkup(element);
}

it("denies a non-teacher (or a teacher in student mode) without rendering any section", async () => {
  isEffectiveTeacher.mockResolvedValue(false);
  const html = await renderPage("7d");
  expect(html).toContain("Access denied");
  expect(html).not.toContain("range-tabs");
  expect(html).not.toContain("kpi-section");
});

describe("teacher", () => {
  beforeEach(() => {
    isEffectiveTeacher.mockResolvedValue(true);
  });

  it("renders the range tabs and the three data sections", async () => {
    const html = await renderPage("30d");
    expect(html).toContain("range-tabs");
    expect(html).toContain("kpi-section");
    expect(html).toContain("token-section");
    expect(html).toContain("breakdown-section");
    // Both cost cards, the real spend first.
    expect(html).toContain("spend-section");
    expect(html).toContain("cost-section");
    expect(html.indexOf("spend-section")).toBeLessThan(html.indexOf("cost-section"));
    expect(html).not.toContain("Access denied");
  });
});
