import { describe, expect, it } from "vitest";
import { readModule, resolveImport, sourceFiles } from "@/tests/import-graph";

// RSC boundary invariant: a module WITHOUT "use client" may be evaluated in the
// server graph, where every export of a "use client" module is an opaque
// client-reference proxy — fine for COMPONENTS (rendered by reference), but a
// plain value (a class-string constant, a hook, a helper) arrives as the proxy,
// not the value; coercing it renders the proxy's source into the page. This
// test flags any non-client module importing a non-component (non-PascalCase,
// non-type) name from a client module. Share such values from a directive-free
// module instead (e.g. app/[code]/_coding/code-panel.ts).

const files = sourceFiles("app", "components", "lib");

// A directive counts only as the module's FIRST statement (comments may precede it).
// Anywhere else it is a plain string expression — and biome's formatter then rewrites
// it to `("use server");`, so the file silently stops being a server-action (or
// client) module while every type check and unit test stays green.
const leadingCommentsStripped = (source: string) =>
  source.replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
const isClientModule = (source: string) =>
  /^["']use client["']/.test(leadingCommentsStripped(source));
const isServerActionModule = (source: string) =>
  /^["']use server["']/.test(leadingCommentsStripped(source));

/** A top-level `"use server"` / `"use client"` that is not the module's directive. */
const hasDisplacedDirective = (source: string): boolean =>
  [
    ...leadingCommentsStripped(source).matchAll(
      /^\(?["']use (?:server|client)["']\)?;?[ \t]*(?:\/\/.*)?$/gm,
    ),
  ].some((match) => match.index !== 0 || match[0].startsWith("("));

// What a "use server" module may export (a house rule, stricter than Next): its own
// actions as `export async function`, and type declarations (erased at build).
const ALLOWED_ACTION_EXPORT = /^export\s+(?:async\s+function\b|type\s+[\w$]|interface\b)/;
const disallowedActionExports = (source: string): string[] =>
  source.split("\n").filter((line) => /^export\b/.test(line) && !ALLOWED_ACTION_EXPORT.test(line));

// PascalCase (mixed case, initial capital) = a component; everything else that
// isn't type-only (camelCase values/hooks, SCREAMING_CASE constants) is flagged.
const isComponentName = (name: string) =>
  /^[A-Z]/.test(name) && name !== name.toUpperCase() && !name.includes("_");

const IMPORT_RE =
  /import\s+(type\s+)?(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|[\w$]+|\*\s+as\s+[\w$]+)?\s*from\s*["']([^"']+)["']/g;

it("no server-capable module imports a non-component value from a 'use client' module", () => {
  const clientModules = new Set(files.filter((file) => isClientModule(readModule(file))));

  let crossings = 0;
  const violations: string[] = [];
  for (const file of files) {
    const source = readModule(file);
    if (isClientModule(source)) continue; // client importer — no boundary crossed

    for (const match of source.matchAll(IMPORT_RE)) {
      const [, typeOnly, , namedList, specifier] = match;
      if (typeOnly || !namedList || !specifier) continue; // `import type` / default / namespace
      const target = resolveImport(file, specifier).rel;
      if (!target || !clientModules.has(target)) continue;
      crossings++;

      for (const rawName of namedList.split(",")) {
        const name = rawName
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (!name || rawName.trim().startsWith("type ")) continue;
        if (!isComponentName(name)) {
          violations.push(`${file}: imports "${name}" from client module ${target}`);
        }
      }
    }
  }

  // Not vacuous: server-capable modules do import components across the boundary.
  expect(crossings).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

describe("directive and action-export matchers", () => {
  it("accepts a directive as the first statement, after comments", () => {
    expect(hasDisplacedDirective('"use server";\nimport x from "y";')).toBe(false);
    expect(hasDisplacedDirective('// note\n/* block */\n"use client";\n')).toBe(false);
    expect(isServerActionModule('// note\n"use server";\n')).toBe(true);
    expect(hasDisplacedDirective('import x from "y";\n')).toBe(false);
  });

  it("flags a directive below the first statement, raw or as biome rewrites it", () => {
    expect(hasDisplacedDirective('import x from "y";\n"use server";\n')).toBe(true);
    expect(hasDisplacedDirective('import x from "y";\n\n("use server");\n')).toBe(true);
    expect(hasDisplacedDirective('("use client");\n')).toBe(true);
    expect(hasDisplacedDirective('import x from "y";\n"use server"; // late\n')).toBe(true);
    expect(isServerActionModule('import x from "y";\n"use server";\n')).toBe(false);
  });

  it("allows only async functions and type declarations as action exports", () => {
    const source = [
      "export async function act() {}",
      "export type Result = { ok: true };",
      "export type Page<T extends Record<string, Array<T>>> = { rows: T[] };",
      "export type Split<",
      "export interface Input {}",
      "export type { Other } from './other';",
      "export { helper };",
      "export * from './x';",
      "export const LIMIT = 3;",
      "export function sync() {}",
      "export default async function main() {}",
    ].join("\n");
    expect(disallowedActionExports(source)).toEqual([
      "export type { Other } from './other';",
      "export { helper };",
      "export * from './x';",
      "export const LIMIT = 3;",
      "export function sync() {}",
      "export default async function main() {}",
    ]);
  });
});

it("every 'use server' / 'use client' directive is its module's first statement", () => {
  expect(files.filter((file) => hasDisplacedDirective(readModule(file)))).toEqual([]);
});

// Every export of a "use server" module is a public endpoint, so such a module
// only declares its own actions (plus erased type declarations): a re-export would
// publish someone else's function (re-exporting lib/quiz-verify.ts's loader would
// hand out the quiz's evaluation prompts), and even `export type { … }` crashes the
// module at load. `export const x = imported` is such a re-export in disguise, so
// only `export async function` declares an action here. A wrapper function is beyond
// any grep — this only stops the export forms.
it("a 'use server' module exports only async functions and type declarations", () => {
  const serverActionModules = files.filter((file) => isServerActionModule(readModule(file)));
  expect(serverActionModules).toContain("lib/tutor-actions.ts"); // not vacuous
  const offenders = serverActionModules.flatMap((file) =>
    disallowedActionExports(readModule(file)).map((line) => `${file}: ${line}`),
  );
  expect(offenders).toEqual([]);
});
