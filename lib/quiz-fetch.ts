import { loadAppHostedYaml } from "@/lib/app-hosted-yaml";
import { type LoadQuizResult, resolveQuiz } from "@/lib/quiz-resolve";
import { parseQuiz, QUIZ_NOUN } from "@/lib/quiz-yaml";

// Loads + leniently parses the quiz YAML behind a (verified) quiz URL, via the shared
// `loadAppHostedYaml`, then hands the parsed document to the PURE `resolveQuiz`
// (lib/quiz-resolve.ts), which renders the quiz's two host texts and resolves the
// `quiz_files` live includes. The single definition shared by the `/q` page,
// `submitAnswer`, `startDiscussion`, and the runtime route's quiz branch, so they all
// read the same quiz the same way.
//
// This file owns ONLY the app-hosted/DB seam; the resolution itself is shared verbatim
// with the prompt dump / CLI (`loadQuizFrom`), so a dumped grading prompt is the exact
// production one. SERVER-ONLY: touches the database and fetches arbitrary URLs.

export type { LoadQuizResult } from "@/lib/quiz-resolve";

export function loadQuiz(quizUrl: string): Promise<LoadQuizResult> {
  return loadAppHostedYaml(quizUrl, QUIZ_NOUN, parseQuiz, (parsed, { url, fetcher }) =>
    resolveQuiz(parsed.quiz, url, fetcher),
  );
}
