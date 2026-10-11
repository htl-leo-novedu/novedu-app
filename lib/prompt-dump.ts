import { z } from "zod";
import {
  buildClozeFeedbackPrompt,
  CLOZE_FEEDBACK_MESSAGE_TEMPLATE,
} from "@/lib/cloze-feedback-prompt";
import {
  buildClozeGradingPrompt,
  CLOZE_GRADING_MESSAGE_TEMPLATE,
} from "@/lib/cloze-grading-prompt";
import {
  clozeFeedbackResponseJsonSchema,
  clozeGradingResponseJsonSchema,
} from "@/lib/cloze-output-schemas";
import { loadClozeFrom } from "@/lib/cloze-resolve";
import { buildUpstreamChatBody } from "@/lib/coding-proxy";
import { loadCodingFrom } from "@/lib/coding-resolve";
import type { FileKind } from "@/lib/file-name";
import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";
import {
  error,
  type Fetcher,
  type LoadOptions,
  type ValidationError,
} from "@/lib/prompt-fragments";
import {
  buildDiscussionInstructions,
  QUIZ_SEED_QUESTION_TEMPLATE,
  QUIZ_SEED_VERDICT_TEMPLATE,
} from "@/lib/quiz-discussion-prompt";
import {
  buildGradingPrompt,
  QUIZ_ANSWER_MESSAGE_TEMPLATE,
  QUIZ_ANSWER_PHOTOS_ONLY_MESSAGE,
} from "@/lib/quiz-grading-prompt";
import { loadQuizFrom } from "@/lib/quiz-resolve";
import { type QuizVerdict, verdictLabel } from "@/lib/quiz-types";
import { QUIZ_VERDICT_SCHEMA } from "@/lib/quiz-verdict-schema";
import { effectiveImageInput } from "@/lib/quiz-yaml";
import { loadAndBuildTutorPrompt } from "@/lib/tutors";
import { loadWritingFrom } from "@/lib/writing-resolve";

// The PROMPT-DUMP seam, keyed by `FileKind` — the read-only sibling of the validator
// seam (`lib/file-validators.ts`, Layer 2 of the codes architecture). A dumper derives
// from the FILE alone (never from a code entry): "which exact LLM prompts does this
// activity YAML produce?" Consumed by `@novedu/cli prompts` and by the eval harness
// (`lib/eval-validate.ts` → `novedu-cli eval`, docs/cli-eval.md); the app itself never
// needs it, but the answer must be the app's, so every dumper calls the SAME builders
// and loaders production runs — never a copy:
//
//   tutor    loadAndBuildTutorPrompt      (lib/tutors)
//   quiz     loadQuizFrom + buildGradingPrompt / buildDiscussionInstructions
//   writing  loadWritingFrom
//   coding   loadCodingFrom + buildUpstreamChatBody (lib/coding-proxy)
//   cloze    loadClozeFrom + buildClozeGradingPrompt / buildClozeFeedbackPrompt
//
// The activity's OWN `llm` block is reported. A code's per-code LLM override pair
// (`effectiveLlm`, docs/ai-models.md) is deliberately out of scope: a dump describes a
// FILE, and a file has no code.
//
// PURE / CLI-safe, and it must stay that way (`prompt-dump.unit.test.ts` grep-guards
// it): no `"use server"`, no `app/**` import (`app/mastra/scch.ts` runs a top-level
// `await` network call at import time and is pulled in transitively via
// `lib/llm/model.ts`), no DB, no `lib/llm/model.ts`.

/**
 * The kinds with a prompt dump — every `FileKind` except `fragment`, which is a
 * library, not an activity (it has no `llm`, and its fragments only ever appear inline
 * in some activity's host text, where the dumps below already show them rendered).
 */
export type PromptKind = Exclude<FileKind, "fragment">;

export const PROMPT_KINDS: readonly PromptKind[] = ["tutor", "quiz", "writing", "coding", "cloze"];

