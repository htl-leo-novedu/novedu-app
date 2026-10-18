import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// `app/codes/page.tsx` gates the teacher, then lets the device's Classic/New
// cookie pick the list engine. A non-teacher (incl. a teacher in student mode)
// is denied before either engine renders. Both engines are stubbed.

const isEffectiveTeacher = vi.hoisted(() => vi.fn());
const getListEngine = vi.hoisted(() => vi.fn());

vi.mock("@/lib/student-mode", () => ({ isEffectiveTeacher }));
vi.mock("@/lib/list-engine", () => ({ getListEngine }));
vi.mock("./_classic/classic-codes-list", () => ({
  ClassicCodesList: ({ sp }: { sp: unknown }) => (
    <div data-testid="classic" data-sp={JSON.stringify(sp)} />
  ),
}));
vi.mock("./_list/codes-list", () => ({
  CodesList: ({ sp }: { sp: unknown }) => <div data-testid="new" data-sp={JSON.stringify(sp)} />,
}));

import CodesPage from "./page";

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await CodesPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  isEffectiveTeacher.mockResolvedValue(true);
  getListEngine.mockResolvedValue("classic");
});

it("denies a non-teacher without rendering either engine", async () => {
  isEffectiveTeacher.mockResolvedValue(false);
  getListEngine.mockResolvedValue("new");
  const html = await render();
  expect(html).toContain("Access denied");
  expect(html).not.toContain("data-testid");
});

it("renders the classic engine by default and the new one when chosen", async () => {
  expect(await render({ q: "x" })).toContain('data-testid="classic"');
  getListEngine.mockResolvedValue("new");
  const html = await render({ q: "x" });
  expect(html).toContain('data-testid="new"');
  expect(html).toContain("&quot;q&quot;:&quot;x&quot;");
});
