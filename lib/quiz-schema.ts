// Zod schema for the quiz YAML document — the strict AUTHORING gate, the quiz
// counterpart to `lib/tutors/schemas.ts`. Every object uses `z.strictObject` so a
// typo (`anonymouss:`, `evluation:`) surfaces as a schema error instead of being
// silently dropped. This describes the YAML DOCUMENT shape (nested `llm.model`,
// `discussion.instructions`), distinct from the flattened `Quiz` runtime interface
// in `lib/quiz-yaml.ts` — they are kept in sync by hand.
//
// Authoring stays deliberately STRICTER than the lenient runtime `parseQuiz`: ids
// must be strings (quote a numeric-looking id), nothing is coerced. The runtime
// parser exists so a student never hits a hard crash; this gate exists so a teacher
// never SAVES a structurally broken quiz.
//
// Teacher-facing prose lives in inline `.meta({ description })`; the generator
// (`lib/schema-gen`) emits it into `activities/quizzes/quiz-yaml.schema.json`.
// Reused sub-schemas carry `.meta({ id })` so the generator emits named `$defs`.

import { z } from "zod";
import { providerSchema, reasoningLevelSchema } from "@/lib/llm/provider";
import { FragmentFileRefSchema, TextFileRefSchema } from "@/lib/prompt-fragments";

/**
 * A live quiz include: alias + URL, mirroring `FragmentFileRefSchema` (same URL
 * contract). The alias prefixes every imported question id as `"<alias>/<id>"`, so
 * on top of the no-dot rule it may not contain a `/` either. Aliases live in their
 * OWN namespace (they never appear in `{{…}}` markers — only in question ids).
 */
const QuizFileRefSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[^./]+$/, { message: "Alias must not contain a dot or a slash" })
      .meta({
        pattern: "^[^./]+$",
        description:
          'Local alias for this included quiz. Prefixes every imported question id as "<alias>/<id>", so it may not contain a dot or a slash.',
      }),
    url: FragmentFileRefSchema.shape.url.meta({
      pattern: "^(https?://|(?![A-Za-z][A-Za-z0-9+.-]*:).+)$",
      description: "HTTP(S) URL or relative path to the included quiz file.",
    }),
  })
  .meta({
    id: "quizFileRef",
    description: "A reference to another quiz file whose questions are included live.",
  });

/** An optional content image attached to a question (carries no secret). */
const ImageRefSchema = z
  .strictObject({
    hosted: z.boolean().optional().meta({
      default: false,
      description:
        "When true, src is an app-hosted image NAME resolved server-side; otherwise src is an absolute URL or a path relative to the quiz's own URL.",
    }),
    src: z.string().min(1).meta({
      description: "The hosted image name (when hosted) or the image URL / relative path.",
    }),
    alt: z
      .string()
      .optional()
      .meta({ description: "Accessible description shown if the image cannot be loaded." }),
    credit: z.string().optional().meta({
      description: 'Optional attribution ("Content Credentials") shown small below the image.',
    }),
  })
  .meta({ id: "image", description: "An optional content image attached to a question." });

/**
 * One question. `id` keys the per-question stats (must be unique — see
 * `lib/quiz-validate.ts`); `question` is the Markdown shown to the student;
 * `evaluation` is the server-only grading prompt.
 */
const QuizQuestionSchema = z
  .strictObject({
    id: z.string().min(1).meta({
      description: "Stable question id, unique within the quiz (the per-question stats key).",
    }),
    title: z
      .string()
      .optional()
      .meta({ description: "Optional short label for the stats table and progress display." }),
    question: z.string().min(1).meta({ description: "The Markdown shown to the student." }),
    evaluation: z.string().min(1).meta({
      description:
        "The grading prompt. SERVER-ONLY: never sent to the browser, so it may embed the expected answer and the grading rubric.",
    }),
    image: ImageRefSchema.optional(),
    // Overrides the quiz-level `llm.imageInput` for this question only.
    imageInput: z.boolean().optional().meta({
      description:
        "Overrides the quiz-level llm.imageInput for this question only (photo answers on/off).",
    }),
  })
  .meta({ id: "question", description: "One open-ended, LLM-graded quiz question." });

