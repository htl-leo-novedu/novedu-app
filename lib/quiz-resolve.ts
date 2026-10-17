import { loadActivityFrom } from "@/lib/activity-load";
import type { ImageRef } from "@/lib/image-ref";
import {
  assembleFragmentPrompt,
  assembleFragmentPrompts,
  DEFAULT_ALLOWED_SCHEMES,
  EMPTY_FRAGMENT_BLOCK,
  type Fetcher,
  resolveFragmentUrl,
  schemeAllowed,
} from "@/lib/prompt-fragments";
import {
  parseQuiz,
  QUIZ_NOUN,
  type Quiz,
  type QuizFileRef,
  type QuizQuestion,
} from "@/lib/quiz-yaml";

// The quiz RUNTIME resolution: turn a leniently parsed quiz into the runnable `Quiz` the
// grader and the discussion chat see — the quiz's TWO host texts rendered against the
// document's ONE fragment block (`instructions` → the server-only `instructionsPreamble`,
// `discussion.instructions` → `discussionInstructions`), and every `quiz_files` LIVE
// INCLUDE pulled fresh, namespaced `"<alias>/<id>"` and merged into the pool (each
// imported question carrying its SOURCE quiz's rendered preamble as `sourcePreamble`).
//
// PURE / fetcher-injected, split out of `lib/quiz-fetch.ts` so the SAME resolution serves
// both callers with no second implementation:
//
//   - the app (`loadQuiz`), through the DB-backed `loadAppHostedYaml` + `appHostedFetcher`,
//   - the prompt dump / CLI (`loadQuizFrom`), through the CLI's `file:`-aware fetcher.
//
// No DB, no `app/`, no `"use server"` — the app-hosted/loopback resolution stays in
// `lib/quiz-fetch.ts` (see docs/files.md).
//
// Include resolution is FAIL-CLOSED (same pattern as fragment failures — the final
// exam must never silently shrink): a malformed ref, a duplicate alias, an
// unfetchable include, an include that does not parse as a quiz, a nested
// `quiz_files` declaration (includes are one level deep), or a failing source
// preamble all fail the whole load with a friendly student-facing message.

export type LoadQuizResult = { ok: true; quiz: Quiz } | { ok: false; message: string };

/**
 * Which URL schemes an include (and, for `loadQuizFrom`, the quiz itself) may use.
 * The app passes nothing and gets the http(s)-only production gate; the CLI adds
 * `file:` so a quiz on disk resolves its siblings — exactly like `validate`.
 */
export interface QuizResolveOptions {
  allowedSchemes?: string[];
}

type IncludeResult = { ok: true; questions: QuizQuestion[] } | { ok: false; message: string };

/**
 * Renders ONE quiz document's `instructions` host text against its OWN fragment
 * block, relative to its OWN URL (`validateLibraries: false` — the hot path). Used
 * for each included source quiz, so an imported question's `sourcePreamble` is
 * exactly what its chapter quiz would grade with. (The root document renders its
 * two host texts — `instructions` + `discussion.instructions` — in `resolveQuiz`.)
 */
async function renderPreamble(
  quiz: Quiz,
  url: string,
  fetcher: Fetcher,
  allowedSchemes: string[],
): Promise<{ ok: true; preamble: string } | { ok: false }> {
  const resolved = await assembleFragmentPrompt(
    quiz.fragmentBlock,
    url,
    fetcher,
    { validateLibraries: false, allowedSchemes },
    quiz.instructions ?? "",
  );
  if (!resolved.ok) return { ok: false };
  return { ok: true, preamble: resolved.prompt.trimEnd() };
}

/**
 * Absolutize an imported question's content image against the SOURCE quiz URL, so
 * a `./diagram.png` next to the chapter quiz still resolves from the compound quiz
 * (whose own `file_url` is elsewhere). Hosted NAMES and absolute URLs pass through
 * unchanged — they resolve the same from anywhere.
 */
