import { describe, expect, it } from "vitest";
import { importSpecifiers, readModule, resolveImport, sourceFiles } from "@/tests/import-graph";

// Moodle links and hand-in targets have NO teacher surface by construction
// (docs/moodle.md): lib/moodle-store.ts is the only access to
// `novedu_moodle_links` and `novedu_moodle_targets`, and only the student's own
// paths import it — the arrival check and route, the Moodle actions, the quiz
// page (its own target), the Settings page (its own link) and the code-delete
// path (whose helper returns nothing). A new importer — a route handler, a
// bearer endpoint, a teacher page — must fail here first, and so must an
// existing importer reaching for a further store function.

const STORE = "lib/moodle-store.ts";

// Importer → the store functions it may import (types are free).
const ALLOWED_IMPORTS: Record<string, string[]> = {
  "app/[code]/render-quiz.tsx": ["getOwnTarget"],
  "app/lti/arrive/route.ts": ["storeTarget"],
  "app/settings/page.tsx": ["getOwnLink"],
  "lib/code-stats-store.ts": ["deleteTargetsForCode"],
  "lib/moodle-actions.ts": [
    "getOwnLink",
    "getOwnTarget",
    "linkAndStoreTarget",
    "markHandedIn",
    "storeTarget",
    "unlinkOwn",
  ],
  "lib/moodle-arrival.ts": ["findLinkState"],
};

// The table objects and their names: only the schema and the store spell them.
const TABLE_OWNERS = ["lib/db/schema.ts", STORE];

const production = sourceFiles("lib", "app", "components").map((rel) => ({
  rel,
  source: readModule(rel),
}));

describe("guard: Moodle links and targets have no reader but the student's own paths", () => {
  it("only the student's own paths import the Moodle store, each only its own functions", () => {
    const imports = Object.fromEntries(
      production
        .filter(({ rel, source }) =>
          importSpecifiers(source).some((spec) => resolveImport(rel, spec).rel === STORE),
        )
        .map(({ rel, source }) => [
          rel,
          [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/moodle-store"/g)]
            .flatMap((m) => (m[1] ?? "").split(","))
            .map((name) => name.trim())
            .filter((name) => name && !name.startsWith("type "))
            .map((name) => name.split(/\s+as\s+/)[0]),
        ]),
    );
    expect(imports).toEqual(ALLOWED_IMPORTS);
  });

  it("no other module names the table objects or the tables", () => {
    const offenders = production
      .filter(({ rel }) => !TABLE_OWNERS.includes(rel))
      .filter(({ source }) =>
        /\bmoodleLinks\b|\bmoodleTargets\b|novedu_moodle_links|novedu_moodle_targets/.test(source),
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
