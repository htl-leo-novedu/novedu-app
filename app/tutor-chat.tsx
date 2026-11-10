"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ImageErrorNotice } from "@/components/image-error-notice";
import { ReportButton } from "@/components/report-button";
import { LoadingPanel } from "@/components/spinner";
import {
  IMAGE_ACCEPT_WITH_EXTENSIONS,
  type ImageDiagnostics,
  MAX_RAW_IMAGE_BYTES,
  normalizeStudentImage,
} from "@/lib/image-normalize";
import {
  buildRuntimeHeaders,
  RUNTIME_THREAD_TOKEN_HEADER,
  type RuntimeHeaders,
} from "@/lib/runtime-headers";
import { resumeTutorThread } from "@/lib/tutor-actions";
import { readTutorThread, removeTutorThread, writeTutorThread } from "@/lib/tutor-thread-storage";
import type { ExampleQuestion } from "@/lib/tutors";
import { BoardFrame } from "./_tutor/board/board-frame";
import { PreviousConversationsButton } from "./_tutor/previous-conversations-button";
import { StartOverButton } from "./_tutor/start-over-button";
import { useTutorWelcomeView } from "./_tutor/welcome-view";
import { ModuleChat } from "./module-chat";

// The tutor module's chat surface. The shared CopilotKit wiring (provider,
// CopilotChat, the threadId explicit-mode decision, the markdown renderer) lives
// in ModuleChat; this component supplies only the tutor-specific shell — the
// image-upload notice and the welcome-screen override. The server component
// (app/[code]/render-tutor.tsx) checks the code and the tutor YAML and passes
// the result down — including the ready-made runtime headers carrying the code,
// which travels along on every runtime request so the backend can re-check it.
// The client is never trusted.
//
// IMAGES: every picked photo goes through `normalizeStudentImage` before it is
// inlined into a run — see lib/image-normalize.ts for why (GitHub #26). Note the
// TWO different size limits: CopilotKit checks `maxSize` against the ORIGINAL
// File, before `onUpload` ever runs, so it must be the ceiling on what a phone
// may hand us (`MAX_RAW_IMAGE_BYTES`); `MAX_IMAGE_BYTES` bounds what we SEND and
// is enforced inside the normalizer, on its output. Setting `maxSize` to the
// send cap is the bug that rejects an ordinary 24 MP phone photo outright.
//
// The thread is the one piece of server state this surface OWNS after mount:
// "start over" swaps in a freshly minted (threadId, threadToken) pair, so the
// props below only SEED it. Everything that identifies the conversation — the
// runtime headers, the report target, the provider remount key — is derived from
// that state, never from the props, so a restart moves them all together.
//
// RESUME ON RELOAD (docs/chat.md → Resuming a conversation): the tab remembers
// its current thread in `sessionStorage` (lib/tutor-thread-storage.ts). That
// storage exists only in the browser, so the server render and the first client
// render both show a "deciding" placeholder — reading it during render would
// break hydration — and an effect decides: with a stored thread the server is
// asked whether it may be resumed (`resumeTutorThread`); otherwise, or when it
// refuses, the server-minted thread from the props is used and stored. A resumed
// thread mounts with `restoring` set: its messages arrive with the chat's
// `connect` (app/api/copilotkit/history-snapshot-runner.ts), and until they do
// the welcome screen must not flash.

/** The conversation the chat runs on; `restoring` = its messages arrive with the connect. */
interface ChatThread {
  threadId: string;
  threadToken: string;
  restoring: boolean;
}

/** Before the effect decided (`deciding`), while the server checks a stored thread (`resuming`), or the thread. */
type ThreadPhase =
  | { kind: "deciding" }
  | { kind: "resuming" }
  | { kind: "ready"; thread: ChatThread };

/** Lays the chat out with the tutor's board pane (inside the chat's provider). */
function renderBoardFrame(chat: ReactNode) {
  return <BoardFrame>{chat}</BoardFrame>;
}

/** The accumulated upload notice: one sentence per rejected file, plus what we learned about each. */
interface UploadFailures {
  messages: string[];
  diagnostics: ImageDiagnostics[];
}

