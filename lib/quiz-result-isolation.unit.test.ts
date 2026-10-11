import { describe, expect, it } from "vitest";
import { importSpecifiers, readModule, resolveImport, sourceFiles } from "@/tests/import-graph";

// Saved quiz results have NO teacher surface by construction (docs/home.md →
// Saving a quiz result): lib/quiz-result-store.ts is the only access to
// `novedu_quiz_results`, and only the student's own paths import it — the two
// save actions (quiz and cloze), the start page's facts, the Settings page and
// its actions, and the code-delete path (whose helper returns nothing). A new importer — a route
// handler, a bearer endpoint, a teacher page — must fail here first, and so must
// an existing importer reaching for a further store function (the teacher-facing
// code-delete path may only call the delete helper).

const STORE = "lib/quiz-result-store.ts";

// Importer → the store functions it may import (types are free).
const ALLOWED_IMPORTS: Record<string, string[]> = {
  "app/settings/page.tsx": ["countOwnQuizResults"],
  // The cloze exercise saves into the same store (docs/cloze.md → Saved results).
  "lib/cloze-actions.ts": ["saveQuizResult"],
  "lib/code-stats-store.ts": ["deleteResultsForCode"],
  "lib/quiz-actions.ts": ["saveQuizResult"],
  "lib/student-facts-store.ts": ["listOwnQuizResults"],
  "lib/user-settings-actions.ts": ["deleteOwnQuizResults"],
};

// The table object and its name: only the schema and the store spell them.
const TABLE_OWNERS = ["lib/db/schema.ts", STORE];

const production = sourceFiles("lib", "app", "components").map((rel) => ({
  rel,
  source: readModule(rel),
}));

describe("guard: saved quiz results have no reader but the student's own paths", () => {
  it("only the student's own paths import the quiz-result store, each only its own functions", () => {
    const imports = Object.fromEntries(
      production
        .filter(({ rel, source }) =>
          importSpecifiers(source).some((spec) => resolveImport(rel, spec).rel === STORE),
        )
        .map(({ rel, source }) => [
          rel,
          [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/quiz-result-store"/g)]
            .flatMap((m) => (m[1] ?? "").split(","))
            .map((name) => name.trim())
            .filter((name) => name && !name.startsWith("type "))
            .map((name) => name.split(/\s+as\s+/)[0]),
        ]),
    );
    expect(imports).toEqual(ALLOWED_IMPORTS);
  });

  it("no other module names the table object or the table", () => {
    const offenders = production
      .filter(({ rel }) => !TABLE_OWNERS.includes(rel))
      .filter(({ source }) => /\bquizResults\b|novedu_quiz_results/.test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
