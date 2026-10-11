import { parse as parseYamlText } from "yaml";
import { type ClozeGap, type ClozeSegment, parseClozeGaps, renderClozeText } from "./cloze-gaps";
import { type ClozePublic, clozeGapPlaceholder } from "./cloze-types";
import {
  DEFAULT_PROVIDER,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "./llm/provider";
import type { FragmentBlock } from "./prompt-fragments";
import { readFragmentBlock } from "./prompt-fragments/block";

// LENIENT runtime parse of a cloze YAML — the STUDENT path. Cloze exercises are
// stored in `novedu_files` under `kind: "cloze"`. A small typed read of just the
// essentials needed to show and grade the exercise, with a friendly message when
// something required is missing, so a student never hits a hard crash. It is NOT
// the authoring gate: the strict validator that blocks a bad SAVE lives in
// `lib/cloze-validate.ts` (`ClozeYamlSchema`). The gaps themselves are read by the
// SAME parser as there (`lib/cloze-gaps.ts`) — a text whose gaps cannot be shown or
// graded fails the load instead of rendering a broken exercise.
//
// SERVER-SIDE: exposes the server-only reference answers and `evaluation`. The
// student page must call `toPublicCloze` before sending anything to the browser, so
// neither ever crosses the wire. A cloze exercise is ALWAYS anonymous, so there is
// no `anonymous` flag here.

/** A parsed cloze exercise. Everything but `title`/`description` is server-side only. */
export interface Cloze {
  /** The exercise's own `id` (teacher tooling only). Falls back to `"cloze"`. */
  id: string;
  name?: string;
  title?: string;
  /** The task shown above the text (Markdown). */
  description?: string;
  /** The model id that grades the gaps AND writes the feedback. */
  model: string;
  /** The LLM provider serving `model` (`llm.provider`, default SCCH). */
  provider: LlmProvider;
  /** Optional reasoning effort for `model` (`llm.reasoning`); absent ⇒ none is sent. */
  reasoning?: ReasoningLevel;
  /**
   * The exercise-level host text (server-only, transient): the preamble of both
   * prompts, and — when the exercise declares `fragment_files`/`text_files` — the
   * Handlebars template carrying the inline markers. Left as authored here; the
   * loader renders it into `instructionsPreamble`.
   */
  instructions?: string;
  /** The unresolved document-level fragment block (server-only, transient). */
  fragmentBlock: FragmentBlock;
  /** The rendered preamble (server-only); empty until the loader resolves it. */
  instructionsPreamble: string;
  /** SERVER-ONLY exercise-level grading criteria. */
  evaluation: string;
  /** Every gap, in reading order, INCLUDING its server-only reference answer. */
  gaps: ClozeGap[];
  /** The text between the gaps (Markdown source), interleaved with the gaps. */
  segments: ClozeSegment[];
}

export type ClozeParseResult = { ok: true; cloze: Cloze } | { ok: false; message: string };

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() !== "" ? value : undefined;
  // YAML types unquoted scalars by value, so `title: 1` arrives as a number. Coerce a
  // finite number / boolean to its string form rather than silently dropping it.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Parses and lightly validates a cloze YAML. Returns a friendly error message (not
 * structured errors) when an essential field is missing or the gaps cannot be read —
 * the student page shows it as a notice.
 */
export function parseCloze(content: string): ClozeParseResult {
  let doc: unknown;
  try {
    doc = parseYamlText(content);
  } catch {
    return { ok: false, message: "This exercise could not be read — its YAML is not valid." };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, message: "This exercise is empty or malformed." };
  }
  const root = doc as Record<string, unknown>;

  const llm = root.llm as Record<string, unknown> | undefined;
  const model = asString(llm?.model);
  if (!model) {
    return { ok: false, message: "This exercise does not specify a model (llm.model)." };
  }

  // Missing ⇒ SCCH; present-but-invalid is rejected so a Foundry-intended exercise
  // never silently runs against SCCH.
  const provider =
    llm?.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(llm.provider);
  if (!provider) {
    return {
      ok: false,
      message:
        'This exercise uses an unsupported llm.provider (use "SCCH", "Azure Foundry" or "OpenRouter").',
    };
  }

  // Absent ⇒ no reasoning effort is sent; present-but-invalid is rejected so an
  // exercise never silently grades at the model's default effort.
  const reasoning =
    llm?.reasoning === undefined ? undefined : parseLenientReasoningLevel(llm.reasoning);
  if (llm?.reasoning !== undefined && !reasoning) {
    return {
      ok: false,
      message: `This exercise uses an unsupported llm.reasoning (one of ${REASONING_LEVELS.join(", ")}).`,
    };
  }

  const evaluation = asString(root.evaluation);
  if (!evaluation) {
    return { ok: false, message: "This exercise has no grading criteria (evaluation)." };
  }

  const text = asString(root.text);
  if (!text) return { ok: false, message: "This exercise has no text." };
  const parsed = parseClozeGaps(text);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "The gaps of this exercise could not be read — ask your teacher to check its text.",
    };
  }

  return {
    ok: true,
    cloze: {
      id: asString(root.id) ?? "cloze",
      name: asString(root.name),
      title: asString(root.title),
      description: asString(root.description),
      model,
      provider,
      reasoning,
      instructions: asString(root.instructions),
      fragmentBlock: readFragmentBlock(root),
      instructionsPreamble: "",
      evaluation,
      gaps: parsed.gaps,
      segments: parsed.segments,
    },
  };
}

/**
 * The student-facing projection — the title, the task and the text with every gap
 * replaced by its numbered placeholder, plus each gap's number and hint. It copies
 * only these whitelisted public fields, so the reference answers, `evaluation`,
 * `instructions`, the fragment block, the rendered preamble and the `llm` block can
 * never leak.
 */
export function toPublicCloze(cloze: Cloze): ClozePublic {
  return {
    title: cloze.title,
    description: cloze.description,
    text: renderClozeText(cloze, (gap) => clozeGapPlaceholder(gap.number)),
    gaps: cloze.gaps.map((gap) => ({
      number: gap.number,
      ...(gap.hint ? { hint: gap.hint } : {}),
    })),
  };
}
