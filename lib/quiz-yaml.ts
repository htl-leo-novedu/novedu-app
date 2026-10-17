import { parse as parseYamlText } from "yaml";
import type { ImageRef } from "./image-ref";
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
import type { QuizPublic, QuizQuestionPublic } from "./quiz-types";

// LENIENT runtime parse of a quiz YAML — the STUDENT path. Quizzes are stored in
// `novedu_files` under `kind: "quiz"`. This is a small typed read that checks just
// the essentials needed to run and grade the quiz, with a friendly message when
// something required is missing, so a student never hits a hard crash. It is NOT
// the authoring gate: the strict schema/Zod validator that blocks a bad SAVE lives
// in `lib/quiz-validate.ts` (`QuizYamlSchema`) and is deliberately separate and
// stricter than this read.
//
// SERVER-SIDE: parses YAML and exposes the server-only `evaluation` prompts.
// The student page must call `toPublicQuiz` before sending anything to the
// browser, so the grading prompts never cross the wire.

/** One question, INCLUDING its server-only grading prompt. */
export interface QuizQuestion {
  id: string;
  title?: string;
  /** Markdown shown to the student. */
  question: string;
  /** SERVER-ONLY grading prompt — embeds the expected answer + criteria. */
  evaluation: string;
  /** Optional content image — carries no secret, so it survives into the public projection. */
  image?: ImageRef;
  /** Per-question override of the quiz-level `imageInput` (unset ⇒ inherit). */
  imageInput?: boolean;
  /**
   * SERVER-ONLY, set at import time by `loadQuiz` on questions pulled in via
   * `quiz_files`: the SOURCE quiz's rendered `instructions` preamble, so an imported
   * question grades (and discusses) identically in its chapter quiz and in the
   * compound quiz. Never set on a quiz's own questions; `toPublicQuiz` drops it
   * exactly like `evaluation`.
   */
  sourcePreamble?: string;
}

/**
 * A `quiz_files` include reference as lifted by the lenient parser — mirrors
 * `FragmentFileRef` (alias + URL; the alias additionally may not contain `/`).
 * Passed through as-is for `loadQuiz` to resolve FAIL-CLOSED (like
 * `readFragmentBlock` defers structural errors to resolve time); the strict
 * authoring shape lives in `lib/quiz-schema.ts`.
 */
export interface QuizFileRef {
  id: string;
  url: string;
}

/** A fully parsed quiz. `evaluation` prompts and `model` are server-side only. */
export interface Quiz {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  /** Privacy flag, read LIVE from the YAML. Default `true` (anonymous). */
  anonymous: boolean;
  /** Random question order per attempt. Default `true`. */
  shuffle: boolean;
  /** The model id that grades answers AND drives the discussion chat. */
  model: string;
  /** The LLM provider serving `model` (`llm.provider`, default SCCH). */
  provider: LlmProvider;
  /**
   * Optional reasoning effort for `model` (`llm.reasoning`). Absent ⇒ no
   * `reasoning_effort` is sent and the model's own default applies.
   */
  reasoning?: ReasoningLevel;
  /**
   * Quiz-level default for photo answers (`llm.imageInput`, default `false` —
   * the model must be vision-capable). Per-question `imageInput` overrides it.
   */
  imageInput: boolean;
  /**
   * Questions per attempt (`question_count`). Omitted ⇒ every pool question exactly
   * once (today's behavior); may exceed the pool size (drill mode — questions
   * repeat). A pure runner-side sequence bound: grading stays per-question and
   * stateless, no server-side attempt enforcement.
   */
  questionCount?: number;
  /**
   * Optional guidance appended to the discussion chat's system prompt
   * (`discussion.instructions`). A host text exactly like `instructions`: when the
   * quiz declares `fragment_files`/`text_files` it may carry inline
   * `{{fragment}}`/`{{file}}` markers. `parseQuiz` leaves it as authored; `loadQuiz`
   * replaces it with the rendered result (both host texts render in one pass).
   */
  discussionInstructions?: string;
  /**
   * The quiz-level host text (server-only, transient): the preamble prepended to both
   * prompts, and — when the quiz declares `fragment_files` — the Handlebars template
   * carrying the inline `{{fragment}}` markers. `parseQuiz` leaves it as authored;
   * `loadQuiz` renders it into `instructionsPreamble`.
   */
  instructions?: string;
  /**
   * The unresolved document-level fragment block (server-only, transient). `parseQuiz`
   * leaves it here for `loadQuiz` to fetch libraries and render `instructions` into
   * `instructionsPreamble`; `loadQuiz` then clears it (`EMPTY_FRAGMENT_BLOCK`) so the
   * resolved preamble is the single source of truth and no stale block lingers.
   */
  fragmentBlock: FragmentBlock;
  /**
   * The unresolved `quiz_files` include list (server-only, transient), lifted as-is
   * like the fragment block. `loadQuiz` fetches each include, namespaces + merges its
   * questions into `questions`, then clears this to `[]` so the merged pool is the
   * single source of truth. Any structural problem (bad ref, unfetchable, nested
   * includes, duplicate alias) fails the LOAD closed — the compound quiz must never
   * silently shrink.
   */
  quizFiles: QuizFileRef[];
  /**
   * The rendered quiz-level preamble (server-only), prepended to BOTH the grader prompt
   * and the discussion chat's system prompt. It is the `instructions` host text with any
   * inline fragments resolved in place. Empty until `loadQuiz` resolves it, and empty
   * when the quiz has no `instructions`. Never reaches the browser (`toPublicQuiz` drops
   * it, exactly like the per-question `evaluation` prompts).
   */
  instructionsPreamble: string;
  questions: QuizQuestion[];
}

