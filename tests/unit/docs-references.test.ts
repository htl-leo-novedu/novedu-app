import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "@/tests/import-graph";

// Keeps the developer docs (AGENTS.md, README.md, docs/*.md) from drifting away from
// the code: every repo path and file name a doc names exists, every relative Markdown
// link and #anchor resolves, docs/api.md and the API route files agree in both
// directions, and no doc narrates change history (AGENTS.md: current state only).
// The rules are narrow on purpose — a checker that fails on correct docs gets ignored.

const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/** Paths that are untracked by design — generated, gitignored or local-only. */
const ALLOWLIST = [
  "cli/dist", // the CLI build output
  "e2e/.auth", // minted session cookies
  "e2e/.image-root", // the e2e image storage root
  "docs/superpowers/specs", // local-only design specs (gitignored)
];

const DOCS = ["AGENTS.md", "README.md", ...tracked.filter((f) => /^docs\/[^/]+\.md$/.test(f))];

/** The repo's top-level directories: a backticked token starting with one is a repo path. */
const REPO_DIRS = new Set(tracked.filter((f) => f.includes("/")).map((f) => f.split("/")[0]));

// ---- extraction ------------------------------------------------------------------

type Ref = { line: number; text: string };

/**
 * The doc's paragraphs outside fenced code blocks — runs of non-blank lines, joined
 * with "\n" so a code span may wrap — each with the 1-based line it starts on.
 */