/** The activity's own model + provider (per-code overrides are out of scope). */
export interface PromptDumpLlm {
  provider: LlmProvider;
  model: string;
  /**
   * The activity's own `llm.reasoning`, when it pins one — ABSENT otherwise, because an
   * absent level means no `reasoning_effort` is sent at all. Like `provider`/`model` this
   * is the FILE's value; a code's override (which may add, change or drop the level) is
   * out of scope for the same reason.
   */
  reasoning?: ReasoningLevel;
}

/** One question's grading surface. */
export interface QuizGradingQuestionDump {
  id: string;
  /** The question's optional short label, when it has one. */
  title?: string;
  /** The FULL grading system prompt, exactly as `submitAnswer` builds it. */
  system: string;
  /** The EFFECTIVE photo-answers flag (per-question override → quiz default). */
  imageInput: boolean;
}

export interface QuizGradingDump {
  /** The user message wrapping a typed answer; `{answer}` is the student's text. */
  userMessageTemplate: string;
  /** The user message used when the student submitted photos only. */
  userMessagePhotosOnly: string;
  /** `QUIZ_VERDICT_SCHEMA` as plain JSON Schema — the grader's structured output. */
  responseSchema: Record<string, unknown>;
  questions: QuizGradingQuestionDump[];
}

export interface QuizDiscussionDump {
  /** The discussion chat's full system prompt (preamble + frame + guidance). */
  system: string;
  /**
   * The three messages seeded into a discussion thread's memory. `question` and
   * `verdict` are templates (the variable parts are per-attempt); `answer` documents
   * that the student's submitted answer is seeded verbatim.
   */
  seedMessages: { question: string; answer: string; verdict: string };
  /** The student-facing wording each verdict maps to (`verdictLabel`). */
  verdictLabels: Record<QuizVerdict, string>;
}

interface PromptDumpBase {
  kind: PromptKind;
  id: string;
  llm: PromptDumpLlm;
}

export interface TutorPromptDump extends PromptDumpBase {
  kind: "tutor";
  /** The assembled tutor system prompt (`tutor_instructions` with fragments placed). */
  system: string;
  /**
   * The tutor's opted-in built-in tools (top-level `tools:`, [] by default).
   * Part of what the model receives: each name's definition goes on the wire
   * alongside the system prompt (docs/tutor-tools.md).
   */
  tools: string[];
}

export interface QuizPromptDump extends PromptDumpBase {
  kind: "quiz";
  grading: QuizGradingDump;
  discussion: QuizDiscussionDump;
}

export interface WritingPromptDump extends PromptDumpBase {
  kind: "writing";
  /** The feedback agent's system prompt (the assembled `instructions`). */
  system: string;
}

export interface CodingPromptDump extends PromptDumpBase {
  kind: "coding";
  /** The teacher's assembled `instructions` — what the proxy injects upstream. */
  system: string;
  /**
   * What the proxy actually sends when the calling agent supplies NO system message:
   * the `content` of the leading system message `buildUpstreamChatBody` prepends. With
   * a client system message present the same text is APPENDED to the client's last one
   * (the teacher always gets the final word) — so this is the injected text in context,
   * built by the real helper rather than restated here.
   */
  upstreamSystemMessage: string;
}

/** One call of the cloze pipeline: its system prompt, user-message wrapper and output. */
export interface ClozeCallDump {
  /** The FULL system prompt, exactly as the server action builds it. */
  system: string;
  /** The user message; `{answers}` is the JSON list the action fills in. */
  userMessageTemplate: string;
  /** The call's structured output as plain JSON Schema. */
  responseSchema: Record<string, unknown>;
}

export interface ClozePromptDump extends PromptDumpBase {
  kind: "cloze";
  /** How many gaps the text has (the grading call sees only the undecided ones). */
  gapCount: number;
  /** Step 1 — one verdict per gap the pre-pass left undecided (`gradeCloze`). */
  grading: ClozeCallDump;
  /** Step 2 — patterns + per-gap notes over the final verdicts (`explainCloze`). */
  feedback: ClozeCallDump;
}

