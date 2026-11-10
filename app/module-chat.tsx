"use client";

import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import type { RuntimeHeaders } from "@/lib/runtime-headers";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";

// The one live-chat primitive. Every module's chat (tutor / writing / quiz) is
// this component plus its own slots: it owns the dangerous, duplicated wiring —
// the CopilotKitProvider pointed at /api/copilotkit, the runtime headers, the
// threadId explicit-mode decision, the swap-the-default markdown renderer, and
// the base chat container — so each module supplies only what is unique to it.
// The backend seam (the /api/copilotkit route + the module runtime) is separate
// and unchanged; see docs/chat.md and docs/codes.md.

// The "generation in progress" indicator, replacing CopilotKit's default pulsing
// dot with a readable note. It shows for the WHOLE run whenever the last message
// is not a reasoning message — which, for a student, is always: the runtime
// strips every reasoning event before it reaches the browser
// (app/api/copilotkit/reasoning-runner.ts). A teacher on a thinking model sees
// the reasoning block while the thinking streams and this note the rest of the
// run. The wording must therefore stay true for the ENTIRE run and for every
// model: the slot is global to every ModuleChat consumer (tutor, writing, quiz
// discussion) and every provider, including ones that never think at all.
function GenerationCursor({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-testid="chat-generating-note"
      className={cn("ml-1 text-muted-foreground text-sm", className)}
      {...props}
    >
      Generating…
    </div>
  );
}

export type ModuleChatProps = {
  /** The module runtime's agentId — must match the registered agent. */
  agentId: string;
  /**
   * Server-generated Mastra thread id, signed into the `x-thread-token`
   * runtime header. Pinned through CopilotChat's `threadId` prop (explicit
   * mode); the runtime rejects any other threadId for this session.
   */
  threadId: string;
  /** The code + thread-ownership token, both re-verified server-side per request. */
  headers: RuntimeHeaders;
  /**
   * Remount boundary for the provider: changing it starts a fresh thread.
   * Writing keys by code (per-code memory scope); quiz keys by threadId (a new
   * discussion per question); tutor keys by BOTH — the code scopes the memory
   * and the thread half is what its student-facing "start over" moves.
   */
  providerKey: string;
  /**
   * Optional module deltas (height/padding), cn-merged onto the base chat
   * container — the base (fill the available height, never push the page
   * taller, let CopilotChat own the internal scroll) is built in.
   */
  className?: string;
  /** Rendered INSIDE the provider, before the chat — frontend tools, feedback headers. */
  children?: ReactNode;
  /** Welcome greeting override (tutor). */
  labels?: ComponentProps<typeof CopilotChat>["labels"];
  /** Welcome-screen view override (tutor). */
  chatView?: ComponentProps<typeof CopilotChat>["chatView"];
  /** Image-upload config (tutor, vision-capable model). */
  attachments?: ComponentProps<typeof CopilotChat>["attachments"];
  /**
   * Wraps the chat container INSIDE the provider (the tutor's board pane lays
   * itself out beside or above the chat). Without it the chat renders bare.
   */
  frame?: (chat: ReactNode) => ReactNode;
};

export function ModuleChat({
  agentId,
  threadId,
  headers,
  providerKey,
  className,
  children,
  labels,
  chatView,
  attachments,
  frame,
}: ModuleChatProps) {
  const chat = (
    <>
      {/* Base chat container: fill the available height (min-h-0 against flex
          parents), never push the page taller, and let CopilotChat (*:h-full)
          own the internal scroll. */}
      <div className={cn("min-h-0 flex-1 overflow-hidden *:h-full", className)}>
        {/*
          The server-issued threadId MUST go through CopilotChat's `threadId`
          prop (explicit mode). Pinning it via CopilotChatConfigurationProvider
          with `hasExplicitThreadId={false}` looks equivalent but is not: the
          chat then strands its agent mid-run (messages cleared, stuck
          "running") on the first send. Explicit mode also fires a connect
          request on mount, token-checked like a run: for a fresh thread the
          runtime replays the (empty) in-process history; for a tutor thread
          resumed after a reload it answers with the stored conversation
          (app/api/copilotkit/history-snapshot-runner.ts).
        */}
        <CopilotChat
          threadId={threadId}
          agentId={agentId}
          labels={labels}
          chatView={chatView}
          messageView={{
            assistantMessage: { markdownRenderer: MarkdownRenderer },
            cursor: GenerationCursor,
          }}
          attachments={attachments}
        />
      </div>
    </>
  );
  const body = (
    <>
      {children}
      {frame ? frame(chat) : chat}
    </>
  );

  return (
    // The code must NOT go in runtimeUrl's query string: CopilotKit builds
    // sub-route URLs (e.g. /info) by appending to runtimeUrl, which would
    // yield `/api/copilotkit?code=.../info` (404). Pass it as a header instead
    // (x-code), sent on every runtime request and re-checked server-side.
    // Keyed by providerKey so changing it remounts the provider — a fresh
    // thread, matching the module's memory scope.
    <CopilotKitProvider key={providerKey} runtimeUrl="/api/copilotkit" headers={headers}>
      {body}
    </CopilotKitProvider>
  );
}