export const QuizYamlSchema = z.strictObject({
  id: z.string().min(1).meta({
    description:
      "Short machine-readable quiz id, e.g. countries-basics. Used as the per-quiz identity.",
  }),
  name: z
    .string()
    .optional()
    .meta({ description: "Optional human-readable quiz title (used as a label)." }),
  // Student-facing welcome screen (both optional).
  title: z.string().optional().meta({
    description:
      "Optional greeting shown to students on the welcome screen instead of the default message.",
  }),
  description: z.string().optional().meta({
    description: "Optional description shown to students below the welcome greeting (Markdown).",
  }),
  // Privacy: quizzes default `anonymous: true` (answers recorded for aggregate
  // stats but not linked to a student). `anonymous: false` attributes each attempt.
  anonymous: z.boolean().optional().meta({
    default: true,
    description:
      "Quizzes are anonymous by default: answers are recorded for aggregate stats but not linked to a student. Set to false to attribute each attempt to the signed-in student.",
  }),
  // Random question order per attempt, default true.
  shuffle: z.boolean().optional().meta({
    default: true,
    description:
      "Present questions in a random order per attempt. Set to false to keep the authored order.",
  }),
  // Attempt length: how many questions one attempt asks. Purely a runner-side
  // sequence bound — grading stays per-question and stateless; there is no
  // server-side attempt enforcement.
  question_count: z.number().int().min(1).optional().meta({
    description:
      "How many questions one attempt asks (default: every question exactly once). May exceed the pool size — then questions repeat (drill mode). With shuffle off, fewer than the pool means the first N in authored order.",
  }),
  // Live includes: pull ALL questions of the referenced quiz files into this
  // quiz's pool, fresh on every load (like fragment_files — editing a chapter
  // quiz immediately updates the compound quiz). One level deep only: an
  // included quiz may not itself declare quiz_files. Imported question ids are
  // namespaced "<alias>/<id>"; each imported question travels with its source
  // quiz's rendered `instructions` preamble so it grades identically in both
  // places. Everything else of an included quiz (llm, anonymous, shuffle,
  // discussion, title, description, question_count) is ignored.
  quiz_files: z.array(QuizFileRefSchema).default([]).meta({
    description:
      "Other quiz files whose questions are ALL included live into this quiz (a compound/final quiz). One level deep — an included quiz may not itself declare quiz_files.",
  }),
  // `provider` selects which LLM endpoint serves `model` (default SCCH), and
  // `reasoning` optionally pins a reasoning model's effort level (absent ⇒ the
  // parameter is not sent); the one model grades answers AND drives the discussion chat. `imageInput` (default
  // false) lets students attach photos to their answers — the model must be
  // vision-capable; a per-question `imageInput` overrides it.
  llm: z
    .strictObject({
      model: z.string().min(1).meta({
        description: "The model that grades answers and drives the per-question discussion chat.",
      }),
      provider: providerSchema,
      reasoning: reasoningLevelSchema,
      imageInput: z.boolean().optional().meta({
        default: false,
        description:
          "Default for all questions: students may attach photos (up to 3, 5 MB each) to their answers. The model must be vision-capable. A per-question imageInput overrides it.",
      }),
    })
    .meta({
      id: "llm",
      description: "The single model + provider that grades and discusses answers.",
    }),
  // Optional guidance for the per-question follow-up discussion chat. A host text
  // exactly like `instructions`: it may carry inline fragment/file markers, rendered
  // against the quiz's own fragment_files/text_files.
  discussion: z
    .strictObject({
      instructions: z.string().min(1).meta({
        description:
          'Optional guidance appended to the per-question follow-up discussion chat\'s system prompt. When any fragment_files or text_files are declared, place fragments inline with {{fragment "alias.id" …}} and embed text files with {{file "alias"}} (escape a literal {{ as \\{{) — same rules as instructions.',
      }),
    })
    .optional()
    .meta({
      id: "discussion",
      description: "Optional guidance for the per-question follow-up discussion chat.",
    }),
  // Optional document-level prompt-fragment libraries (the tutor `prompt` shape
  // flattened to the root). WHICH fragments are used is expressed by inline
  // `{{fragment "alias.id" …}}` markers inside the quiz's two host texts — the
  // quiz-level `instructions` below (rendered text prepended to BOTH the grader
  // prompt and the discussion chat's system prompt, see `lib/quiz-fetch.ts`) and
  // `discussion.instructions` above. Per-question `evaluation` stays a plain
  // string — no markers there.
  fragment_files: z.array(FragmentFileRefSchema).default([]).meta({
    description: "Optional fragment libraries this quiz pulls shared prompt fragments from.",
  }),
  // Optional plain-text files embedded verbatim into the quiz-level `instructions` via
  // inline `{{file "alias"}}` markers (the tutor `prompt.text_files` shape at the root).
  text_files: z.array(TextFileRefSchema).default([]).meta({
    description:
      'Optional plain-text files (markdown / source) embedded verbatim into instructions via {{file "alias"}} markers.',
  }),
  // The quiz-level host text: a preamble rendered once and prepended to both the
  // grader and the discussion prompts. When any fragment_files or text_files are
  // declared it is a Handlebars template carrying the inline markers.
  instructions: z.string().optional().meta({
    description:
      'Optional quiz-level preamble prepended to BOTH the grader prompt and the discussion chat. When any fragment_files or text_files are declared, place fragments inline with {{fragment "alias.id" …}} and embed text files with {{file "alias"}} (optionally {{file "alias" from=10 to=40}} for a line range; escape a literal {{ as \\{{).',
  }),
  // May be empty ONLY when `quiz_files` includes supply the pool — the resolved
  // pool (own + imported) must be ≥ 1, checked in `lib/quiz-validate.ts`
  // (`QUIZ_NO_QUESTIONS`), where the includes are actually fetched.
  questions: z.array(QuizQuestionSchema).default([]).meta({
    description:
      "The quiz questions. Each is open-ended and graded by the LLM via its evaluation prompt. May be omitted when quiz_files supplies the questions.",
  }),
});
export type QuizYaml = z.infer<typeof QuizYamlSchema>;