function absolutizeImage(image: ImageRef | undefined, sourceUrl: string): ImageRef | undefined {
  if (!image || image.hosted === true || /^https?:\/\//i.test(image.src)) return image;
  try {
    return { ...image, src: resolveFragmentUrl(image.src, sourceUrl) };
  } catch {
    // An unresolvable relative path can't render either way; keep the ref and let
    // the lenient `resolveImageRef` omit it (images are non-secret decoration).
    return image;
  }
}

/** Resolve ONE `quiz_files` include into its namespaced, import-transformed questions. */
async function resolveInclude(
  ref: QuizFileRef,
  baseUrl: string,
  fetcher: Fetcher,
  allowedSchemes: string[],
): Promise<IncludeResult> {
  // The ref was lifted leniently — re-check its shape fail-closed here. The alias
  // must be usable as a question-id prefix: non-empty, no dot (the fragment-alias
  // rule), and no slash (it delimits `"<alias>/<id>"`).
  const alias = typeof ref?.id === "string" ? ref.id.trim() : "";
  const rawUrl = typeof ref?.url === "string" ? ref.url.trim() : "";
  if (!alias || /[./]/.test(alias) || !rawUrl) {
    return { ok: false, message: "This quiz declares an invalid quiz_files entry." };
  }

  let sourceUrl: string;
  try {
    sourceUrl = resolveFragmentUrl(rawUrl, baseUrl);
  } catch {
    return { ok: false, message: `The included quiz "${alias}" has an invalid URL.` };
  }
  // Same SSRF scheme gate as fragment refs: the lenient lift skipped the schema's
  // URL refine, so this is the structural http(s)-only backstop.
  if (!schemeAllowed(sourceUrl, allowedSchemes)) {
    return { ok: false, message: `The included quiz "${alias}" has an invalid URL.` };
  }

  let body: string;
  try {
    const res = await fetcher(sourceUrl);
    if (!res.ok) {
      return { ok: false, message: `The included quiz "${alias}" could not be loaded.` };
    }
    body = await res.text();
  } catch {
    return { ok: false, message: `The included quiz "${alias}" could not be loaded.` };
  }

  const parsed = parseQuiz(body);
  if (!parsed.ok) {
    return { ok: false, message: `The included quiz "${alias}" is not a usable quiz file.` };
  }
  // One level deep only — no recursion, no cycles.
  if (parsed.quiz.quizFiles.length > 0) {
    return {
      ok: false,
      message: `The included quiz "${alias}" itself includes other quizzes — includes cannot be nested.`,
    };
  }

  // The source's own preamble, rendered with the SOURCE's fragment block relative to
  // the SOURCE URL — it travels with each imported question as `sourcePreamble`.
  const preamble = await renderPreamble(parsed.quiz, sourceUrl, fetcher, allowedSchemes);
  if (!preamble.ok) {
    return {
      ok: false,
      message: `The included quiz "${alias}"'s prompt fragments could not be loaded.`,
    };
  }

  // ONLY the source's `questions` are lifted — every other include-level field
  // (llm, anonymous, shuffle, discussion, title, description, question_count) is
  // ignored and the compound quiz's own value governs.
  const source = parsed.quiz;
  const questions = source.questions.map(
    (q): QuizQuestion => ({
      ...q,
      // Namespaced id — cross-chapter collisions impossible by construction.
      id: `${alias}/${q.id}`,
      // Materialize the SOURCE-effective photo-answers flag as an explicit
      // per-question boolean (the compound quiz's own `llm.imageInput` must not
      // re-interpret an imported question).
      imageInput: q.imageInput ?? source.imageInput,
      image: absolutizeImage(q.image, sourceUrl),
      ...(preamble.preamble ? { sourcePreamble: preamble.preamble } : {}),
    }),
  );
  return { ok: true, questions };
}

/**
 * Resolve a leniently parsed quiz into the runnable one: render its two host texts,
 * then merge in every `quiz_files` include. `url` is the quiz's own URL (the base for
 * relative fragment/include refs); `fetcher` is the caller's network seam.
 */
export async function resolveQuiz(
  quiz: Quiz,
  url: string,
  fetcher: Fetcher,
  opts: QuizResolveOptions = {},
): Promise<LoadQuizResult> {
  const allowedSchemes = opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  // Runtime hot path: `validateLibraries: false`. The quiz has TWO host texts —
  // `instructions` and `discussion.instructions` — rendered in ONE pass against the
  // document's fragment block (libraries/text files fetched once); with no
  // fragment_files both return verbatim, off the network entirely.
  const resolved = await assembleFragmentPrompts(
    quiz.fragmentBlock,
    url,
    fetcher,
    { validateLibraries: false, allowedSchemes },
    [quiz.instructions ?? "", quiz.discussionInstructions ?? ""],
  );
  if (!resolved.ok) {
    // Fail closed — same hard-error path as an unfetchable activity YAML (so a
    // safety fragment that fails to resolve blocks the quiz rather than vanishing).
    return { ok: false, message: "This quiz's prompt fragments could not be loaded." };
  }
  const [instructionsPreamble = "", discussionInstructions = ""] = resolved.prompts;

  // Resolve the live includes (in parallel, merged in DECLARED order). Duplicate
  // aliases are an authoring error — fail closed rather than guessing.
  const refs = quiz.quizFiles;
  const aliases = new Set<string>();
  for (const ref of refs) {
    const alias = typeof ref?.id === "string" ? ref.id.trim() : "";
    if (aliases.has(alias)) {
      return {
        ok: false,
        message: `This quiz declares the included-quiz alias "${alias}" twice.`,
      };
    }
    aliases.add(alias);
  }
  const includes = await Promise.all(
    refs.map((ref) => resolveInclude(ref, url, fetcher, allowedSchemes)),
  );
  const imported: QuizQuestion[] = [];
  for (const include of includes) {
    if (!include.ok) return include;
    imported.push(...include.questions);
  }

  const questions = [...quiz.questions, ...imported];
  // parseQuiz + resolveInclude make an empty pool unreachable (each parsed quiz has
  // ≥ 1 complete question or fails) — keep the backstop anyway; never run empty.
  if (questions.length === 0) {
    return { ok: false, message: "This quiz has no questions." };
  }

  return {
    ok: true,
    quiz: {
      ...quiz,
      fragmentBlock: EMPTY_FRAGMENT_BLOCK,
      quizFiles: [],
      instructionsPreamble: instructionsPreamble.trimEnd(),
      // The rendered discussion guidance replaces the authored host text — empty
      // (e.g. no `discussion:` block) collapses back to "none".
      discussionInstructions:
        discussionInstructions.trim() !== "" ? discussionInstructions.trimEnd() : undefined,
      questions,
    },
  };
}

/**
 * Fetch + lenient-parse + `resolveQuiz`, all through the CALLER's fetcher — the
 * app-free counterpart of `loadQuiz` (`lib/quiz-fetch.ts`) used by the prompt dump and
 * the CLI, where there is no database and a quiz may live on disk (`file:`).
 */
export function loadQuizFrom(
  url: string,
  fetcher: Fetcher,
  opts: QuizResolveOptions = {},
): Promise<LoadQuizResult> {
  return loadActivityFrom(
    url,
    fetcher,
    QUIZ_NOUN,
    parseQuiz,
    (parsed) => resolveQuiz(parsed.quiz, url, fetcher, opts),
    opts.allowedSchemes,
  );
}
