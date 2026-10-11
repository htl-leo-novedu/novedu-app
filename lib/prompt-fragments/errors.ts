// Error and result model for the tutor validator/builder core.
//
// This module is framework-agnostic (no React/Next). Every consumer — the API
// route, future server code, tests — speaks in terms of these structured
// errors and the `BuildResult` discriminated union, never thrown exceptions.

/** Hard failures that prevent a system prompt from being built. */
export type ErrorCode =
  | "INVALID_URL"
  | "FETCH_FAILED"
  | "YAML_PARSE_ERROR"
  | "TUTOR_SCHEMA_ERROR"
  | "FRAGMENT_FILE_SCHEMA_ERROR"
  | "DUPLICATE_FRAGMENT_FILE_ALIAS"
  | "DUPLICATE_FRAGMENT_ID_IN_FILE"
  | "UNKNOWN_FRAGMENT_FILE_ALIAS"
  | "FRAGMENT_NOT_FOUND"
  | "MISSING_REQUIRED_VARIABLE"
  | "VARIABLE_TYPE_MISMATCH"
  // The host text (tutor_instructions / instructions) is a Handlebars template once
  // the activity declares any `fragment_files:`; a malformed marker or an unescaped
  // literal `{{` fails to parse. Carries the `line:col` from Handlebars' message.
  | "HOST_TEMPLATE_PARSE_ERROR"
  // A `{{fragment}}` marker whose reference is not a quoted string literal (a bare
  // `{{fragment}}`, or `{{fragment someVar}}`). The reference MUST be `"alias.id"`.
  | "FRAGMENT_REF_NOT_LITERAL"
  // A `{{fragment}}` marker that is structurally wrong in a way that would render
  // differently than it validates: a block form `{{#fragment}}…{{/fragment}}` (whose
  // body would be silently dropped), a `(fragment …)` subexpression, extra positional
  // arguments, or a hash argument whose value is not a string / boolean / `(array
  // "…" …)`. Fails closed so no text is silently lost or rendered unvalidated.
  | "FRAGMENT_MARKER_INVALID"
  // A `{{file "alias"}}` marker's alias is not declared in `text_files:`.
  | "UNKNOWN_TEXT_FILE_ALIAS"
  // A `{{file}}` marker that is structurally wrong in a way that would render differently
  // than it validates: a block form `{{#file}}…{{/file}}`, a `(file …)` subexpression,
  // extra positional args, an alias that is not a quoted string literal, a hash key other
  // than `from` / `to`, a `from` / `to` that is not an integer >= 1, or `from > to`.
  // Deliberately ONE code (no separate not-literal variant, unlike fragments) — every
  // structural violation of a `{{file}}` marker fails closed the same way.
  | "TEXT_FILE_MARKER_INVALID"
  // A text-file alias is declared twice — including a collision with a `fragment_files`
  // id (the two lists share ONE alias namespace so every marker resolves unambiguously).
  | "DUPLICATE_TEXT_FILE_ALIAS"
  // A placed `{{file "alias" from= to=}}` range is out of bounds: `from` beyond the
  // file's line count (ALWAYS an error — an empty splice would silently drop material),
  // or `to` beyond it (authoring validators ONLY — the runtime clamps `to` to EOF so a
  // source file shortened after validation degrades gracefully instead of failing).
  | "TEXT_FILE_RANGE_OUT_OF_BOUNDS"
  // A fetched text file exceeds the 200 KB cap (fail closed — carries the alias + URL).
  | "TEXT_FILE_TOO_LARGE"
  | "ASSEMBLY_ERROR"
  // A fragment's `content` template failed to compile or strict-render against its
  // own declared `input_schema` — a Handlebars syntax error or a reference to a
  // variable the fragment never declares. Surfaced by the standalone fragment
  // check and by thorough tutor validation (whole-library check).
  | "FRAGMENT_TEMPLATE_ERROR"
  // The quiz / writing / coding / cloze YAML does not match its schema (a
  // missing/misspelled field, a wrong type, no `llm.model`, no questions / no
  // instructions / no text). These validators are strict authoring gates, exactly
  // like the tutor/fragment ones.
  | "QUIZ_SCHEMA_ERROR"
  | "WRITING_SCHEMA_ERROR"
  | "CODING_SCHEMA_ERROR"
  | "CLOZE_SCHEMA_ERROR"
  // The cloze `text`'s gap markup (`lib/cloze-gaps.ts`), each carrying the 1-based
  // `line`/`column` of the offending spot: a malformed marker (an unclosed `[[`, a
  // stray `]]`, a gap spanning lines or containing `[[`, an empty hint or a second
  // `|`, a reserved character), a gap in a forbidden position (heading, code, math,
  // link, image, raw HTML, footnote), a reference over the answer cap, no gap at
  // all, or more gaps than the limit.
  | "CLOZE_GAP_SYNTAX"
  | "CLOZE_GAP_POSITION"
  | "CLOZE_GAP_TOO_LONG"
  | "CLOZE_NO_GAPS"
  | "CLOZE_TOO_MANY_GAPS"
  // The same quiz question `id` is declared on more than one question (per-question
  // stats key must be unique).
  | "DUPLICATE_QUIZ_QUESTION_ID"
  // A quiz's OWN question id contains `/` — reserved as the namespace delimiter for
  // questions imported via `quiz_files` (`"<alias>/<id>"`), so an own id can never
  // collide with an imported one.
  | "QUIZ_QUESTION_ID_RESERVED_SLASH"
  // The same `quiz_files` include alias is declared twice (each alias prefixes its
  // imported question ids, so it must be unique).
  | "DUPLICATE_QUIZ_INCLUDE_ALIAS"
  // A `quiz_files` include could not be used: fetch / YAML parse / schema failure,
  // or any strict-check failure INSIDE the included quiz (duplicate question ids,
  // its own fragment block, …). Wraps the nested errors' messages and carries the
  // include alias (`fileAlias`) + resolved URL.
  | "QUIZ_INCLUDE_UNREADABLE"
  // An included quiz itself declares `quiz_files` — includes are one level deep
  // (no recursion, no cycles).
  | "QUIZ_INCLUDE_NESTED"
  // The quiz's RESOLVED question pool is empty: no own `questions` and no
  // `quiz_files` includes to supply any.
  | "QUIZ_NO_QUESTIONS"
  // The RUNTIME loader could not read or resolve the activity (bad YAML, a missing
  // essential field, an unresolvable fragment/include). Carries the loader's friendly,
  // student-facing message. Emitted by the prompt dump (`lib/prompt-dump.ts`), which
  // runs the lenient runtime loaders on purpose — `validate` remains the structured
  // authoring gate.
  | "ACTIVITY_LOAD_FAILED"
  // The eval file (`docs/cli-eval.md`) could not be read / did not parse as YAML /
  // does not match `EvalYamlSchema` (one error per zod issue, its dotted path in the
  // message, e.g. `questions.0.answers.1.expect`).
  | "EVAL_READ"
  | "EVAL_PARSE"
  | "EVAL_SCHEMA"
  // The eval's `target` quiz could not be resolved or loaded: an unusable URL, a
  // blocked scheme, or the quiz itself failing to load/validate. Carries the resolved
  // target URL.
  | "EVAL_TARGET_ERROR"
  // An eval question id that the resolved target quiz does not have (a typo, or a
  // question removed from the quiz since the eval was written). Carries `questionId`.
  | "EVAL_UNKNOWN_QUESTION"
  // A tutor eval case REQUIRES a tool the target tutor's own `tools:` grant does not
  // contain: the catalog knows the name (the schema enum passed), but this tutor can
  // never call it, so the expectation could never be met. Carries the resolved target URL.
  | "EVAL_UNGRANTED_TOOL"
  // App-only: the YAML names an LLM provider this server does not have configured
  // (e.g. `Azure Foundry` without AZURE_FOUNDRY_ENDPOINT). Emitted by the app's
  // authoring gate (lib/file-validators.ts), never by the CLI-bundled loadAndCheck*
  // core — CLI validation stays environment-independent.
  | "PROVIDER_UNAVAILABLE";