export type QuizParseResult = { ok: true; quiz: Quiz } | { ok: false; message: string };

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() !== "" ? value : undefined;
  // YAML types unquoted scalars by value, so `id: 1` arrives as a number and
  // `id: true` as a boolean. Coerce a finite number / boolean to its string form
  // rather than silently dropping the field — a teacher writing the natural
  // `- id: 1` must not lose the whole question (nor a numeric title/name vanish).
  // NaN/Infinity stay rejected: they make no sense as an id and `String()` them
  // would only produce a confusing "NaN"/"Infinity" value.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// LENIENT read of an optional content image. Only a non-null object with a
// trimmed non-empty string `src` yields a ref; anything malformed is dropped so
// the question still renders without an image. `hosted` defaults to `false`;
// `alt` and `credit` (the attribution shown below the image) are carried through
// only when each is a trimmed non-empty string.
function asImageRef(value: unknown): ImageRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const src = asString(obj.src);
  if (!src) return undefined;
  const alt = asString(obj.alt);
  const credit = asString(obj.credit);
  return {
    hosted: asBool(obj.hosted, false),
    src,
    ...(alt ? { alt } : {}),
    ...(credit ? { credit } : {}),
  };
}

/**
 * Parses and lightly validates a quiz YAML. Returns a friendly error message
 * (not structured errors) when an essential field is missing — the student page
 * shows it as a notice. `anonymous` and `shuffle` default to `true`.
 */
