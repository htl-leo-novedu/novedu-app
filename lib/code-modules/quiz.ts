import { ConversationStats } from "@/app/codes/[code]/conversation-stats";
import { llmRequestContext, QUIZ_DISCUSSION_CONTEXT } from "@/lib/llm-context";
import { buildDiscussionInstructions } from "@/lib/quiz-discussion-prompt";
import { loadQuiz } from "@/lib/quiz-fetch";
import type { CodeModuleDef } from "./registry";

// The quiz module: the per-question discussion chat (the grader runs only inside
// submitAnswer, never through the runtime route). The discussion agent's system prompt
// is built by `buildDiscussionInstructions` in the pure, CLI-safe
// `lib/quiz-discussion-prompt.ts` (imported, never copied, so
// `@novedu/cli prompts --kind quiz` dumps the byte-identical production prompt): the
// quiz-level `instructionsPreamble` followed by a default frame and the quiz's optional
// `discussionInstructions`. The question/answer/verdict are the thread's seed messages,
// recalled from memory, NOT repeated here. The teacher detail is the shared conversation
// stats ("Discussions").

export const quizModule: CodeModuleDef = {
  fileKind: "quiz",
  runtime: {
    agentId: "quizDiscussion",
    async buildRequestContext(entry) {
      // The quiz YAML supplies the discussion system prompt + provider/model
      // (re-loaded server-side, never trusted from the client); the code's LLM
      // override pair, when set, replaces the YAML's llm values.
      const loaded = await loadQuiz(entry.fileUrl);
      if (!loaded.ok) return { ok: false, status: 502, message: loaded.message };
      return llmRequestContext(
        entry,
        loaded.quiz,
        QUIZ_DISCUSSION_CONTEXT,
        buildDiscussionInstructions(loaded.quiz),
      );
    },
  },
  renderDetail: (entry) => ConversationStats({ entry }),
};