/** Non-fatal smells: the prompt still builds, but something is worth flagging. */
export type WarningCode =
  | "UNDECLARED_VARIABLE"
  // A `fragment_files:` library is declared but no `{{fragment}}` marker in the host
  // text ever draws from it — a likely leftover or typo'd alias.
  | "UNUSED_FRAGMENT_FILE"
  // A `text_files:` entry is declared but no `{{file}}` marker in the host text ever
  // embeds it — a likely leftover or typo'd alias.
  | "UNUSED_TEXT_FILE"
  | "REQUIRED_PROPERTY_HAS_DEFAULT";

export interface ValidationError {
  code: ErrorCode;
  /** Human-readable explanation, safe to show in the UI. */
  message: string;
  /** Which remote file the error concerns (fetch/YAML/schema errors). */
  url?: string;
  /** The tutor-side fragment-file alias (e.g. `general_fragments`). */
  fileAlias?: string;
  /** The fragment id within that file (e.g. `socratic_tutor`). */
  fragmentId?: string;
  /** The quiz question id (e.g. a duplicate-question-id error). */
  questionId?: string;
  /** The offending variable name (missing/typed wrong). */
  variable?: string;
  expectedType?: string;
  actualType?: string;
  /** HTTP status for FETCH_FAILED. */
  status?: number;
  /** 1-based line of a host-template parse error / placement (regexed from Handlebars). */
  line?: number;
  /** 1-based column of a placement (from the parsed AST `loc`). */
  column?: number;
  /** Zod's treeified issues for *_SCHEMA_ERROR (machine + human readable). */
  zodIssues?: unknown;
}