export function parseQuiz(content: string): QuizParseResult {
  let doc: unknown;
  try {
    doc = parseYamlText(content);
  } catch {
    return { ok: false, message: "This quiz could not be read — its YAML is not valid." };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, message: "This quiz is empty or malformed." };
  }
  const root = doc as Record<string, unknown>;

  const llm = root.llm as Record<string, unknown> | undefined;
  const model = asString(llm?.model);
  if (!model) {
    return { ok: false, message: "This quiz does not specify a model (llm.model)." };
  }

  // Missing ⇒ SCCH; present-but-invalid is rejected so a Foundry-intended quiz
  // never silently runs against SCCH.
  const provider =
    llm?.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(llm.provider);
  if (!provider) {
    return {
      ok: false,
      message:
        'This quiz uses an unsupported llm.provider (use "SCCH", "Azure Foundry" or "OpenRouter").',
    };
  }

  // Absent ⇒ no reasoning effort is sent; present-but-invalid is rejected so a
  // quiz never silently grades at the model's default effort.
  const reasoning =
    llm?.reasoning === undefined ? undefined : parseLenientReasoningLevel(llm.reasoning);
  if (llm?.reasoning !== undefined && !reasoning) {
    return {
      ok: false,
      message: `This quiz uses an unsupported llm.reasoning (one of ${REASONING_LEVELS.join(", ")}).`,
    };
  }

  // Lifted leniently like the fragment block: the declared array passes through as-is
  // for `loadQuiz` to resolve fail-closed (a malformed entry errors the LOAD rather
  // than silently dropping a chapter's questions).
  const quizFiles = Array.isArray(root.quiz_files) ? (root.quiz_files as QuizFileRef[]) : [];

  const rawQuestions = Array.isArray(root.questions) ? root.questions : [];
  // Zero own questions is fine when includes will supply the pool.
  if (rawQuestions.length === 0 && quizFiles.length === 0) {
    return { ok: false, message: "This quiz has no questions." };
  }

  const questions: QuizQuestion[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawQuestions) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    const id = asString(q.id);
    const question = asString(q.question);
    const evaluation = asString(q.evaluation);
    // A question is usable only with a stable id, a prompt to show, and a
    // grading prompt — skip anything missing one rather than failing the quiz.
    if (!id || !question || !evaluation || seenIds.has(id)) continue;
    seenIds.add(id);
    questions.push({
      id,
      title: asString(q.title),
      question,
      evaluation,
      image: asImageRef(q.image),
      // Only a literal boolean overrides; anything malformed inherits the
      // quiz-level flag rather than failing the quiz.
      ...(typeof q.imageInput === "boolean" ? { imageInput: q.imageInput } : {}),
    });
  }
  if (questions.length === 0 && quizFiles.length === 0) {
    return {
      ok: false,
      message: "This quiz has no complete questions (each needs an id, question and evaluation).",
    };
  }

  // Malformed (non-integer, < 1, non-number) ⇒ ignored, i.e. the default "every
  // pool question exactly once" — never fails the quiz for a student.
  const rawCount = root.question_count;
  const questionCount =
    typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 1
      ? rawCount
      : undefined;

  return {
    ok: true,
    quiz: {
      id: asString(root.id) ?? asString(root.name) ?? "quiz",
      name: asString(root.name),
      title: asString(root.title),
      description: asString(root.description),
      anonymous: asBool(root.anonymous, true),
      shuffle: asBool(root.shuffle, true),
      model,
      provider,
      reasoning,
      questionCount,
      imageInput: asBool(llm?.imageInput, false),
      discussionInstructions: asString(
        (root.discussion as Record<string, unknown> | undefined)?.instructions,
      ),
      // The quiz-level host text + unresolved fragment block are carried through for
      // `loadQuiz` to render; `parseQuiz` leaves the preamble empty (needs the network).
      instructions: asString(root.instructions),
      fragmentBlock: readFragmentBlock(root),
      quizFiles,
      instructionsPreamble: "",
      questions,
    },
  };
}

/**
 * A question's EFFECTIVE photo-answers flag: the per-question override when set, the
 * quiz-level `llm.imageInput` otherwise. The ONE definition of that two-level rule —
 * re-exported by `lib/quiz-verify.ts` for the server actions (which re-derive it on
 * every request, never trusting the client), applied by `toPublicQuiz` below, and
 * reported per question by the prompt dump.
 */
export function effectiveImageInput(quiz: Quiz, question: QuizQuestion): boolean {
  return question.imageInput ?? quiz.imageInput;
}

/**
 * The student-facing projection — strips every server-only field, above all the
 * `evaluation` grading prompts, the per-question `sourcePreamble`s, the `instructions`
 * host text, the `fragmentBlock`/`quizFiles`, and the rendered `instructionsPreamble`,
 * before anything reaches the browser (it copies only the whitelisted public fields
 * below, so the server-only ones can never leak).
 */
export function toPublicQuiz(quiz: Quiz): QuizPublic {
  const questions: QuizQuestionPublic[] = quiz.questions.map((q) => ({
    id: q.id,
    title: q.title,
    question: q.question,
    // The image carries no secret (unlike `evaluation`) — pass it through unchanged.
    image: q.image,
    // Resolve the two-level flag here so the client sees ONE effective boolean
    // per question (the server actions re-derive it — the client is never trusted).
    imageInput: effectiveImageInput(quiz, q),
  }));
  return {
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    shuffle: quiz.shuffle,
    // The EFFECTIVE attempt length: the authored `question_count`, defaulting to the
    // (resolved) pool size — the runner builds its sequence from this one number.
    questionCount: quiz.questionCount ?? quiz.questions.length,
    questions,
  };
}
