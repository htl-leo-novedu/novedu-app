// The single source that turns the zod authoring schemas into the JSON Schemas
// teachers point their editors at. zod is the source of truth (`lib/tutors/schemas.ts`,
// `lib/prompt-fragments/schemas.ts`, `lib/quiz-schema.ts`, `lib/writing-schema.ts`,
// `lib/coding-schema.ts`, `lib/cloze-schema.ts`, `lib/registry-schema.ts`); the teacher
// prose lives in inline `.meta({ description })`.
//
// `npm run generate:schemas` (scripts/generate-activity-schemas.ts) writes the eight
// files below; the hermetic drift-guard test (`generated-schemas.unit.test.ts`)
// deep-equals a fresh in-memory generation against the committed files, so an
// edited zod schema committed WITHOUT regenerating fails CI. Nothing in `app/` or
// `lib/` loads these `.schema.json` files — they are editor-only artifacts consumed
// solely by teachers' `# yaml-language-server: $schema=<github-raw-url>` modeline.

import { z } from "zod";
import { ClozeYamlSchema } from "@/lib/cloze-schema";
import { CodingYamlSchema } from "@/lib/coding-schema";
import { EvalYamlSchema } from "@/lib/eval-schema";
import { FragmentFileSchema } from "@/lib/prompt-fragments";
import { QuizYamlSchema } from "@/lib/quiz-schema";
import { RegistryYamlSchema } from "@/lib/registry-schema";
import { TutorSchema } from "@/lib/tutors/schemas";
import { WritingYamlSchema } from "@/lib/writing-schema";

/** The raw-GitHub base every generated `$id` (and every teacher modeline) points at. */
const RAW_BASE =
  "https://raw.githubusercontent.com/htl-leo-novedu/novedu-app/refs/heads/main/activities";

export interface SchemaRegistryEntry {
  /** Stable kind key (used only for test labels / logging). */
  kind: string;
  /** The zod root that IS the source of truth for this kind. */
  root: z.ZodType;
  /** Repo-relative path of the generated, committed JSON Schema. */
  outPath: string;
  /** The generated schema's `$id` (its canonical raw-GitHub URL). */
  id: string;
  /** Top-level JSON Schema `title`. */
  title: string;
  /**
   * Top-level JSON Schema `description`, authored fresh here — deliberately WITHOUT
   * any "kept in sync by hand / source of truth" provenance clause (the file is now
   * generated; the `$comment` banner records that).
   */
  description: string;
  /** The zod source file, named in the generated `$comment` provenance banner. */
  sourceFile: string;
}

/**
 * Every YAML kind that generates a JSON Schema. One flat top-level type each. Most are
 * activity kinds; `fragment`, `registry` and `eval` are the cross-cutting exceptions.
 */
export const schemaRegistry: readonly SchemaRegistryEntry[] = [
  {
    kind: "tutor",
    root: TutorSchema,
    outPath: "activities/tutors/tutor-yaml.schema.json",
    id: `${RAW_BASE}/tutors/tutor-yaml.schema.json`,
    title: "Tutor YAML",
    description: "Schema for a tutor definition: an AI chat tutor with an assembled system prompt.",
    sourceFile: "lib/tutors/schemas.ts",
  },
  {
    kind: "fragment",
    root: FragmentFileSchema,
    outPath: "activities/fragments/fragment-yaml.schema.json",
    id: `${RAW_BASE}/fragments/fragment-yaml.schema.json`,
    title: "Fragment Library YAML",
    description:
      "Schema for a reusable fragment library: a named collection of parameterized prompt fragments shared across activities.",
    sourceFile: "lib/prompt-fragments/schemas.ts",
  },
  {
    kind: "quiz",
    root: QuizYamlSchema,
    outPath: "activities/quizzes/quiz-yaml.schema.json",
    id: `${RAW_BASE}/quizzes/quiz-yaml.schema.json`,
    title: "Quiz YAML",
    description: "Schema for an LLM-graded, open-ended quiz definition.",
    sourceFile: "lib/quiz-schema.ts",
  },
  {
    kind: "writing",
    root: WritingYamlSchema,
    outPath: "activities/writings/writing-yaml.schema.json",
    id: `${RAW_BASE}/writings/writing-yaml.schema.json`,
    title: "Writing Activity YAML",
    description:
      "Schema for a writing activity: a split-screen Markdown editor with an AI writing coach.",
    sourceFile: "lib/writing-schema.ts",
  },
  {
    kind: "coding",
    root: CodingYamlSchema,
    outPath: "activities/coding/coding-yaml.schema.json",
    id: `${RAW_BASE}/coding/coding-yaml.schema.json`,
    title: "Coding Activity YAML",
    description:
      "Schema for a coding activity: an OpenAI-compatible coding endpoint an external coding agent (e.g. little-coder) points at.",
    sourceFile: "lib/coding-schema.ts",
  },
  {
    kind: "cloze",
    root: ClozeYamlSchema,
    outPath: "activities/cloze/cloze-yaml.schema.json",
    id: `${RAW_BASE}/cloze/cloze-yaml.schema.json`,
    title: "Cloze Exercise YAML",
    description:
      'Schema for a cloze exercise ("Fill the gaps"): one text whose gaps students complete, graded per gap with consolidated feedback.',
    sourceFile: "lib/cloze-schema.ts",
  },
  {
    kind: "registry",
    root: RegistryYamlSchema,
    outPath: "activities/registry/registry-yaml.schema.json",
    id: `${RAW_BASE}/registry/registry-yaml.schema.json`,
    title: "Activity Registry YAML",
    description:
      "Schema for an activity registry: the hand-written file listing a publication's activities under stable keys, reconciled by `novedu codes sync`.",
    sourceFile: "lib/registry-schema.ts",
  },
  {
    kind: "eval",
    root: EvalYamlSchema,
    outPath: "activities/evals/eval-yaml.schema.json",
    id: `${RAW_BASE}/evals/eval-yaml.schema.json`,
    title: "Eval YAML",
    description:
      "Schema for an eval file run by `novedu-cli eval`: either a golden-answer eval of a quiz rubric (teacher-written student answers with the verdict each must be graded with) or a tutor eval (scripted conversations whose next tutor response is generated and judged).",
    sourceFile: "lib/eval-schema.ts",
  },
] as const;

/**
 * Convert one registry entry's zod root into its final JSON Schema object.
 *
 * `io: "input"` gives the authoring view: fields with a zod `.default([])` render as
 * optional (kept out of `required`) with a `default:` hint — what a teacher's editor
 * should show. Reused sub-schemas carrying `.meta({ id })` become named `$defs`. The
 * top-level `$id` / `title` / `description` / provenance `$comment` are injected here
 * (the emitter only sets `$schema`), so the artifact self-documents that it is generated.
 */
export function toActivityJsonSchema(entry: SchemaRegistryEntry): Record<string, unknown> {
  const generated = z.toJSONSchema(entry.root, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;

  // The registry is authoritative for the top-level `title` / `description`; strip any
  // that the root schema's own `.meta()` emitted so it cannot override them via `...rest`.
  const { $schema, title: _title, description: _description, ...rest } = generated;

  return {
    $schema,
    $id: entry.id,
    $comment: `Generated from ${entry.sourceFile} by \`npm run generate:schemas\` — do not edit by hand.`,
    title: entry.title,
    description: entry.description,
    ...rest,
  };
}

/** Deterministic on-disk form: 2-space JSON + trailing newline (stable for the drift diff). */
export function serializeActivityJsonSchema(entry: SchemaRegistryEntry): string {
  return `${JSON.stringify(toActivityJsonSchema(entry), null, 2)}\n`;
}