export function TutorChat({
  code,
  threadId,
  runtimeHeaders,
  imageInput,
  title,
  description,
  exampleQuestions = [],
  historyEnabled = false,
  board = false,
}: {
  /** The code the chat was opened with — half of the provider key. */
  code: string;
  /**
   * Server-generated Mastra thread id, signed into the `x-thread-token`
   * runtime header — the runtime rejects any other threadId for this session.
   * The INITIAL thread only; "start over" replaces it (see below).
   */
  threadId: string;
  /** Carries the initial thread's ownership token; re-derived after a restart. */
  runtimeHeaders: RuntimeHeaders;
  /** Tutor `llm.imageInput`: students may attach images (vision-capable model). */
  imageInput: boolean;
  /** Tutor `title`: replaces the default "How can I help you today?" greeting. */
  title?: string;
  /** Tutor `description`: rendered below the greeting on the welcome screen. */
  description: string;
  /** ≤5 questions, sampled server-side; clicking one fills the chat input. */
  exampleQuestions?: ExampleQuestion[];
  /**
   * A per-user tutor (frozen AND live `anonymous` false): offers "Previous
   * conversations" and the per-user Start-over wording.
   */
  historyEnabled?: boolean;
  /**
   * The tutor is granted the `board` tool (docs/tutor-board.md): the chat gets
   * the board pane, which appears with the first drawing.
   */
  board?: boolean;
}) {
  // Rejected uploads (undecodable, too large, wrong type) call onUploadFailed and
  // silently drop the file — without this notice the student would never learn why.
  const [uploadFailures, setUploadFailures] = useState<UploadFailures | null>(null);
  // `onUpload` knows WHY a file was rejected but must throw for CopilotKit to
  // drop the placeholder chip; `onUploadFailed` is where the reason surfaces.
  // The diagnostics ride between them here, so state is written in exactly one place.
  const pendingDiagnostics = useRef<ImageDiagnostics | null>(null);
  // The live conversation: decided after mount (resumed from this tab's storage,
  // or the server-minted one from the props) and replaced wholesale by "start
  // over". Both halves move together — a token only ever proves the thread it
  // was signed for.
  const [phase, setPhase] = useState<ThreadPhase>({ kind: "deciding" });
  const thread = phase.kind === "ready" ? phase.thread : null;
  const serverThreadToken = runtimeHeaders[RUNTIME_THREAD_TOKEN_HEADER];

  useEffect(() => {
    let cancelled = false;
    const minted: ChatThread = { threadId, threadToken: serverThreadToken, restoring: false };
    const adoptMinted = () => {
      writeTutorThread(code, minted);
      setPhase({ kind: "ready", thread: minted });
    };

    const stored = readTutorThread(code);
    if (!stored) {
      adoptMinted();
      return;
    }
    setPhase({ kind: "resuming" });
    // Any failure, a network error included, starts fresh: the stored entry is
    // dropped and the server-minted thread takes its place.
    Promise.resolve()
      .then(() =>
        resumeTutorThread({ code, threadId: stored.threadId, threadToken: stored.threadToken }),
      )
      .then(
        (result) => result.ok,
        () => false,
      )
      .then((ok) => {
        if (cancelled) return;
        if (ok) {
          setPhase({ kind: "ready", thread: { ...stored, restoring: true } });
        } else {
          removeTutorThread(code);
          adoptMinted();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, threadId, serverThreadToken]);

  /** Swaps the chat onto another thread and remembers it for this tab. */
  function switchThread(next: ChatThread) {
    writeTutorThread(code, next);
    setPhase({ kind: "ready", thread: next });
  }

  const chatView = useTutorWelcomeView({
    description,
    exampleQuestions,
    restoring: thread?.restoring ?? false,
  });
  // Memoized so the provider sees a stable headers object between renders and
  // a NEW one exactly when the thread changes.
  const threadToken = thread?.threadToken ?? "";
  const headers = useMemo(() => buildRuntimeHeaders(code, threadToken), [code, threadToken]);

  function addFailure(message: string, diagnostics: ImageDiagnostics | null) {
    setUploadFailures((prev) => ({
      messages: [...(prev?.messages ?? []), message],
      diagnostics: [...(prev?.diagnostics ?? []), ...(diagnostics ? [diagnostics] : [])],
    }));
  }

  if (!thread) {
    // Deciding renders nothing visible (it lasts one tick); resuming waits on
    // the server, so it says what is happening.
    return phase.kind === "resuming" ? (
      <LoadingPanel label="Restoring your conversation…" />
    ) : (
      <div className="flex-1" aria-busy="true" />
    );
  }

  return (
    <>
      {uploadFailures ? (
        <ImageErrorNotice
          className="mx-5 mb-2 shrink-0"
          diagnostics={uploadFailures.diagnostics}
          messages={uploadFailures.messages}
          onDismiss={() => setUploadFailures(null)}
          origin="tutor chat"
        />
      ) : null}

      {/* The chat toolbar. "Start over" mints a fresh thread server-side and
          "Previous conversations" (per-user tutors) reopens an earlier one; either
          is swapped in here. The report always targets the CURRENT conversation,
          and its server action re-verifies the token over (code, userId, threadId). */}
      <div className="mx-5 mb-2 flex shrink-0 items-center justify-end gap-2">
        {historyEnabled ? (
          <PreviousConversationsButton
            code={code}
            currentThreadId={thread.threadId}
            onOpened={(next) => {
              // Like a resume: the messages arrive with the remounted chat's connect.
              switchThread({ ...next, restoring: true });
              setUploadFailures(null);
            }}
          />
        ) : null}
        <StartOverButton
          code={code}
          historyEnabled={historyEnabled}
          onStarted={(next) => {
            switchThread({ ...next, restoring: false });
            // A banner about a file the previous conversation rejected must not
            // outlive that conversation.
            setUploadFailures(null);
          }}
        />
        <ReportButton
          target={{
            kind: "chat",
            code,
            threadId: thread.threadId,
            threadToken: thread.threadToken,
          }}
        />
      </div>

      <ModuleChat
        agentId="tutor"
        // Keyed by code AND thread: "start over" changes the thread half, which
        // remounts the provider and discards the browser's message list — that
        // remount IS the reset (see providerKey in app/module-chat.tsx).
        providerKey={`${code}:${thread.threadId}`}
        threadId={thread.threadId}
        headers={headers}
        // Tutor needs no height/padding delta: ModuleChat's base container matches it.
        labels={title ? { welcomeMessageText: title } : undefined}
        chatView={chatView}
        frame={board ? renderBoardFrame : undefined}
        attachments={
          imageInput
            ? {
                enabled: true,
                accept: IMAGE_ACCEPT_WITH_EXTENSIONS,
                maxSize: MAX_RAW_IMAGE_BYTES,
                onUpload: async (file) => {
                  const result = await normalizeStudentImage(file);
                  pendingDiagnostics.current = result.diagnostics;
                  if (!result.ok) throw new Error(result.message);
                  // CopilotKit wants the bare base64 payload, with the media type
                  // beside it — not the data URL the normalizer hands back.
                  return {
                    type: "data",
                    value: result.dataUrl.slice(result.dataUrl.indexOf(",") + 1),
                    mimeType: result.mimeType,
                  };
                },
                onUploadFailed: ({ reason, file, message }) => {
                  // REPLACE the library's stock English wording rather than
                  // appending to it: it names the raw ceiling, which is an
                  // implementation detail the student cannot act on.
                  const diagnostics = pendingDiagnostics.current;
                  pendingDiagnostics.current = null;
                  if (reason === "upload-failed") {
                    addFailure(message, diagnostics);
                  } else if (reason === "file-too-large") {
                    addFailure(
                      `${file.name}: this photo is too large to send. Take it again at a lower resolution, or pick a smaller copy.`,
                      null,
                    );
                  } else {
                    addFailure(`${file.name}: only photos can be attached.`, null);
                  }
                },
              }
            : undefined
        }
      />
    </>
  );
}
