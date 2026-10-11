// Zod schema for the cloze ("Fill the gaps") YAML document — the strict AUTHORING
// gate, the cloze counterpart to `lib/quiz-schema.ts`. Every object uses
// `z.strictObject` so a typo (`evaluaton:`, `modle:`) surfaces as a schema error
// instead of being silently dropped. This describes the YAML DOCUMENT shape (nested
// `llm.model`), distinct from the flattened `Cloze` runtime interface in
// `lib/cloze-yaml.ts` — they are kept in sync by hand.
//
// The gap markup inside `text` is not a schema concern: `lib/cloze-validate.ts` runs
// the gap parser (`lib/cloze-gaps.ts`) over the schema-valid text and reports each
// problem with its line and column.
//
// A cloze exercise is ALWAYS anonymous (nothing links a submission to a student), so
// — like coding — there is NO `anonymous` field: the strict object rejects it.
//
// Teacher-facing prose lives in inline `.meta({ description })`; the generator
// (`lib/schema-gen`) emits it into `activities/cloze/cloze-yaml.schema.json`.

import { z } from "zod";
import { providerSchema, reasoningLevelSchema } from "@/lib/llm/provider";
import { FragmentFileRefSchema, TextFileRefSchema } from "@/lib/prompt-fragments";

export const ClozeYamlSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .meta({ description: "Short machine-readable exercise id, e.g. future-forms-sue." }),
  name: z.string().optional().meta({
    description: "Optional human-readable label for the teacher's lists (not shown to students).",
  }),
  title: z.string().optional().meta({
    description: 'Optional heading shown to students above the task (default: "Fill the gaps").',
  }),
  description: z.string().optional().meta({
    description:
      "Optional task shown to students in a box above the text (Markdown), e.g. which forms to use.",
  }),
  // `provider` selects which LLM endpoint serves `model` (default SCCH), and
  // `reasoning` optionally pins a reasoning model's effort level (absent ⇒ the
  // parameter is not sent). The one model grades the gaps AND writes the feedback.
  llm: z
    .strictObject({
      model: z.string().min(1).meta({
        description: "The model that grades the answers and writes the consolidated feedback.",
      }),
      provider: providerSchema,
      reasoning: reasoningLevelSchema,
    })
    .meta({
      id: "llm",
      description: "The single model + provider that grades the gaps and writes the feedback.",
    }),
  // Optional document-level prompt-fragment libraries (the tutor `prompt` shape
  // flattened to the root, identical to quiz). WHICH fragments are used is expressed
  // by inline `{{fragment "alias.id" …}}` markers inside `instructions` below.
  fragment_files: z.array(FragmentFileRefSchema).default([]).meta({
    description: "Optional fragment libraries this exercise pulls shared prompt fragments from.",
  }),
  text_files: z.array(TextFileRefSchema).default([]).meta({
    description:
      'Optional plain-text files (markdown / source) embedded verbatim into instructions via {{file "alias"}} markers.',
  }),
  // The exercise-level host text: a preamble rendered once and prepended to both the
  // grading and the feedback prompt. When any fragment_files or text_files are
  // declared it is a Handlebars template carrying the inline markers.
  instructions: z.string().optional().meta({
    description:
      'Optional preamble prepended to BOTH the grading prompt and the feedback prompt (e.g. a language policy). SERVER-ONLY. When any fragment_files or text_files are declared, place fragments inline with {{fragment "alias.id" …}} and embed text files with {{file "alias"}} (optionally {{file "alias" from=10 to=40}} for a line range; escape a literal {{ as \\{{).',
  }),
  evaluation: z.string().min(1).meta({
    description:
      "The grading criteria for the WHOLE exercise: its goal, and how far an answer may deviate from the reference and still be correct or partly correct. SERVER-ONLY: never sent to the browser.",
  }),
  text: z.string().min(1).meta({
    description:
      "The complete exercise text (Markdown) with each gap marked around its reference answer: [[answer]], [[answer|hint]] for a hint shown after the gap, [[]] where nothing belongs (an empty answer is correct). A gap opens and closes on one line; put gaps in ordinary sentences and list items. A literal [[ or ]] is not supported. 1 to 40 gaps, each answer at most 200 characters. The reference answers are SERVER-ONLY: students see only numbered gaps and hints.",
  }),
});
export type ClozeYaml = z.infer<typeof ClozeYamlSchema>;