export interface ValidationWarning {
  code: WarningCode;
  message: string;
  fileAlias?: string;
  fragmentId?: string;
  variable?: string;
}

/**
 * The single result type returned by the high-level entry point. A discriminated
 * union on `ok` so callers get either a prompt or a complete error list — never
 * both, never a thrown exception.
 */
export type BuildResult =
  | {
      ok: true;
      /**
       * The tutor's own `id` — the counterpart of `quizId` / `writingId` / `codingId`
       * on the other kinds' check results. Names the activity in tooling (the
       * `@novedu/cli prompts` dump envelope); never student-facing.
       */
      id: string;
      prompt: string;
      model: string;
      /**
       * The LLM provider serving `model` (tutor `llm.provider`, default "SCCH").
       * Mirrors `LlmProvider` in `lib/llm/provider.ts` (kept inline so this module
       * stays import-free) — update both together.
       */
      provider: "SCCH" | "Azure Foundry" | "OpenRouter";
      /**
       * Optional reasoning effort for `model` (tutor `llm.reasoning`); absent ⇒
       * no `reasoning_effort` is sent. Mirrors `ReasoningLevel` in
       * `lib/llm/provider.ts` (kept inline so this module stays import-free) —
       * update both together.
       */
      reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
      /** Whether students may attach images in the chat (tutor `llm.imageInput`, default true). */
      imageInput: boolean;
      /**
       * The tutor's opted-in built-in tool names (top-level `tools:`, default []).
       * Values mirror `TutorToolName` in `lib/tutor-tools/names.ts` (kept as plain
       * strings so this module stays import-free) — update both together.
       */
      tools: string[];
      /**
       * When true (the default), the user↔chat link is NOT persisted — chats
       * stay anonymous. A tutor opts into attribution with `anonymous: false`.
       */
      anonymous: boolean;
      /** Optional student-facing greeting shown instead of the chat's default welcome text. */
      title?: string;
      /** Student-facing description, rendered below the welcome greeting. */
      description: string;
      /**
       * Tutor `exampleQuestions`, normalized to [] when absent. Shown on the
       * welcome screen. The inline shape mirrors `ExampleQuestion` in
       * `schemas.ts` (kept inline so this module stays import-free) — update
       * both together.
       */
      exampleQuestions: { title: string; question: string }[];
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/**
 * Result of validating a fragment FILE on its own (the `--kind fragment` / "Fragment
 * library" path). Mirrors `BuildResult`'s discriminated shape, but a fragment file
 * has no assembled prompt — on success it just reports what it contains. Callers know
 * which kind they asked for, so there is no `kind` discriminator here.
 */
export type FragmentCheckResult =
  | {
      ok: true;
      /** The fragment file's own `id`. */
      fragmentFileId: string;
      /** Every fragment id declared in the file, in document order. */
      fragmentIds: string[];
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** Small helper to build an error object tersely at call sites. */
export function error(
  code: ErrorCode,
  message: string,
  extra: Partial<ValidationError> = {},
): ValidationError {
  return { code, message, ...extra };
}

export function warning(
  code: WarningCode,
  message: string,
  extra: Partial<ValidationWarning> = {},
): ValidationWarning {
  return { code, message, ...extra };
}

// The shape `z.treeifyError` produces (a `ValidationError`'s `zodIssues`):
// per-node `errors`, with nested `properties` (objects) and `items` (arrays).
type ZodErrorTree = {
  errors?: string[];
  properties?: Record<string, ZodErrorTree>;
  items?: (ZodErrorTree | null)[];
};

/**
 * Flattens a treeified Zod error into `path: message` lines so a generic
 * "Document does not match the expected structure" becomes actionable — e.g.
 * `Unrecognized key: "nae"` and `name: Invalid input: expected string`.
 * Framework-agnostic: shared by the web UI (`ErrorList`), the tutor-code
 * action, and the CLI formatter, so a schema error reads the same everywhere.
 */
export function formatZodIssues(zodIssues: unknown): string[] {
  const out: string[] = [];
  const walk = (node: ZodErrorTree | null | undefined, path: string[]) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.errors)) {
      for (const message of node.errors) {
        out.push(path.length ? `${path.join(".")}: ${message}` : message);
      }
    }
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) walk(child, [...path, key]);
    }
    if (Array.isArray(node.items)) {
      node.items.forEach((child, index) => {
        walk(child, [...path, String(index)]);
      });
    }
  };
  walk(zodIssues as ZodErrorTree, []);
  return out;
}
