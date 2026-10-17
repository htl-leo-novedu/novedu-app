import { after } from "next/server";
import { Notice } from "@/components/notice";
import { Main } from "@/components/page-main";
import { checkCode } from "@/lib/code-store";
import { recordRecentCode, removeRecentCode } from "@/lib/recent-code-store";
import { getSession } from "@/lib/session";
import { newThread } from "@/lib/thread-token";
import { CodeError } from "../code-error";
import { RenderCoding } from "./render-coding";
import { RenderQuiz } from "./render-quiz";
import { RenderTutor } from "./render-tutor";
import { RenderWriting } from "./render-writing";

// The student entry point for EVERY module, reachable ONLY through a code created
// by a teacher (`/<code>`). A thin dispatcher: it checks the code + window
// server-side, signs the thread-ownership token, then delegates to the module's
// own server render component by the `module` read off the row. (The chat runtime
// route re-checks the code on every request — this page only decides what to
// render.)
//
// Being a single dynamic segment, this route also catches every unknown
// top-level path (`/whatever`) — checkCode pattern-rejects those without a
// database round-trip and the student sees "unknown code". Static routes
// (`/files`, `/codes`, …) take precedence over this segment.
export default async function CodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const session = await getSession();
  const userId = session?.user?.id;

  const verification = await checkCode(code);
  if (!verification.ok) {
    // A definitively dead code (unknown or expired) disappears from the user's
    // recent-codes shortcuts; transient failures and not-yet-started codes
    // survive. Off the response path — the student sees the error page
    // immediately either way.
    const { reason } = verification;
    if (userId && (reason === "unknown-code" || reason === "expired")) {
      after(() => removeRecentCode(userId, code));
    }
    return (
      <Main>
        <CodeError verification={verification} />
      </Main>
    );
  }
  const { entry } = verification;

  // The activity cannot work without a user id: the runtime route binds every
  // thread to the session user via the ownership token below. The Entra gate
  // (proxy.ts) guarantees a session, so this only catches a stale cookie shape.
  if (!userId) {
    return (
      <Main>
        <Notice heading="Session problem">
          <p>Your session is missing required user information. Sign out and sign in again.</p>
        </Notice>
      </Main>
    );
  }
  // Remember the successful open as a shortcut on the entry page.
  after(() => recordRecentCode(userId, code));

  // The Mastra thread id is generated HERE, server-side, and signed together with
  // the code and the session user. The chat runtime route only accepts
  // thread-touching requests whose (code, user, threadId) triple matches the
  // token — that, not Mastra, is what isolates students' chats from each other
  // (see lib/thread-token.ts). A page load always mints one; a tutor tab that
  // resumes its stored conversation after a reload simply leaves it unused
  // (app/tutor-chat.tsx).
  const { threadId, threadToken } = newThread(code, userId);

  // Dispatch by module. The registry holds the non-rendering seams; rendering is
  // a thin switch so no React/JSX lives in the server-only registry.
  switch (entry.module) {
    case "tutor":
      return (
        <RenderTutor entry={entry} code={code} threadId={threadId} threadToken={threadToken} />
      );
    case "quiz":
      return <RenderQuiz entry={entry} code={code} userId={userId} />;
    case "writing":
      return (
        <RenderWriting entry={entry} code={code} threadId={threadId} threadToken={threadToken} />
      );
    case "coding":
      // No thread: the coding module has no in-app chat — this page mints (or
      // re-displays) the student's personal API key and shows how to connect an
      // external OpenAI-compatible coding agent to /api/coding/v1. No student-mode
      // logic here: `userId` is always the real session user id, which is exactly the
      // design's view-as-student behavior (a teacher testing this page mints a key
      // under their own user id, never a fabricated student row).
      return <RenderCoding entry={entry} code={code} userId={userId} />;
    default: {
      const exhaustive: never = entry.module;
      return exhaustive;
    }
  }
}
