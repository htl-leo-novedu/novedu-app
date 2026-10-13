import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";
import { readModule, sourceFiles } from "@/tests/import-graph";

// The API surface guard (AGENTS.md security block, docs/api.md, docs/auth.md):
// (a) every api/ exclusion in the proxy.ts matcher is path-bounded so it cannot
// widen to a sibling route, and the probes below pin which paths run the cookie
// gate; (b) every API route handler self-gates with
// requireBearerUser/requireBearerTeacher unless it is one of the documented
// exceptions below. A new route fails here until it is documented and listed.

// Handlers that do NOT call requireBearerUser/requireBearerTeacher, by design.
const NON_BEARER_HANDLERS: Record<string, string> = {
  "GET /api/auth/[...all]": "better-auth's own endpoints (sign-in, OAuth, device flow)",
  "POST /api/auth/[...all]": "better-auth's own endpoints (sign-in, OAuth, device flow)",
  "GET /api/version": "public build-identity probe, no data beyond the build",
  "POST /api/coding/v1/chat/completions": "public coding route, per-user API key",
  "GET /api/coding/v1/models": "public coding route, per-user API key",
  "GET /api/copilotkit/[[...slug]]": "cookie-session chat runtime (checkCode + thread token)",
  "POST /api/copilotkit/[[...slug]]": "cookie-session chat runtime (checkCode + thread token)",
  "GET /api/image-content/[id]": "cookie-session image bytes (getSession per request)",
  "GET /api/health": "cookie-session teacher probe (requireEffectiveTeacher)",
};

describe("proxy.ts matcher", () => {
  it("bounds every api/ exclusion with (?:/|$)", () => {
    const apiExclusions = config.matcher.join("").match(/api\/[\w-]+(?:\(\?:\/\|\$\))?/g) ?? [];
    expect(apiExclusions).toContain("api/files(?:/|$)"); // not vacuous
    expect(apiExclusions.filter((alt) => !alt.endsWith("(?:/|$)"))).toEqual([]);
  });

  it.each([
    ["/api/filesx", true],
    ["/api/codes-x", true],
    ["/api/coding-export", true],
    ["/api/health", true],
    ["/api/image-content/abc", true],
    ["/api/copilotkit/info", true],
    ["/codes", true],
    ["/api/version", false],
    ["/api/files/x.yaml", false],
    ["/api/codes/abc/conversations", false],
    ["/api/coding/v1/models", false],
    ["/api/auth/sign-in/social", false],
    ["/sign-in", false],
  ])("%s runs the proxy: %s", (url, runs) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(runs);
  });
});

describe("app/api route handlers", () => {
  it("each calls requireBearerUser/requireBearerTeacher or is a documented exception", () => {
    const handlers: string[] = [];
    const ungated: string[] = [];
    for (const file of sourceFiles("app/api").filter((f) => f.endsWith("/route.ts"))) {
      const path = file.slice("app".length, -"/route.ts".length);
      // One chunk per top-level export; a handler's gate call sits in its own body.
      for (const chunk of readModule(file).split(/^export /m)) {
        const head = /^(?:async\s+)?(?:function|const)\s+(\{[^}]*\}|\w+)/.exec(chunk)?.[1] ?? "";
        for (const method of head.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\b/g) ?? []) {
          const key = `${method} ${path}`;
          handlers.push(key);
          if (!/\brequireBearer(?:User|Teacher)\(/.test(chunk) && !(key in NON_BEARER_HANDLERS)) {
            ungated.push(key);
          }
        }
      }
    }
    // Positive control: the walk saw the whole API, every exception included.
    expect(handlers.length).toBeGreaterThanOrEqual(20);
    expect(handlers).toEqual(expect.arrayContaining(Object.keys(NON_BEARER_HANDLERS)));
    expect(ungated).toEqual([]);
  });
});