export type PromptDump =
  | TutorPromptDump
  | QuizPromptDump
  | WritingPromptDump
  | CodingPromptDump
  | ClozePromptDump;

export type PromptDumpResult =
  | { ok: true; dump: PromptDump }
  | { ok: false; errors: ValidationError[] };

export interface PromptDumper {
  dump(url: string, fetcher: Fetcher, opts?: LoadOptions): Promise<PromptDumpResult>;
}

/** Wrap a runtime loader's friendly message as the structured failure shape. */
function loadFailed(message: string, url: string): PromptDumpResult {
  return { ok: false, errors: [error("ACTIVITY_LOAD_FAILED", message, { url })] };
}

/**
 * The verdict schema as plain JSON Schema, generated from the zod source of truth with
 * zod 4's native converter — the same mechanism `lib/schema-gen` uses for the authoring
 * schemas, so there is no second conversion story in the repo.
 */
export function verdictResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(QUIZ_VERDICT_SCHEMA, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

// tutor: the tutor core IS the runtime path (the agent calls the same function per
// request), so its `BuildResult` already carries the assembled prompt + llm.
const tutorDumper: PromptDumper = {
  async dump(url, fetcher, opts = {}) {
    const result = await loadAndBuildTutorPrompt(url, fetcher, opts);
    if (!result.ok) return { ok: false, errors: result.errors };
    return {
      ok: true,
      dump: {
        kind: "tutor",
        id: result.id,
        llm: {
          provider: result.provider,
          model: result.model,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        },
        system: result.prompt,
        tools: result.tools,
      },
    };
  },
};

// quiz: the runtime load (fragments rendered, `quiz_files` includes merged with their
// per-question `sourcePreamble` chain), then the two real prompt builders — one grading
// prompt per resolved question plus the single discussion prompt.
const quizDumper: PromptDumper = {
  async dump(url, fetcher, opts = {}) {
    const loaded = await loadQuizFrom(url, fetcher, { allowedSchemes: opts.allowedSchemes });
    if (!loaded.ok) return loadFailed(loaded.message, url);
    const quiz = loaded.quiz;
    return {
      ok: true,
      dump: {
        kind: "quiz",
        id: quiz.id,
        llm: {
          provider: quiz.provider,
          model: quiz.model,
          ...(quiz.reasoning ? { reasoning: quiz.reasoning } : {}),
        },
        grading: {
          userMessageTemplate: QUIZ_ANSWER_MESSAGE_TEMPLATE,
          userMessagePhotosOnly: QUIZ_ANSWER_PHOTOS_ONLY_MESSAGE,
          responseSchema: verdictResponseJsonSchema(),
          questions: quiz.questions.map((question) => ({
            id: question.id,
            ...(question.title ? { title: question.title } : {}),
            system: buildGradingPrompt(question, quiz.instructionsPreamble),
            imageInput: effectiveImageInput(quiz, question),
          })),
        },
        discussion: {
          system: buildDiscussionInstructions(quiz),
          seedMessages: {
            question: QUIZ_SEED_QUESTION_TEMPLATE,
            answer: "{answer}",
            verdict: QUIZ_SEED_VERDICT_TEMPLATE,
          },
          verdictLabels: {
            correct: verdictLabel("correct"),
            partial: verdictLabel("partial"),
            incorrect: verdictLabel("incorrect"),
          },
        },
      },
    };
  },
};

// writing: ONE host text (`instructions`) — the feedback agent's whole system prompt.
// (`placeholder` is starter text for the editor, not a prompt; the agent's only tool,
// the browser-side read-only `getCurrentText`, carries no teacher-authored text.)
const writingDumper: PromptDumper = {
  async dump(url, fetcher, opts = {}) {
    const loaded = await loadWritingFrom(url, fetcher, { allowedSchemes: opts.allowedSchemes });
    if (!loaded.ok) return loadFailed(loaded.message, url);
    const writing = loaded.writing;
    return {
      ok: true,
      dump: {
        kind: "writing",
        id: writing.id,
        llm: {
          provider: writing.provider,
          model: writing.model,
          ...(writing.reasoning ? { reasoning: writing.reasoning } : {}),
        },
        system: writing.instructions,
      },
    };
  },
};

// coding: the assembled `instructions`, plus what the proxy really puts on the wire —
// built by the proxy's own `buildUpstreamChatBody` over an empty client body.
const codingDumper: PromptDumper = {
  async dump(url, fetcher, opts = {}) {
    const loaded = await loadCodingFrom(url, fetcher, { allowedSchemes: opts.allowedSchemes });
    if (!loaded.ok) return loadFailed(loaded.message, url);
    const coding = loaded.coding;
    const upstream = buildUpstreamChatBody(
      { messages: [] },
      { instructions: coding.instructions, model: coding.model },
    );
    const messages = Array.isArray(upstream.messages) ? upstream.messages : [];
    const system = messages.find(
      (m): m is { role: string; content: string } =>
        typeof m === "object" && m !== null && (m as { role?: unknown }).role === "system",
    );
    return {
      ok: true,
      dump: {
        kind: "coding",
        id: coding.id,
        llm: {
          provider: coding.provider,
          model: coding.model,
          ...(coding.reasoning ? { reasoning: coding.reasoning } : {}),
        },
        system: coding.instructions,
        upstreamSystemMessage: typeof system?.content === "string" ? system.content : "",
      },
    };
  },
};

// cloze: the runtime load (preamble rendered once), then the two real prompt builders —
// the grading call's and the feedback call's — with their user-message wrappers and
// output schemas.
const clozeDumper: PromptDumper = {
  async dump(url, fetcher, opts = {}) {
    const loaded = await loadClozeFrom(url, fetcher, { allowedSchemes: opts.allowedSchemes });
    if (!loaded.ok) return loadFailed(loaded.message, url);
    const cloze = loaded.cloze;
    return {
      ok: true,
      dump: {
        kind: "cloze",
        id: cloze.id,
        llm: {
          provider: cloze.provider,
          model: cloze.model,
          ...(cloze.reasoning ? { reasoning: cloze.reasoning } : {}),
        },
        gapCount: cloze.gaps.length,
        grading: {
          system: buildClozeGradingPrompt(cloze),
          userMessageTemplate: CLOZE_GRADING_MESSAGE_TEMPLATE,
          responseSchema: clozeGradingResponseJsonSchema(),
        },
        feedback: {
          system: buildClozeFeedbackPrompt(cloze),
          userMessageTemplate: CLOZE_FEEDBACK_MESSAGE_TEMPLATE,
          responseSchema: clozeFeedbackResponseJsonSchema(),
        },
      },
    };
  },
};

/** The seam: one dumper per prompt-producing `FileKind`. */
export const promptDumpers: Record<PromptKind, PromptDumper> = {
  tutor: tutorDumper,
  quiz: quizDumper,
  writing: writingDumper,
  coding: codingDumper,
  cloze: clozeDumper,
};

/** Dump the prompts of ONE activity file — the single entry point callers use. */
export function dumpPrompts(
  kind: PromptKind,
  url: string,
  fetcher: Fetcher,
  opts: LoadOptions = {},
): Promise<PromptDumpResult> {
  return promptDumpers[kind].dump(url, fetcher, opts);
}

/**
 * The dump's prompts as a flat, kind-agnostic list — what a summary renderer walks so it
 * never has to switch on the kind. Order is stable (and, for a quiz, question order).
 */
export function promptSections(dump: PromptDump): { name: string; text: string }[] {
  switch (dump.kind) {
    case "quiz":
      return [
        ...dump.grading.questions.map((q) => ({ name: `grading: ${q.id}`, text: q.system })),
        { name: "discussion", text: dump.discussion.system },
      ];
    case "coding":
      return [{ name: "system (injected upstream)", text: dump.system }];
    case "cloze":
      return [
        { name: "grading", text: dump.grading.system },
        { name: "feedback", text: dump.feedback.system },
      ];
    default:
      return [{ name: "system", text: dump.system }];
  }
}
