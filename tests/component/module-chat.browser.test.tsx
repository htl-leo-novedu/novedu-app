import type { ComponentProps, ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// Stub CopilotKit's v2 chat: the real provider can't mount under the test
// runner's bundled React (same constraint as the other chat suites), and this
// suite verifies only ModuleChat's SHARED wiring — the live chat is exercised by
// the e2e tests instead. The provider stub renders its children and reports its
// props to a spy; CopilotChat is a spy stub reporting its props. This is the one
// place the provider/threadId/markdown-renderer wiring is asserted: the
// per-module tests mock ModuleChat away and never re-check it.
const providerSpy = vi.hoisted(() => vi.fn());
const chatSpy = vi.hoisted(() => vi.fn());

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKitProvider: ({ children, ...props }: { children: ReactNode }) => {
    providerSpy(props);
    return <div data-testid="ck-provider">{children}</div>;
  },
  CopilotChat: ({ agentId, ...props }: { agentId: string }) => {
    chatSpy({ agentId, ...props });
    return <div data-testid="ck-chat">{agentId}</div>;
  },
}));

import { MarkdownRenderer } from "@/app/markdown-renderer";
import { ModuleChat } from "@/app/module-chat";

type ModuleChatProps = ComponentProps<typeof ModuleChat>;

const AGENT_ID = "tutor";
const THREAD_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PROVIDER_KEY = "a1b2c3d4e5";
const RUNTIME_HEADERS = {
  "x-code": "a1b2c3d4e5",
  "x-thread-token": "deadbeef".repeat(8),
};

test("points the provider at the runtime URL and forwards the headers verbatim", async () => {
  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  // The code travels as the x-code header (never the runtimeUrl query string),
  // re-checked server-side on every request.
  expect(providerSpy.mock.lastCall?.[0]).toMatchObject({
    runtimeUrl: "/api/copilotkit",
    headers: RUNTIME_HEADERS,
  });
});

test("pins the server-generated threadId on CopilotChat (explicit mode)", async () => {
  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  // The id goes through CopilotChat's `threadId` prop (explicit mode — the only
  // mode where the pinned thread reliably carries the conversation).
  expect(chatSpy.mock.lastCall?.[0].threadId).toBe(THREAD_ID);
});

test("mounts the chat for the passed agent", async () => {
  const screen = await render(
    <ModuleChat
      agentId="writing"
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  await expect.element(screen.getByTestId("ck-chat")).toHaveTextContent("writing");
  expect(chatSpy.mock.lastCall?.[0].agentId).toBe("writing");
});

test("wires the shared markdown renderer for assistant messages", async () => {
  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  // The same renderer everywhere, so math/code/markdown match across modules.
  expect(chatSpy.mock.lastCall?.[0].messageView?.assistantMessage?.markdownRenderer).toBe(
    MarkdownRenderer,
  );
});

test("overrides the cursor slot with a readable 'Generating…' note", async () => {
  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  // Students never receive reasoning (the runtime strips it — docs/chat.md), so
  // CopilotKit's cursor is what they see for the whole run; it must read as a
  // note, not a bare pulsing dot, and its wording must stay true for the whole
  // run on any model. The slot is global to every ModuleChat consumer, so it is
  // asserted here once.
  const Cursor = chatSpy.mock.lastCall?.[0].messageView?.cursor;
  expect(Cursor).toBeTypeOf("function");

  const screen = await render(<Cursor />);
  await expect.element(screen.getByTestId("chat-generating-note")).toHaveTextContent("Generating");
  // Muted + small, so it never competes with the answer.
  expect(screen.getByTestId("chat-generating-note").element().className).toContain(
    "text-muted-foreground",
  );
});

test("renders children directly inside the provider, before the chat", async () => {
  const screen = await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    >
      <div data-testid="slot-child">slot</div>
    </ModuleChat>,
  );

  // The child lives inside the provider (frontend tools / feedback headers need
  // the provider's React context) as a direct fragment member, with no wrapping
  // div: the primitive is layout-agnostic, so any module-specific layout container
  // (e.g. quiz's discussion body) is the module's own concern, outside ModuleChat.
  const provider = screen.getByTestId("ck-provider").element();
  const child = screen.getByTestId("slot-child").element();
  expect(child.parentElement).toBe(provider);

  // ...and it precedes the chat in document order.
  const chat = screen.getByTestId("ck-chat").element();
  expect(child.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("passes labels, chatView, and attachments through to CopilotChat verbatim", async () => {
  const labels: ModuleChatProps["labels"] = { welcomeMessageText: "Hallo" };
  // A module's chatView is a component (tutor's welcome-screen override); the
  // cast names it as ModuleChat's slot type so we can assert it is forwarded by
  // reference, untouched.
  const chatView = (() => <div data-testid="custom-view" />) as ModuleChatProps["chatView"];
  const attachments: ModuleChatProps["attachments"] = {
    enabled: true,
    accept: "image/*",
    maxSize: 5 * 1024 * 1024,
  };

  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
      labels={labels}
      chatView={chatView}
      attachments={attachments}
    />,
  );

  const props = chatSpy.mock.lastCall?.[0];
  expect(props.labels).toBe(labels);
  expect(props.chatView).toBe(chatView);
  expect(props.attachments).toBe(attachments);
});

test("omits the optional slots when not given", async () => {
  await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="chat"
    />,
  );

  const props = chatSpy.mock.lastCall?.[0];
  expect(props.labels).toBeUndefined();
  expect(props.chatView).toBeUndefined();
  expect(props.attachments).toBeUndefined();
});

test("owns the base chat container and cn-merges className as a delta", async () => {
  const screen = await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      className="overflow-visible px-3"
    />,
  );

  // The fill recipe (min-h-0 flex-1 …) is ModuleChat's own — modules only pass
  // deltas, and a conflicting caller utility WINS over the base (tailwind-merge).
  const container = screen.getByTestId("ck-chat").element().parentElement;
  expect(container?.className).toContain("min-h-0");
  expect(container?.className).toContain("flex-1");
  expect(container?.className).toContain("px-3");
  expect(container?.className).toContain("overflow-visible");
  expect(container?.className).not.toContain("overflow-hidden");
});

test("wraps the chat in the passed frame inside the provider", async () => {
  const screen = await render(
    <ModuleChat
      agentId={AGENT_ID}
      threadId={THREAD_ID}
      headers={RUNTIME_HEADERS}
      providerKey={PROVIDER_KEY}
      frame={(chat) => <section data-testid="frame">{chat}</section>}
    />,
  );
  await expect.element(screen.getByTestId("frame").getByTestId("ck-chat")).toBeInTheDocument();
  await expect.element(screen.getByTestId("ck-provider").getByTestId("frame")).toBeInTheDocument();
});
