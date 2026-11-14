import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { signMoodleToken } from "@/lib/moodle-launch";
import PickPage from "./page";
import { PICK_ERRORS } from "./pick-errors";

// The picker page, rendered: the one field with the signed token as a hidden
// field, each fixed error message, and the expired message without a valid token.

const render = async (params: Record<string, string>) =>
  renderToStaticMarkup(await PickPage({ searchParams: Promise.resolve(params) }));

describe("/lti/pick", () => {
  it("renders the field and carries the token", async () => {
    vi.stubEnv("AUTH_SECRET", "test-auth-secret");
    const t = await signMoodleToken("pick", { returnUrl: "https://m.example/r", data: null });
    const html = await render({ t });
    expect(html).toContain("Paste the Novedu code or link of your quiz");
    expect(html).toContain(`name="t" value="${t}"`);
    expect(html).toContain('action="/api/lti/pick"');
    expect(html).toContain("Use this quiz");
  });

  it.each(Object.keys(PICK_ERRORS))("shows the %s message", async (error) => {
    vi.stubEnv("AUTH_SECRET", "test-auth-secret");
    const t = await signMoodleToken("pick", { returnUrl: "https://m.example/r", data: null });
    const html = await render({ t, error });
    expect(html).toContain(
      PICK_ERRORS[error as keyof typeof PICK_ERRORS].replaceAll("'", "&#x27;"),
    );
  });

  it("says the page expired without a valid token", async () => {
    vi.stubEnv("AUTH_SECRET", "test-auth-secret");
    const html = await render({ t: "forged" });
    expect(html).toContain("This page has expired");
    expect(html).not.toContain("<form");
  });
});
