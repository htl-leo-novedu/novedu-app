import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DONE_STATES } from "@/lib/moodle-launch";

// The two arrival pages, rendered: `/lti/link` shows both accounts only while
// the arrival says "confirm" (anything else goes back through /lti/arrive),
// and `/lti/done` shows the message of each state with nothing personal.

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), checkArrival: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/moodle-arrival", () => ({ checkArrival: mocks.checkArrival }));
vi.mock("@/lib/moodle-actions", () => ({
  confirmMoodleLink: vi.fn(),
  declineMoodleLink: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { path });
  },
}));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import DonePage from "./done/page";
import LinkPage from "./link/page";

const ARRIVAL = {
  sub: "42",
  name: "Mia Muster",
  username: "mmuster",
  code: "quiz-code1",
  course: "Math 3A",
  lineitem: "https://moodle.example.org/li",
};

describe("/lti/link", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      user: { id: "u1", name: "Mia M.", email: "mia@school.example" },
    });
    mocks.checkArrival.mockResolvedValue({ decision: "confirm", arrival: ARRIVAL, connection: {} });
  });

  it("shows both accounts, the course and the notice, with the two buttons", async () => {
    const html = renderToStaticMarkup(await LinkPage());
    expect(html).toContain("Link your Moodle account?");
    expect(html).toContain("Mia M. · mia@school.example");
    expect(html).toContain("Mia Muster (mmuster)");
    expect(html).toContain("You came from the Moodle course “Math 3A”");
    expect(html).toContain("Novedu stores your Moodle user id (not your name)");
    expect(html).toContain("Yes, these are both me");
    expect(html).toContain("That&#x27;s not me");
  });

  it("sends any other decision back through /lti/arrive", async () => {
    mocks.checkArrival.mockResolvedValue({ decision: "expired" });
    await expect(LinkPage()).rejects.toMatchObject({ path: "/lti/arrive" });
  });
});

describe("/lti/done", () => {
  const render = async (params: Record<string, string>) =>
    renderToStaticMarkup(await DonePage({ searchParams: Promise.resolve(params) }));

  it.each(DONE_STATES)("renders the %s message with a link to the quiz", async (state) => {
    const html = await render({ state, code: "quiz-code1" });
    expect(html).toContain('href="/quiz-code1"');
    expect(html).toContain("Open the quiz");
  });

  it("names no account in either refusal", async () => {
    for (const state of ["mismatch-moodle", "mismatch-novedu"]) {
      const html = await render({ state, code: "quiz-code1" });
      expect(html).toContain("This Moodle account can&#x27;t be used here");
      expect(html).toContain("You can still take the quiz, but you can&#x27;t hand in to Moodle.");
    }
  });

  it("falls back to the expired message and drops a malformed code", async () => {
    const html = await render({ state: "<script>", code: "../evil" });
    expect(html).toContain("This link from Moodle has expired");
    expect(html).not.toContain("href=");
  });
});
