// The quiz AUTHORING validator — the quiz counterpart to `loadAndCheckFragmentFile`
// in `lib/tutors`. Strict schema (`QuizYamlSchema`) + consistency passes (unique
// question ids, no reserved `/` in own ids, unique include aliases, non-empty
// resolved pool), surfaced as structured `ValidationError[]` that BLOCK an invalid
// save. Wired into the validator seam (`lib/file-validators.ts`) and the
// `@novedu/cli validate --kind quiz` command.
//
// A quiz declaring `quiz_files` live includes is validated DEEPLY: every included
// quiz file is fetched and run through the FULL strict check (schema, duplicate
// question ids, its own fragment-block authoring gate) — a compound quiz must not
// save while any of its chapters is broken. Include failures are wrapped as
// `QUIZ_INCLUDE_UNREADABLE` carrying the alias + resolved URL.
//
// PURE / CLI-safe: imports only `lib/prompt-fragments` helpers (the shared
// scheme-gated YAML load, the Zod-validate wrapper, the error model) and the Zod
// schema — never `lib/quiz-fetch` (DB-backed) or any server-only module. The lenient
// runtime `parseQuiz` (`lib/quiz-yaml.ts`) is unchanged and separate.

import {
  assembleFragmentPrompts,
  error,
  type Fetcher,
  type LoadOptions,
  loadAndValidate,
  resolveFragmentUrl,
  type ValidationError,
  type ValidationWarning,
  validate,
} from "@/lib/prompt-fragments";
import type { LlmProvider } from "./llm/provider";
import { type QuizYaml, QuizYamlSchema } from "./quiz-schema";

/**
 * The result of checking a quiz file. Mirrors `lib/tutors`' `FragmentCheckResult`,
 * but a quiz also carries the metadata the validator seam denormalizes onto the
 * code row: the privacy flag and a display title.
 */
export type QuizCheckResult =
  | {
      ok: true;
      quizId: string;
      model: string;
      /** The LLM provider serving `model` (`llm.provider`, default SCCH). */
      provider: LlmProvider;
      /**
       * The RESOLVED question-pool size: own questions + every question of every
       * `quiz_files` include (`loadAndCheckQuiz`). The pure `checkQuizValue` cannot
       * fetch includes and reports the own count only.
       */
      questionCount: number;
      /** Privacy flag, default `true` (anonymous). */
      anonymous: boolean;
      title: string | null;
      warnings: ValidationWarning[];
    }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** Quizzes default to anonymous — answers are recorded for stats but not attributed. */
const DEFAULT_ANONYMOUS = true;

/** Question ids declared on more than one question (the per-question stats key). */
function findDuplicateQuestionIds(quiz: QuizYaml): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  for (const question of quiz.questions) {
    if (seen.has(question.id)) {
      errors.push(
        error(
          "DUPLICATE_QUIZ_QUESTION_ID",
          `Question id "${question.id}" is declared more than once`,
          { questionId: question.id },
        ),
      );
      continue;
    }
    seen.add(question.id);
  }
  return errors;
}

/**
 * Own question ids containing `/` — reserved as the namespace delimiter for
 * questions imported via `quiz_files` (`"<alias>/<id>"`), so an own id can never
 * collide with (or masquerade as) an imported one.
 */
function findReservedSlashIds(quiz: QuizYaml): ValidationError[] {
  return quiz.questions
    .filter((question) => question.id.includes("/"))
    .map((question) =>
      error(
        "QUIZ_QUESTION_ID_RESERVED_SLASH",
        `Question id "${question.id}" contains "/" — reserved for questions imported via quiz_files`,
        { questionId: question.id },
      ),
    );
}

/** Include aliases declared on more than one `quiz_files` entry. */
function findDuplicateIncludeAliases(quiz: QuizYaml): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  for (const ref of quiz.quiz_files) {
    if (seen.has(ref.id)) {
      errors.push(
        error(
          "DUPLICATE_QUIZ_INCLUDE_ALIAS",
          `Included-quiz alias "${ref.id}" is declared more than once`,
          { fileAlias: ref.id },
        ),
      );
      continue;
    }
    seen.add(ref.id);
  }
  return errors;
}

