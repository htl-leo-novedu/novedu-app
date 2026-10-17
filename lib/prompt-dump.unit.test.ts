import { describe, expect, it } from "vitest";
import { PROMPT_KINDS, promptDumpers, verdictResponseJsonSchema } from "@/lib/prompt-dump";
import {
  importSpecifiers,
  readModule as read,
  sourceFiles,
  walkClosure,
} from "../tests/import-graph";

// Two things this file guards, both of which would silently break `novedu-cli prompts`:
//
//  1. PURITY — nothing the CLI bundles (the dump seam and everything `cli/src/**`
//     reaches) may import `app/**` (whose graph pulls in `app/mastra/scch.ts`, a
//     top-level `await` network call at IMPORT time, via `lib/llm/model.ts`), the
//     database, the session, or carry a `"use server"` directive.
//  2. NO SECOND IMPLEMENTATION — the dump seam, `lib/quiz-actions.ts` and
//     `lib/code-modules/quiz.ts` must IMPORT the extracted prompt builders, never
//     redefine them, or a dumped prompt would drift from the one production sends.

/** The seam modules the closure walk below must reach (so it cannot pass on nothing). */
const PURE_MODULES = [
  "lib/prompt-dump.ts",
  "lib/quiz-grading-prompt.ts",
  "lib/quiz-discussion-prompt.ts",
  "lib/quiz-verdict-schema.ts",
  "lib/quiz-feedback-judge.ts",
  "lib/tutor-judge.ts",
  "lib/quiz-resolve.ts",
  "lib/writing-resolve.ts",
  "lib/coding-resolve.ts",
  // The shared activity load every lenient kind's resolver calls.
  "lib/activity-load.ts",
  // The eval format layer (docs/cli-eval.md) is bundled into the CLI too and calls
  // straight into the dump seam, so it lives under the identical purity rule.
  "lib/eval-schema.ts",
  "lib/eval-validate.ts",
];

describe("prompt-dump purity invariant", () => {
  it("exposes exactly one dumper per prompt-producing FileKind", () => {
    expect(Object.keys(promptDumpers).sort()).toEqual([...PROMPT_KINDS].sort());
  });

  // Rooted at every `cli/src/**` module, so each CLI entry point into lib/ — the dump
  // seam, the eval layer and judges, the validators, the registry schema, the
  // conversation export — is walked with everything it reaches transitively, in every
  // specifier form (relative paths like "./llm/model", side-effect imports,
  // `export … from` re-exports, dynamic `import()`).
  it("keeps the CLI's ENTIRE transitive import closure app-free and 'use server'-free", () => {
    // Repo-relative paths whose import — even type-only, even N levels deep — must fail
    // the guard. Matched against the RESOLVED path, so "./db", "@/lib/db" and
    // "../lib/db" are all the same offender.
    const FORBIDDEN: RegExp[] = [
      /^app\//, // pulls in app/mastra/scch.ts (top-level-await network call) sooner or later
      /^auth\.ts$/,
      /^lib\/session\.ts$/,
      /^lib\/db(\/|\.ts$)/,
      /^lib\/llm\/model\.ts$/,
      /^lib\/file-store\.ts$/,
      /^lib\/code-store\.ts$/,
      /^lib\/app-hosted-yaml\.ts$/,
      /^lib\/app-hosted-fetcher\.ts$/,
    ];

    const offenders: string[] = [];
    // Only existing .ts/.tsx files continue the walk — a specifier that resolves to
    // nothing still has to clear FORBIDDEN, it just has no source to follow.
    const visited = walkClosure(sourceFiles("cli/src"), ({ rel, source, imports }) => {
      if (/^\s*["']use server["']/m.test(source)) offenders.push(`${rel}: "use server"`);
      const next: string[] = [];
      for (const { specifier, rel: target, exists } of imports) {
        if (target === null) continue;
        if (FORBIDDEN.some((pattern) => pattern.test(target))) {
          offenders.push(`${rel} → ${specifier}`);
        } else if (exists && /\.tsx?$/.test(target)) {
          next.push(target);
        }
      }
      return next;
    });
    expect(offenders, `server-only reach from the CLI:\n${offenders.join("\n")}`).toEqual([]);
    // Anti-vacuous sanity: the walk must have actually reached every documented seam
    // module (a broken resolver would otherwise make this test pass on nothing).
    for (const mod of PURE_MODULES) {
      expect(visited.has(mod), `${mod} was not reached by the import walk`).toBe(true);
    }
  });
});

describe("no second implementation of the prompts", () => {
  it("lib/prompt-dump.ts imports the production builders instead of defining its own", () => {
    const src = read("lib/prompt-dump.ts");
    expect(importSpecifiers(src)).toEqual(
      expect.arrayContaining([
        "@/lib/quiz-grading-prompt",
        "@/lib/quiz-discussion-prompt",
        "@/lib/coding-proxy",
        "@/lib/tutors",
      ]),
    );
    expect(src).not.toMatch(
      /\b(function|const|let)\s+build(GradingPrompt|DiscussionInstructions|UpstreamChatBody)\b/,
    );
  });

  it("lib/quiz-actions.ts imports the grading prompt instead of defining one", () => {
    const src = read("lib/quiz-actions.ts");
    expect(src).toMatch(/from "@\/lib\/quiz-grading-prompt"/);
    expect(src).not.toMatch(/function buildGradingPrompt/);
    // The user-message wrappers come from the same module (the dump emits them).
    expect(src).toMatch(/\bbuildAnswerMessage\b/);
    expect(src).not.toMatch(/The student's answer:/);
  });

  it("lib/quiz-actions.ts seeds discussions from the shared templates", () => {
    const src = read("lib/quiz-actions.ts");
    expect(src).toMatch(/from "@\/lib\/quiz-discussion-prompt"/);
    expect(src).not.toMatch(/Answer the following question:/);
    expect(src).not.toMatch(/Your answer is \$\{/);
  });

  it("lib/code-modules/quiz.ts imports the discussion prompt instead of defining one", () => {
    const src = read("lib/code-modules/quiz.ts");
    expect(src).toMatch(/from "@\/lib\/quiz-discussion-prompt"/);
    expect(src).not.toMatch(/function buildDiscussionInstructions/);
  });

  it("app/mastra/quiz-agents.ts re-exports the verdict schema from the pure module", () => {
    const src = read("app/mastra/quiz-agents.ts");
    expect(src).toMatch(/export \{ QUIZ_VERDICT_SCHEMA \} from "@\/lib\/quiz-verdict-schema"/);
    expect(src).not.toMatch(/QUIZ_VERDICT_SCHEMA = z\.object/);
  });
});

describe("verdictResponseJsonSchema", () => {
  it("is the grader's `{ result, feedback }` contract as plain JSON Schema", () => {
    const schema = verdictResponseJsonSchema();
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        result: { type: "string", enum: ["correct", "partial", "incorrect"] },
        feedback: { type: "string" },
      },
      required: ["result", "feedback"],
    });
    // Plain JSON — the eval harness must be able to `JSON.stringify` it as-is.
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});