function paragraphs(markdown: string): Ref[] {
  const result: Ref[] = [];
  let fenced = false;
  let current: Ref | undefined;
  for (const [index, text] of markdown.split("\n").entries()) {
    const fence = /^\s*(```|~~~)/.test(text);
    if (fence) fenced = !fenced;
    if (fence || fenced || text.trim() === "") {
      current = undefined;
    } else if (current) {
      current.text += `\n${text}`;
    } else {
      current = { line: index + 1, text };
      result.push(current);
    }
  }
  return result;
}

/** Every match of a global pattern in a paragraph, with the line it sits on. */
function matchesIn({ line, text }: Ref, pattern: RegExp) {
  return [...text.matchAll(pattern)].map((match) => ({
    line: line + (text.slice(0, match.index).match(/\n/g)?.length ?? 0),
    match,
  }));
}

const CODE_SPAN = /(`+)([^`]+?)\1/g;

/** Every inline code span (`…`) in the prose, its whitespace collapsed. */
function codeSpans(paras: Ref[]): Ref[] {
  return paras.flatMap((para) =>
    matchesIn(para, CODE_SPAN).map(({ line, match }) => ({
      line,
      text: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
}

/** The paragraph with its code spans blanked out (line breaks kept, so lines still count). */
const withoutCodeSpans = (para: Ref): Ref => ({
  ...para,
  text: para.text.replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, " ")),
});

// ---- rule 1 + 2: repo paths and bare file names ------------------------------------

/** A placeholder or glob character: the token names a pattern, not one path. */
const PATTERN_CHARS = /[*{}<>$…]|\.\.\.(?!\w)/;

/** The repo path a code span names (a `dir/**` glob names its directory), or null. */
function repoPathOf(token: string): string | null {
  const path = token
    .replace(/^@\//, "")
    .replace(/#.*$/, "")
    .replace(/:\d+(-\d+)?$/, "")
    .replace(/\/\*\*?$/, "")
    .replace(/\/$/, "");
  if (/\s/.test(path) || PATTERN_CHARS.test(path)) return null;
  if (!path.includes("/") || !REPO_DIRS.has(path.split("/")[0])) return null;
  return path;
}

function makeResolver(files: string[]) {
  const fileSet = new Set(files);
  const dirSet = new Set(
    files.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  const names = new Set(files.map((f) => basename(f)));
  return {
    path: (path: string) =>
      ALLOWLIST.includes(path) ||
      dirSet.has(path) ||
      ["", ".ts", ".tsx", ".mjs", "/index.ts"].some((suffix) => fileSet.has(`${path}${suffix}`)),
    name: (name: string) => names.has(name),
    entry: (path: string) => fileSet.has(path) || dirSet.has(path),
  };
}

/** A bare source-file name (`foo.ts`), checked to exist somewhere in the tree. */
const isBareFileName = (token: string) => /^[\w.-]+\.(ts|tsx|mjs|mts)$/.test(token);

// ---- rule 3: Markdown links and anchors -------------------------------------------

/** GitHub's heading slug: lowercased, punctuation dropped, each space a hyphen. */
function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a doc's headings produce, with GitHub's `-1`, `-2` duplicate suffixes. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const text of paragraphs(markdown).flatMap((para) => para.text.split("\n"))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text)?.[1];
    if (heading === undefined) continue;
    const base = slug(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

/** Every relative link target in the prose (`file`, `file.md#anchor`, `#anchor`). */
function relativeLinks(paras: Ref[]): Ref[] {
  return paras.flatMap((para) =>
    matchesIn(withoutCodeSpans(para), /\]\(([^)\s]+)\)/g)
      .map(({ line, match }) => ({ line, text: match[1] ?? "" }))
      .filter(({ text }) => !/^([a-z][a-z+.-]*:|\/)/i.test(text)),
  );
}

// ---- rule 4: API routes ------------------------------------------------------------

/** `app/api/a/[b]/route.ts` → `/api/a/[b]`. */
const routePath = (file: string) => `/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`;

type ApiRef = Ref & { exact: boolean };

/**
 * Every `/api/…` path named in a code span, query and trailing slash dropped. `exact`
 * when an HTTP method precedes it (`GET /api/files`): that names one route, while a
 * bare path may name a namespace (`/api/eval`).
 */
function apiPaths(spans: Ref[]): ApiRef[] {
  return spans.flatMap(({ line, text }) =>
    [...text.matchAll(/(?<![\w.])\/api(?:\/[^\s`'"?#,)]*)?/g)]
      .map((m) => ({
        line,
        text: (m[0] ?? "").replace(/\/$/, ""),
        exact: /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$/.test(text.slice(0, m.index)),
      }))
      .filter(({ text: path }) => !path.startsWith("/api/auth") && !/[*{}$…]|\.\.\./.test(path)),
  );
}

/**
 * The route a concrete doc path hits, as Next routes it: a static segment beats a
 * `[param]` (which takes any value — `<code>`, an example), a catch-all comes last.
 */
function routeFor(routes: string[], docPath: string): string | undefined {
  const docParts = docPath.split("/").slice(1);
  // Per segment 0 = static, 1 = param, 2 = catch-all; undefined = no match.
  const rank = (route: string): number[] | undefined => {
    const parts = route.split("/").slice(1);
    const kinds: number[] = [];
    for (const [i, part] of parts.entries()) {
      if (part.startsWith("[[...")) return i <= docParts.length ? [...kinds, 2] : undefined;
      if (part.startsWith("[...")) return i < docParts.length ? [...kinds, 2] : undefined;
      const doc = docParts[i];
      if (doc === undefined) return undefined;
      if (part.startsWith("[")) kinds.push(1);
      else if (doc === part) kinds.push(0);
      else return undefined;
    }
    return parts.length === docParts.length ? kinds : undefined;
  };
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return 0;
  };
  return routes
    .map((route) => ({ route, kinds: rank(route) }))
    .filter((hit): hit is { route: string; kinds: number[] } => hit.kinds !== undefined)
    .sort((a, b) => compare(a.kinds, b.kinds))[0]?.route;
}

/** Whether a bare doc path names this route or a namespace above it. */
const underRoute = (routes: string[], docPath: string) =>
  routeFor(routes, docPath) !== undefined ||
  routes.some((route) => route.startsWith(`${docPath}/`) || docPath === "/api");

// ---- rule 5: history wording -------------------------------------------------------

/**
 * Phrases that only ever narrate change history. Bare "used to", "no longer" and
 * "previously" are not on it: the docs use them for present-tense facts ("the key
 * used to sign …", "a code that no longer exists", "the previously saved text").
 */
const HISTORY_PHRASES: [label: string, pattern: RegExp][] = [
  ["used to be", /\bused\s+to\s+be\b/gi],
  ["was renamed", /\bwas\s+renamed\b/gi],
  ["formerly", /\bformerly\b/gi],
  ["since v…", /\bsince\s+v(?:ersion\s*)?\d/gi],
  ["as of v…", /\bas\s+of\s+v(?:ersion\s*)?\d/gi],
];

/** History phrases in the prose, code spans excluded. */
function historyPhrases(paras: Ref[]): Ref[] {
  return paras
    .map(withoutCodeSpans)
    .flatMap((para) =>
      HISTORY_PHRASES.flatMap(([label, pattern]) =>
        matchesIn(para, pattern).map(({ line }) => ({ line, text: label })),
      ),
    );
}

// ---- the repo check ----------------------------------------------------------------

describe("matchers", () => {
  it("reads repo paths from code spans, skipping patterns and prose", () => {
    expect(repoPathOf("@/lib/thread-token.ts:12")).toBe("lib/thread-token.ts");
    expect(repoPathOf("docs/codes.md#adding-a-module")).toBe("docs/codes.md");
    expect(repoPathOf("app/api/copilotkit/[[...slug]]/route.ts")).toBe(
      "app/api/copilotkit/[[...slug]]/route.ts",
    );
    expect(repoPathOf("app/[code]/**")).toBe("app/[code]");
    expect(repoPathOf("lib/llm/*")).toBe("lib/llm");
    expect(repoPathOf("lib/<kind>-yaml.ts")).toBeNull();
    expect(repoPathOf("lib/quiz-*.ts")).toBeNull();
    expect(repoPathOf("npm run lib/x")).toBeNull();
    expect(repoPathOf("node_modules/next")).toBeNull();
  });

  it("splits prose into paragraphs, skipping fences, so a wrapped span stays whole", () => {
    const paras = paragraphs("a `lib/x\n.ts` b\n\n```\n`lib/y.ts`\n```\nc\n`lib/z.ts`");
    expect(paras.map((para) => para.line)).toEqual([1, 7]);
    expect(codeSpans(paras)).toEqual([
      { line: 1, text: "lib/x .ts" },
      { line: 8, text: "lib/z.ts" },
    ]);
  });

  it("resolves a path as a file, a directory, an extension-less module or an index", () => {
    const resolve = makeResolver(["lib/a.ts", "lib/b/index.ts", "app/x/page.tsx"]);
    for (const path of ["lib/a.ts", "lib/a", "lib/b", "app/x", "app/x/page", "cli/dist"]) {
      expect(resolve.path(path), path).toBe(true);
    }
    expect(resolve.path("lib/c.ts")).toBe(false);
    expect(resolve.name("page.tsx")).toBe(true);
    expect(resolve.name("missing.ts")).toBe(false);
  });

  it("slugs headings the GitHub way, numbering duplicates", () => {
    expect(slug("Routes & conventions")).toBe("routes--conventions");
    expect(slug("Server: `lib/api-auth.ts` — the one seam")).toBe(
      "server-libapi-authts--the-one-seam",
    );
    expect([...anchors("# A\n## Setup\n```\n# not a heading\n```\n## Setup")]).toEqual([
      "a",
      "setup",
      "setup-1",
    ]);
    expect(
      relativeLinks([
        {
          line: 1,
          text: "[x](codes.md#y) [z](https://a.md) [w](#v)\n`[q](r.md)` [c](../compose.yaml)",
        },
      ]),
    ).toEqual([
      { line: 1, text: "codes.md#y" },
      { line: 1, text: "#v" },
      { line: 2, text: "../compose.yaml" },
    ]);
  });

  it("finds the route a doc path hits, static segments first", () => {
    const routes = ["/api/files", "/api/files/[name]", "/api/reports/[id]", "/api/reports/resolve"];
    expect(routePath("app/api/files/[name]/route.ts")).toBe("/api/files/[name]");
    expect(routeFor(routes, "/api/files/<name>")).toBe("/api/files/[name]");
    expect(routeFor(routes, "/api/files")).toBe("/api/files");
    expect(routeFor(routes, "/api/reports/resolve")).toBe("/api/reports/resolve");
    expect(routeFor(routes, "/api/reports/<id>")).toBe("/api/reports/[id]");
    expect(routeFor(routes, "/api/filez/<name>")).toBeUndefined();
    expect(routeFor(routes, "/api/files/<name>/raw")).toBeUndefined();
    expect(routeFor(["/api/copilotkit/[[...slug]]"], "/api/copilotkit")).toBeDefined();
    expect(routeFor(["/api/copilotkit/[[...slug]]"], "/api/copilotkit/info")).toBeDefined();
    // Only a bare path may name a namespace above its routes.
    expect(routeFor(["/api/eval/grade"], "/api/eval")).toBeUndefined();
    expect(underRoute(["/api/eval/grade"], "/api/eval")).toBe(true);
    expect(underRoute(["/api/eval/grade"], "/api/evals")).toBe(false);
  });

  it("reads API paths from code spans, exact after an HTTP method", () => {
    expect(apiPaths([{ line: 1, text: "GET /api/codes?q=&mine=" }])).toEqual([
      { line: 1, text: "/api/codes", exact: true },
    ]);
    expect(apiPaths([{ line: 1, text: "/api/eval" }])).toEqual([
      { line: 1, text: "/api/eval", exact: false },
    ]);
    expect(
      apiPaths([{ line: 1, text: "/api/auth/sign-out /api/eval/{a,b} /api/x/* /api/..." }]),
    ).toEqual([]);
  });

  it("flags history wording but not the same words in present-tense use", () => {
    const flagged = (text: string) => historyPhrases([{ line: 1, text }]).map((ref) => ref.text);
    expect(flagged("The limit used to be 10.")).toEqual(["used to be"]);
    expect(flagged("The secret, used to sign the token, stays on the server.")).toEqual([]);
    expect(flagged("It was renamed in a later release, formerly `x`.")).toEqual([
      "was renamed",
      "formerly",
    ]);
    expect(flagged("Available since v2, needs it as of version 3.")).toEqual([
      "since v…",
      "as of v…",
    ]);
    expect(flagged("A code that no longer exists; the previously saved text.")).toEqual([]);
    expect(flagged("Never write `was renamed` in a doc.")).toEqual([]);
  });
});

it("the developer docs reference only what exists, and narrate no history", () => {
  const resolve = makeResolver(tracked);
  const routes = tracked.filter((f) => /^app\/api\/.*\/route\.ts$/.test(f)).map(routePath);
  const read = (doc: string) => readFileSync(join(REPO_ROOT, doc), "utf8");
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (doc: string) =>
    anchorCache.get(doc) ?? anchorCache.set(doc, anchors(read(doc))).get(doc) ?? new Set();
  const problems: string[] = [];
  // Per rule, how many references it checked — a rule that matches nothing fails.
  const checked = { paths: 0, names: 0, links: 0, anchors: 0, apiPaths: 0 };

  for (const doc of DOCS) {
    const paras = paragraphs(read(doc));
    const spans = codeSpans(paras);

    for (const { line, text } of spans) {
      const path = repoPathOf(text);
      if (path !== null) {
        checked.paths++;
        if (!resolve.path(path)) problems.push(`${doc}:${line}: no such path \`${path}\``);
      } else if (isBareFileName(text)) {
        checked.names++;
        if (!resolve.name(text)) problems.push(`${doc}:${line}: no such file \`${text}\``);
      }
    }

    for (const { line, text } of relativeLinks(paras)) {
      checked.links++;
      const [file = "", anchor] = text.split("#");
      const target = file === "" ? doc : normalize(join(dirname(doc), file)).replace(/\\/g, "/");
      if (!resolve.entry(target.replace(/\/$/, ""))) {
        problems.push(`${doc}:${line}: link to missing ${target}`);
      } else if (anchor !== undefined && target.endsWith(".md")) {
        checked.anchors++;
        if (!anchorsOf(target).has(anchor)) {
          problems.push(`${doc}:${line}: no heading #${anchor} in ${target}`);
        }
      }
    }

    for (const { line, text, exact } of apiPaths(spans)) {
      checked.apiPaths++;
      if (exact ? routeFor(routes, text) === undefined : !underRoute(routes, text)) {
        problems.push(`${doc}:${line}: no route for ${text}`);
      }
    }

    for (const { line, text } of historyPhrases(paras)) {
      problems.push(`${doc}:${line}: history wording "${text}"`);
    }
  }

  const documented = new Set(
    apiPaths(codeSpans(paragraphs(read("docs/api.md")))).map((ref) => routeFor(routes, ref.text)),
  );
  for (const route of routes) {
    if (route.startsWith("/api/auth/")) continue; // better-auth's catch-all, documented by path
    if (!documented.has(route)) problems.push(`docs/api.md: route ${route} is not documented`);
  }

  for (const count of Object.values(checked)) expect(count).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