/**
 * Check an already-schema-validated quiz: unique question ids, no reserved `/` ids,
 * unique include aliases, and a non-empty (potential) pool → metadata. Split from
 * `checkQuizValue` so `loadAndCheckQuiz` can reuse the single `validate` it already ran
 * (no second parse of the same document against the same schema).
 */
function checkQuizParsed(quiz: QuizYaml): QuizCheckResult {
  const errors = [
    ...findDuplicateQuestionIds(quiz),
    ...findReservedSlashIds(quiz),
    ...findDuplicateIncludeAliases(quiz),
  ];
  // An empty own `questions` is fine only when includes will supply the pool; each
  // include is itself checked to have ≥ 1 question (`loadAndCheckQuiz`), so
  // "no own questions AND no includes" is the one truly empty case.
  if (quiz.questions.length === 0 && quiz.quiz_files.length === 0) {
    errors.push(
      error("QUIZ_NO_QUESTIONS", "This quiz has no questions and no quiz_files includes"),
    );
  }
  if (errors.length > 0) return { ok: false, errors, warnings: [] };

  return {
    ok: true,
    quizId: quiz.id,
    model: quiz.llm.model,
    provider: quiz.llm.provider,
    questionCount: quiz.questions.length,
    anonymous: quiz.anonymous ?? DEFAULT_ANONYMOUS,
    title: quiz.title ?? null,
    warnings: [],
  };
}

/**
 * Validate an already-parsed quiz value: schema → consistency passes → metadata.
 * Pure (the parsed value is passed in), so it cannot fetch `quiz_files` includes:
 * include contents are validated only by `loadAndCheckQuiz`, and `questionCount`
 * here counts own questions only.
 */
export function checkQuizValue(parsed: unknown, url?: string): QuizCheckResult {
  const valid = validate<QuizYaml>(parsed, QuizYamlSchema, "QUIZ_SCHEMA_ERROR", url);
  if (!valid.ok) return { ok: false, errors: [valid.error], warnings: [] };
  return checkQuizParsed(valid.data);
}

/** One include's deep-check outcome: its question count, or the wrapped errors. */
type IncludeCheck =
  | { ok: true; questionCount: number; warnings: ValidationWarning[] }
  | { ok: false; errors: ValidationError[]; warnings: ValidationWarning[] };

/** Wrap an include's nested failures into ONE error carrying the alias + URL. */
function includeUnreadable(
  alias: string,
  url: string | undefined,
  nested: ValidationError[],
): ValidationError {
  const detail = nested.map((e) => e.message).join("; ");
  return error(
    "QUIZ_INCLUDE_UNREADABLE",
    `Included quiz "${alias}" is not usable: ${detail}`,
    url === undefined ? { fileAlias: alias } : { fileAlias: alias, url },
  );
}

/**
 * Deep-check ONE `quiz_files` include: resolve + fetch + parse + the FULL strict
 * quiz check (schema, consistency passes, its own fragment-block authoring gate),
 * plus the one-level rule (`QUIZ_INCLUDE_NESTED`). Every other failure is wrapped
 * as `QUIZ_INCLUDE_UNREADABLE` with the alias + resolved URL.
 */
