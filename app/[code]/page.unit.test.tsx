import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `app/[code]/page.tsx` is the student DISPATCHER: it maps each checkCode outcome
// to a rejection view, decides which dead codes drop from the user's recent-codes
// shortcuts, and dispatches to the module's render component by `entry.module`.
// Here we invoke the server component directly with mocked I/O and render its
// output; no DB, runs in CI. (The module render components are tested separately;
// the valid path that loads the real activity stays @live.)

const getSession = vi.hoisted(() => vi.fn());
const checkCode = vi.hoisted(() => vi.fn());
const recordRecentCode = vi.hoisted(() => vi.fn());
const removeRecentCode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ getSession }));
vi.mock("@/lib/code-store", () => ({ checkCode }));
vi.mock("@/lib/recent-code-store", () => ({ recordRecentCode, removeRecentCode }));
// Stub the module render components — dispatch is what this test asserts.
vi.mock("./render-tutor", () => ({
  RenderTutor: ({ code }: { code: string }) => <div data-testid="render-tutor">tutor {code}</div>,
}));
vi.mock("./render-quiz", () => ({
  RenderQuiz: ({ code }: { code: string }) => <div data-testid="render-quiz">quiz {code}</div>,
}));
vi.mock("./render-writing", () => ({
  RenderWriting: ({ code }: { code: string }) => (
    <div data-testid="render-writing">writing {code}</div>
  ),
}));
vi.mock("./render-coding", () => ({
  RenderCoding: ({ code, userId }: { code: string; userId: string }) => (
    <div data-testid="render-coding">
      coding {code} {userId}
    </div>
  ),
}));
vi.mock("./render-cloze", () => ({
  RenderCloze: ({ code }: { code: string }) => <div data-testid="render-cloze">cloze {code}</div>,
}));
// after() schedules the recents mutation; run it inline so the call is observable.
vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

import CodePage from "./page";

const CODE = "a1b2c3d4e5";
const USER_ID = "u1";
const FROM = new Date("2026-06-10T10:00:00Z");
const UNTIL = new Date("2026-06-10T14:00:00Z");

async function renderPage(code = CODE) {
  const element = await CodePage({ params: Promise.resolve({ code }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  getSession.mockResolvedValue({ user: { id: USER_ID } });
});

describe("rejection branches", () => {
  it("expired → renders the expiry view AND drops the dead code from recents", async () => {
    checkCode.mockResolvedValue({
      ok: false,
      reason: "expired",
      validUntil: UNTIL,
    });
    const html = await renderPage();
    expect(html).toContain("Code expired");
    expect(removeRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
    expect(recordRecentCode).not.toHaveBeenCalled();
  });

  it("unknown-code → renders the unknown view AND drops it from recents", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "unknown-code" });
    const html = await renderPage();
    expect(html).toContain("Unknown code");
    expect(removeRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });

  it("not-started → renders the not-yet view and KEEPS it in recents", async () => {
    checkCode.mockResolvedValue({
      ok: false,
      reason: "not-started",
      validFrom: FROM,
    });
    const html = await renderPage();
    expect(html).toContain("Not available yet");
    expect(removeRecentCode).not.toHaveBeenCalled();
    expect(recordRecentCode).not.toHaveBeenCalled();
  });

  it("lookup-failed → renders the transient view and touches no recents", async () => {
    checkCode.mockResolvedValue({ ok: false, reason: "lookup-failed" });
    const html = await renderPage();
    expect(html).toContain("Codes temporarily unavailable");
    expect(removeRecentCode).not.toHaveBeenCalled();
  });
});

describe("module dispatch (valid code)", () => {
  it("module=tutor → records a recent and renders the tutor module", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "tutor", fileUrl: "https://example.com/t.yaml" },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="render-tutor"');
    expect(html).toContain("tutor a1b2c3d4e5");
    expect(recordRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });

  it("module=quiz → records a recent and renders the quiz module", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "quiz", fileUrl: "https://example.com/api/files/q" },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="render-quiz"');
    expect(html).toContain("quiz a1b2c3d4e5");
    expect(recordRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });

  it("module=writing → records a recent and renders the writing module", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "writing", fileUrl: "https://example.com/api/files/w" },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="render-writing"');
    expect(html).toContain("writing a1b2c3d4e5");
    expect(recordRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });

  it("module=coding → records a recent and renders the coding module with the session userId", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "coding", fileUrl: "https://example.com/api/files/c" },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="render-coding"');
    expect(html).toContain(`coding ${CODE} ${USER_ID}`);
    expect(recordRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });

  it("module=cloze → records a recent and renders the cloze module", async () => {
    checkCode.mockResolvedValue({
      ok: true,
      entry: { module: "cloze", fileUrl: "https://example.com/api/files/cz" },
    });
    const html = await renderPage();
    expect(html).toContain('data-testid="render-cloze"');
    expect(html).toContain(`cloze ${CODE}`);
    expect(recordRecentCode).toHaveBeenCalledWith(USER_ID, CODE);
  });
});