async function checkInclude(
  ref: { id: string; url: string },
  baseUrl: string,
  fetchImpl: Fetcher,
  opts: LoadOptions,
): Promise<IncludeCheck> {
  let includeUrl: string;
  try {
    includeUrl = resolveFragmentUrl(ref.url, baseUrl);
  } catch {
    return {
      ok: false,
      errors: [
        includeUnreadable(ref.id, undefined, [
          error("INVALID_URL", `Invalid include URL: ${ref.url}`),
        ]),
      ],
      warnings: [],
    };
  }

  // Shared scheme gate + fetch + YAML parse + schema (identical to the top-level load).
  const valid = await loadAndValidate(
    includeUrl,
    fetchImpl,
    opts,
    QuizYamlSchema,
    "QUIZ_SCHEMA_ERROR",
  );
  if (!valid.ok) {
    return {
      ok: false,
      errors: [includeUnreadable(ref.id, includeUrl, [valid.error])],
      warnings: [],
    };
  }

  // One level deep only — its own distinct code, not wrapped (it is a structural
  // rule of THIS quiz's include, not a brokenness of the included file).
  if (valid.data.quiz_files.length > 0) {
    return {
      ok: false,
      errors: [
        error(
          "QUIZ_INCLUDE_NESTED",
          `Included quiz "${ref.id}" itself declares quiz_files — includes are one level deep`,
          { fileAlias: ref.id, url: includeUrl },
        ),
      ],
      warnings: [],
    };
  }

  const checked = checkQuizParsed(valid.data);
  if (!checked.ok) {
    return {
      ok: false,
      errors: [includeUnreadable(ref.id, includeUrl, checked.errors)],
      warnings: checked.warnings,
    };
  }

  // The included quiz's own fragment-block authoring gate, relative to ITS url —
  // its `instructions` preamble travels with its questions at runtime, so it must
  // assemble cleanly (thorough by default, exactly like the root's gate below).
  // Its `discussion.instructions` is checked too: it is ignored by the compound
  // quiz, but the chapter file must stay usable as a quiz of its own.
  const assembled = await assembleFragmentPrompts(
    { fragment_files: valid.data.fragment_files, text_files: valid.data.text_files },
    includeUrl,
    fetchImpl,
    { allowedSchemes: opts.allowedSchemes, validateLibraries: opts.validateLibraries ?? true },
    [valid.data.instructions ?? "", valid.data.discussion?.instructions ?? ""],
  );
  if (!assembled.ok) {
    return {
      ok: false,
      errors: [includeUnreadable(ref.id, includeUrl, assembled.errors)],
      warnings: assembled.warnings,
    };
  }
  return { ok: true, questionCount: valid.data.questions.length, warnings: assembled.warnings };
}

/**
 * Validate a quiz FILE: scheme-gate + fetch + parse + schema (shared `loadAndValidate`), the pure
 * `checkQuizValue`, the document-level fragment block's authoring gate — fetch
 * every referenced library, run the THOROUGH whole-library check, consistency, and an
 * assembly dry-run (the strict-Handlebars backstop) — and a DEEP check of every
 * `quiz_files` include. On success `questionCount` is the RESOLVED pool size
 * (own + imported), so the `/files` save UI and code-create metadata reflect the
 * real exam size. The web app passes the default http(s)-only schemes; the CLI adds
 * `file:` so a local quiz YAML on disk validates too.
 */
export async function loadAndCheckQuiz(
  url: string,
  fetchImpl: Fetcher,
  opts: LoadOptions = {},
): Promise<QuizCheckResult> {
  // Validate the schema ONCE, then reuse the typed value for both the question-id check
  // and the fragment block below (no second parse of the same document).
  const valid = await loadAndValidate(url, fetchImpl, opts, QuizYamlSchema, "QUIZ_SCHEMA_ERROR");
  if (!valid.ok) return { ok: false, errors: [valid.error], warnings: [] };

  const checked = checkQuizParsed(valid.data);
  if (!checked.ok) return checked;

  // The fragment block's authoring gate: fetch + placement checks + a host-template
  // render dry-run over the quiz's TWO host texts — `instructions` and
  // `discussion.instructions` (authoring default: `validateLibraries: true`). Both may
  // carry inline `{{fragment}}`/`{{file}}` markers; a bad marker in either blocks the save.
  const assembled = await assembleFragmentPrompts(
    { fragment_files: valid.data.fragment_files, text_files: valid.data.text_files },
    url,
    fetchImpl,
    { allowedSchemes: opts.allowedSchemes, validateLibraries: opts.validateLibraries ?? true },
    [valid.data.instructions ?? "", valid.data.discussion?.instructions ?? ""],
  );
  const warnings = [...checked.warnings, ...assembled.warnings];
  if (!assembled.ok) return { ok: false, errors: assembled.errors, warnings };

  // Deep-check every include (in parallel, errors surfaced in declared order) and
  // resolve the real pool size.
  const includes = await Promise.all(
    valid.data.quiz_files.map((ref) => checkInclude(ref, url, fetchImpl, opts)),
  );
  const includeErrors: ValidationError[] = [];
  let importedCount = 0;
  for (const include of includes) {
    warnings.push(...include.warnings);
    if (include.ok) importedCount += include.questionCount;
    else includeErrors.push(...include.errors);
  }
  if (includeErrors.length > 0) return { ok: false, errors: includeErrors, warnings };

  return { ...checked, questionCount: checked.questionCount + importedCount, warnings };
}
