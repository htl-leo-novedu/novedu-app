import type { ComponentProps } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ModuleChat as ModuleChatType } from "@/app/module-chat";
import {
  IMAGE_ACCEPT_WITH_EXTENSIONS,
  MAX_NORMALIZED_EDGE,
  MAX_RAW_IMAGE_BYTES,
} from "@/lib/image-normalize";

// TutorChat composes the shared ModuleChat primitive, so this
// suite mocks ModuleChat away and asserts only what is unique to the tutor: the
// upload-error notice, the welcome view it composes, and the props it hands
// ModuleChat. The shared chat wiring (provider headers, the threadId explicit
// mode, the markdown renderer) is owned and tested once by
// module-chat.browser.test.tsx — it is not re-checked here.
//
// The mock renders ModuleChat's children (so any provider-context children would
// mount) and reports its props to a spy. The captured `chatView` is the tutor's
// own welcome override (from useTutorWelcomeView), which renders CopilotChat.View
// — so the copilotkit mock supplies a callable `View` (reporting to viewSpy) and
// the `View.WelcomeMessage` greeting stub the welcome screen composes on top of.
const moduleChatSpy = vi.hoisted(() => vi.fn());
const viewSpy = vi.hoisted(() => vi.fn());

vi.mock("@/app/module-chat", () => ({
  ModuleChat: (props: ComponentProps<typeof ModuleChatType>) => {
    moduleChatSpy(props);
    return <div data-testid="module-chat">{props.children}</div>;
  },
}));

vi.mock("@copilotkit/react-core/v2", () => {
  const CopilotChat = {
    View: Object.assign(
      (props: Record<string, unknown>) => {
        viewSpy(props);
        return <div data-testid="ck-view" />;
      },
      { WelcomeMessage: () => <h1 data-testid="ck-welcome-message">greeting</h1> },
    ),
  };
  // The board pane's hooks (app/_tutor/board/board-frame.tsx) — only reached when
  // a test renders the frame ModuleChat is handed.
  return { CopilotChat, useAgent: () => ({ agent: { messages: [] } }), useRenderTool: () => {} };
});

// TutorChat mounts the shared ReportButton, which statically imports the report
// server actions; mock them so the browser bundle doesn't pull next/cache.
vi.mock("@/lib/report-actions", () => ({ submitChatReport: vi.fn(), submitQuizReport: vi.fn() }));

// Same for the "start over" action — the real one is server-only (node:crypto,
// the database). Its own contract is tested in lib/tutor-actions.unit.test.ts;
// here it is a seam, so these tests assert what the SURFACE does with the thread
// it gets back.
const startNewTutorThread = vi.hoisted(() => vi.fn());
const resumeTutorThread = vi.hoisted(() => vi.fn());
const listTutorThreads = vi.hoisted(() => vi.fn());
const openTutorThread = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tutor-actions", () => ({
  startNewTutorThread,
  resumeTutorThread,
  listTutorThreads,
  openTutorThread,
}));

import { TutorChat } from "@/app/tutor-chat";
import { submitChatReport } from "@/lib/report-actions";
import { readTutorThread, writeTutorThread } from "@/lib/tutor-thread-storage";

const TUTOR_CODE = "a1b2c3d4e5";
const THREAD_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const RUNTIME_HEADERS = {
  "x-code": TUTOR_CODE,
  "x-thread-token": "deadbeef".repeat(8),
};

// Every test starts with a tab that remembers no tutor thread (the resume tests
// below seed one), so the chat mounts on the server-minted thread.
beforeEach(() => {
  window.sessionStorage.clear();
  resumeTutorThread.mockReset();
});

// Every test renders the same minimal surface; overrides carry the per-test
// deltas (title, imageInput, exampleQuestions, …).
function renderTutorChat(overrides: Partial<ComponentProps<typeof TutorChat>> = {}) {
  moduleChatSpy.mockClear();
  return render(
    <TutorChat
      code={TUTOR_CODE}
      threadId={THREAD_ID}
      runtimeHeaders={RUNTIME_HEADERS}
      imageInput={false}
      description="Beschreibung des Tutors"
      {...overrides}
    />,
  );
}

test("renders the shared chat primitive and nothing above it", async () => {
  const screen = await renderTutorChat();

  await expect.element(screen.getByTestId("module-chat")).toBeInTheDocument();
  // The surface is the chat alone: no debug header (tutor URL, system-prompt preview) above it.
  expect(document.querySelector("details")).toBeNull();
});

test("hands ModuleChat the tutor agent, code+thread-keyed provider, threadId and headers", async () => {
  await renderTutorChat();

  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({
    agentId: "tutor",
    // Both halves: the code scopes the memory, the thread is the reset boundary.
    providerKey: `${TUTOR_CODE}:${THREAD_ID}`,
    threadId: THREAD_ID,
    headers: RUNTIME_HEADERS,
  });
  // The welcome screen is supplied as a chatView function.
  expect(moduleChatSpy.mock.lastCall?.[0].chatView).toBeTypeOf("function");
});

test("hands ModuleChat no board frame by default", async () => {
  const screen = await renderTutorChat();
  await expect.element(screen.getByTestId("module-chat")).toBeInTheDocument();
  expect(moduleChatSpy.mock.lastCall?.[0].frame).toBeUndefined();
});

test("hands ModuleChat the board frame for a tutor granted the board tool", async () => {
  const chat = await renderTutorChat({ board: true });
  await expect.element(chat.getByTestId("module-chat")).toBeInTheDocument();
  const frame = moduleChatSpy.mock.lastCall?.[0].frame;
  expect(frame).toBeTypeOf("function");
  // Without a drawing yet the frame renders the chat alone.
  const screen = await render(frame(<p data-testid="framed-chat">chat</p>));
  await expect.element(screen.getByTestId("framed-chat")).toBeVisible();
  expect(document.querySelector('[data-testid="board-pane"]')).toBeNull();
});

test("enables image attachments with the RAW pick ceiling when the tutor opts in", async () => {
  await renderTutorChat({ imageInput: true });

  const attachments = moduleChatSpy.mock.lastCall?.[0].attachments;
  expect(attachments).toMatchObject({
    enabled: true,
    // Dot-extensions alongside image/*: a file handed over with an EMPTY MIME
    // type (the iOS Files app does this) is dropped by CopilotKit's accept check
    // BEFORE onUpload runs, where the normalizer could have identified it by its
    // bytes. The extensions are the only way those files get a chance.
    accept: IMAGE_ACCEPT_WITH_EXTENSIONS,
    // The RAW ceiling, NOT the 5 MB send cap: CopilotKit tests maxSize against
    // the ORIGINAL file before onUpload runs, so an ordinary 24 MP phone photo
    // has to get past it in order to be resized below the send cap.
    maxSize: MAX_RAW_IMAGE_BYTES,
  });
  expect(attachments.onUpload).toBeTypeOf("function");
  expect(attachments.onUploadFailed).toBeTypeOf("function");
});

// The whole point of the onUpload hook: what leaves the browser is never the
// file the student picked.
test("normalizes a picked photo before it is attached", async () => {
  await renderTutorChat({ imageInput: true });
  const attachments = moduleChatSpy.mock.lastCall?.[0].attachments;

  const canvas = document.createElement("canvas");
  canvas.width = 2400;
  canvas.height = 1200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(0, 0, 2400, 1200);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("toBlob failed");

  const source = await attachments.onUpload(new File([blob], "photo.jpg", { type: "image/jpeg" }));
  expect(source.type).toBe("data");
  expect(source.mimeType).toBe("image/jpeg");
  // A BARE base64 payload, not a data URL — CopilotKit carries the media type
  // in its own field and builds the URL itself.
  expect(source.value.startsWith("data:")).toBe(false);

  const decoded = new Image();
  await new Promise((resolve, reject) => {
    decoded.onload = resolve;
    decoded.onerror = reject;
    decoded.src = `data:${source.mimeType};base64,${source.value}`;
  });
  expect(decoded.naturalWidth).toBe(MAX_NORMALIZED_EDGE);
});

// A rejection the student can act on, plus the copyable block that turns "it
// didn't work" into something a teacher can actually read.
test("a photo the browser cannot decode explains itself and offers copyable details", async () => {
  const screen = await renderTutorChat({ imageInput: true });
  const attachments = moduleChatSpy.mock.lastCall?.[0].attachments;

  const header = [0, 0, 0, 0x18, ...[..."ftypheic"].map((c) => c.charCodeAt(0))];
  const heic = new File([new Uint8Array([...header, ...new Array(64).fill(0)])], "IMG_0042.heic", {
    type: "image/heic",
  });

  // onUpload must THROW so CopilotKit drops the placeholder chip; the reason
  // then arrives through onUploadFailed, exactly as the library does it.
  let thrown = "";
  try {
    await attachments.onUpload(heic);
  } catch (error) {
    thrown = (error as Error).message;
  }
  expect(thrown).toContain("HEIC");
  attachments.onUploadFailed({ reason: "upload-failed", file: heic, message: thrown });

  const notice = screen.getByRole("alert");
  await expect.element(notice).toBeVisible();
  await expect.element(notice).toHaveTextContent("HEIC");
  await expect.element(screen.getByText("Details for your teacher")).toBeVisible();
});

test("passes no attachments config when the tutor does not opt in", async () => {
  await renderTutorChat();

  expect(moduleChatSpy.mock.lastCall?.[0].attachments).toBeUndefined();
});

test("passes the tutor title as the welcome greeting label", async () => {
  await renderTutorChat({ title: "Dein Tutor für verkettete Listen" });

  expect(moduleChatSpy.mock.lastCall?.[0].labels).toEqual({
    welcomeMessageText: "Dein Tutor für verkettete Listen",
  });
});

test("keeps CopilotKit's default greeting when the tutor has no title", async () => {
  await renderTutorChat();

  expect(moduleChatSpy.mock.lastCall?.[0].labels).toBeUndefined();
});

test("the welcome view forces the welcome screen back on in explicit-threadId mode", async () => {
  await renderTutorChat();

  // Explicit mode (the threadId ModuleChat pins) suppresses the view's welcome
  // screen; the chatView wrapper must override the two flags that gate it, no
  // matter what CopilotChat passes down.
  const ChatView = moduleChatSpy.mock.lastCall?.[0].chatView;
  await render(<ChatView hasExplicitThreadId={true} isConnecting={true} />);
  expect(viewSpy.mock.lastCall?.[0]).toMatchObject({
    hasExplicitThreadId: false,
    isConnecting: false,
  });
});

// The tutor customizes the welcome screen through the chatView slot it hands
// ModuleChat (the only way to reach the chat input's onInputChange). The stubbed
// CopilotChat.View never renders its slots itself, so tests drive the chain by
// hand: render the captured chatView (which renders the stubbed CopilotChat.View
// and reports its props to viewSpy), then render the welcomeMessage sub-slot it
// composed.
async function renderWelcomeMessage(viewProps: Record<string, unknown> = {}) {
  viewSpy.mockClear();
  const ChatView = moduleChatSpy.mock.lastCall?.[0].chatView;
  expect(ChatView).toBeTypeOf("function");
  await render(<ChatView {...viewProps} />);
  const WelcomeMessage = viewSpy.mock.lastCall?.[0].welcomeScreen?.welcomeMessage;
  expect(WelcomeMessage).toBeTypeOf("function");
  return render(<WelcomeMessage />);
}

test("the welcome screen slot composes the built-in greeting plus the description", async () => {
  await renderTutorChat({ description: "Ich helfe dir Schritt für Schritt." });

  const screen = await renderWelcomeMessage();
  await expect.element(screen.getByTestId("ck-welcome-message")).toBeInTheDocument();
  await expect.element(screen.getByText("Ich helfe dir Schritt für Schritt.")).toBeInTheDocument();
});

const EXAMPLE_QUESTIONS = [
  { title: "Was ist eine Liste?", question: "Kannst du mir erklären, was eine Liste ist?" },
  { title: "Knoten einfügen", question: "Wie füge ich einen Knoten am Anfang ein?" },
];

test("example questions render as buttons with the question text as tooltip", async () => {
  await renderTutorChat({ exampleQuestions: EXAMPLE_QUESTIONS });

  const screen = await renderWelcomeMessage();
  for (const { title, question } of EXAMPLE_QUESTIONS) {
    const button = screen.getByRole("button", { name: title });
    await expect.element(button).toBeVisible();
    await expect.element(button).toHaveAttribute("title", question);
  }
});

test("clicking an example question fills the chat input without sending", async () => {
  await renderTutorChat({ exampleQuestions: EXAMPLE_QUESTIONS });

  const onInputChange = vi.fn();
  const onSubmitMessage = vi.fn();
  const screen = await renderWelcomeMessage({ onInputChange, onSubmitMessage });
  await screen.getByRole("button", { name: "Knoten einfügen" }).click();

  expect(onInputChange).toHaveBeenCalledExactlyOnceWith("Wie füge ich einen Knoten am Anfang ein?");
  // Filling the input must not submit the message.
  expect(onSubmitMessage).not.toHaveBeenCalled();
});

test("renders no question list when the tutor defines no example questions", async () => {
  await renderTutorChat();

  const screen = await renderWelcomeMessage();
  expect(screen.container.querySelector("ul")).toBeNull();
});

test("a failed upload shows a dismissible notice", async () => {
  const screen = await renderTutorChat({ imageInput: true });

  // Simulate CopilotKit rejecting a file (too large / wrong type): the chat
  // calls onUploadFailed, and TutorChat must surface the reason to the student.
  const attachments = moduleChatSpy.mock.lastCall?.[0].attachments;
  if (!attachments) throw new Error("attachments config was not passed to ModuleChat");
  attachments.onUploadFailed({
    reason: "file-too-large",
    file: new File([], "homework.png"),
    message: "File exceeds the maximum size of 30.0 MB",
  });

  const notice = screen.getByRole("alert");
  await expect.element(notice).toBeVisible();
  // OUR wording REPLACES the library's: its message names the raw pick ceiling,
  // an implementation detail a student cannot act on.
  await expect.element(notice).toHaveTextContent("homework.png: this photo is too large to send");

  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(screen.getByRole("alert").query()).toBeNull();
});

// "Start over" — the surface's one piece of owned state. The action is mocked
// (above); what matters here is that a confirmed restart moves the thread, its
// token, the provider key and the report target TOGETHER, and that nothing moves
// before the student confirms or when the action fails.

const NEW_THREAD = {
  threadId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  threadToken: "cafebabe".repeat(8),
};

/** Opens the confirm dialog and clicks its "Start over" action. */
async function confirmStartOver(screen: Awaited<ReturnType<typeof renderTutorChat>>) {
  await screen.getByRole("button", { name: "Start over" }).click();
  await screen.getByRole("dialog").getByRole("button", { name: "Start over" }).click();
}

test("opening the confirmation changes nothing until the student confirms", async () => {
  startNewTutorThread.mockResolvedValue({ ok: true, ...NEW_THREAD });
  const screen = await renderTutorChat();

  await screen.getByRole("button", { name: "Start over" }).click();

  await expect.element(screen.getByRole("dialog")).toBeVisible();
  expect(startNewTutorThread).not.toHaveBeenCalled();
  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({ threadId: THREAD_ID });
});

test("confirming swaps in the new thread, its token and the provider key", async () => {
  startNewTutorThread.mockResolvedValue({ ok: true, ...NEW_THREAD });
  const screen = await renderTutorChat();

  await confirmStartOver(screen);

  expect(startNewTutorThread).toHaveBeenCalledExactlyOnceWith({ code: TUTOR_CODE });
  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({
    threadId: NEW_THREAD.threadId,
    // The remount boundary — this is what discards the browser's message list.
    providerKey: `${TUTOR_CODE}:${NEW_THREAD.threadId}`,
    headers: { "x-code": TUTOR_CODE, "x-thread-token": NEW_THREAD.threadToken },
  });
});

test("a report filed after a restart targets the NEW conversation", async () => {
  startNewTutorThread.mockResolvedValue({ ok: true, ...NEW_THREAD });
  vi.mocked(submitChatReport).mockResolvedValue({ ok: true });
  const screen = await renderTutorChat();

  await confirmStartOver(screen);

  // Drive a real report through: the dialog's own contract lives in
  // report-button.browser.test.tsx — what matters here is the target it carries,
  // which must never be the abandoned thread.
  await screen.getByRole("button", { name: "Report" }).click();
  await screen.getByRole("button", { name: "Good" }).click();
  await screen.getByRole("button", { name: "Send report" }).click();

  expect(submitChatReport).toHaveBeenCalledWith(
    expect.objectContaining({
      code: TUTOR_CODE,
      threadId: NEW_THREAD.threadId,
      threadToken: NEW_THREAD.threadToken,
    }),
  );
});

test("a stale upload notice does not survive the restart", async () => {
  startNewTutorThread.mockResolvedValue({ ok: true, ...NEW_THREAD });
  const screen = await renderTutorChat({ imageInput: true });

  moduleChatSpy.mock.lastCall?.[0].attachments.onUploadFailed({
    reason: "file-too-large",
    file: new File([], "homework.png"),
    message: "File exceeds the 5 MB limit",
  });
  await expect.element(screen.getByRole("alert")).toBeVisible();

  await confirmStartOver(screen);

  expect(screen.getByRole("alert").query()).toBeNull();
});

test("a failed restart shows the reason and leaves the conversation untouched", async () => {
  startNewTutorThread.mockResolvedValue({
    ok: false,
    message: "This activity's availability window has ended.",
  });
  const screen = await renderTutorChat();

  await confirmStartOver(screen);

  const dialog = screen.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByText("This activity's availability window has ended."))
    .toBeVisible();
  // The student keeps the chat they had.
  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({
    threadId: THREAD_ID,
    providerKey: `${TUTOR_CODE}:${THREAD_ID}`,
    headers: RUNTIME_HEADERS,
  });
});

test("a confirmed restart remembers the NEW thread for this tab, not restoring", async () => {
  startNewTutorThread.mockResolvedValue({ ok: true, ...NEW_THREAD });
  const screen = await renderTutorChat();

  await confirmStartOver(screen);

  expect(readTutorThread(TUTOR_CODE)).toEqual(NEW_THREAD);
  // A fresh thread has nothing to restore: the welcome screen may show at once.
  await renderView();
  expect(viewSpy.mock.lastCall?.[0]).toMatchObject({ isConnecting: false });
});

// Resume on reload (docs/chat.md → Resuming a conversation): the tab's stored
// thread is checked with the server before the chat mounts on it; the action is
// a mocked seam here (its contract: lib/tutor-actions.unit.test.ts).

const STORED_THREAD = {
  threadId: "5d6f2a3e-0c1b-4d8e-9f70-1a2b3c4d5e6f",
  threadToken: "feedface".repeat(8),
};

/** Renders the captured chatView, so its CopilotChat.View props reach viewSpy. */
async function renderView() {
  const ChatView = moduleChatSpy.mock.lastCall?.[0].chatView as
    | ((props: Record<string, unknown>) => React.ReactNode)
    | undefined;
  if (!ChatView) throw new Error("no chatView passed to ModuleChat");
  viewSpy.mockClear();
  await render(<ChatView />);
}

test("with nothing stored, the chat mounts on the server thread and remembers it", async () => {
  await renderTutorChat();

  await vi.waitFor(() => expect(moduleChatSpy).toHaveBeenCalled());
  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({ threadId: THREAD_ID });
  expect(resumeTutorThread).not.toHaveBeenCalled();
  expect(readTutorThread(TUTOR_CODE)).toEqual({
    threadId: THREAD_ID,
    threadToken: RUNTIME_HEADERS["x-thread-token"],
  });
});

test("a stored thread shows the restoring placeholder until the server answers", async () => {
  writeTutorThread(TUTOR_CODE, STORED_THREAD);
  let answer: (value: { ok: boolean }) => void = () => {};
  resumeTutorThread.mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const screen = await renderTutorChat();

  await expect.element(screen.getByText("Restoring your conversation…")).toBeVisible();
  expect(moduleChatSpy).not.toHaveBeenCalled();
  // The toolbar waits too: its report target is the decided thread.
  expect(screen.getByRole("button", { name: "Start over" }).query()).toBeNull();

  answer({ ok: true });
  await vi.waitFor(() => expect(moduleChatSpy).toHaveBeenCalled());
});

test("an accepted resume mounts the chat on the STORED thread, restoring", async () => {
  writeTutorThread(TUTOR_CODE, STORED_THREAD);
  resumeTutorThread.mockResolvedValue({ ok: true });
  await renderTutorChat();

  await vi.waitFor(() => expect(moduleChatSpy).toHaveBeenCalled());
  expect(resumeTutorThread).toHaveBeenCalledExactlyOnceWith({ code: TUTOR_CODE, ...STORED_THREAD });
  expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({
    threadId: STORED_THREAD.threadId,
    providerKey: `${TUTOR_CODE}:${STORED_THREAD.threadId}`,
    headers: { "x-code": TUTOR_CODE, "x-thread-token": STORED_THREAD.threadToken },
  });
  expect(readTutorThread(TUTOR_CODE)).toEqual(STORED_THREAD);
  // The messages arrive with the connect: no welcome screen flash meanwhile.
  await renderView();
  expect(viewSpy.mock.lastCall?.[0]).toMatchObject({ isConnecting: true });
});

test.each([
  ["refused", () => resumeTutorThread.mockResolvedValue({ ok: false })],
  ["failing (network)", () => resumeTutorThread.mockRejectedValue(new Error("offline"))],
])(
  "a %s resume falls back to the server thread and replaces the entry",
  async (_label, arrange) => {
    writeTutorThread(TUTOR_CODE, STORED_THREAD);
    arrange();
    await renderTutorChat();

    await vi.waitFor(() => expect(moduleChatSpy).toHaveBeenCalled());
    expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({ threadId: THREAD_ID });
    expect(readTutorThread(TUTOR_CODE)).toEqual({
      threadId: THREAD_ID,
      threadToken: RUNTIME_HEADERS["x-thread-token"],
    });
    await renderView();
    expect(viewSpy.mock.lastCall?.[0]).toMatchObject({ isConnecting: false });
  },
);

// "Previous conversations" (per-user tutors): the button exists only with
// history on, and a reopened conversation moves the whole chat to its thread.

test("no history button when history is off", async () => {
  const screen = await renderTutorChat();
  await expect.element(screen.getByRole("button", { name: "Start over" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Previous conversations" }).query()).toBeNull();
});

test("reopening a conversation switches the chat to it, restoring, and remembers it", async () => {
  const OLD = "3c2b1a00-aaaa-4bbb-8ccc-dddddddddddd";
  listTutorThreads.mockResolvedValue({
    ok: true,
    threads: [
      {
        threadId: OLD,
        lastActivityAt: new Date(2025, 0, 1, 10, 0),
        userMessageCount: 4,
        preview: { kind: "text", text: "An older question" },
      },
    ],
    more: false,
  });
  openTutorThread.mockResolvedValue({ ok: true, threadToken: "beadfeed".repeat(8) });
  const screen = await renderTutorChat({ historyEnabled: true });

  await screen.getByRole("button", { name: "Previous conversations" }).click();
  await screen.getByText("An older question").click();

  await vi.waitFor(() =>
    expect(moduleChatSpy.mock.lastCall?.[0]).toMatchObject({
      threadId: OLD,
      providerKey: `${TUTOR_CODE}:${OLD}`,
      headers: { "x-code": TUTOR_CODE, "x-thread-token": "beadfeed".repeat(8) },
    }),
  );
  expect(readTutorThread(TUTOR_CODE)).toEqual({ threadId: OLD, threadToken: "beadfeed".repeat(8) });
  await renderView();
  expect(viewSpy.mock.lastCall?.[0]).toMatchObject({ isConnecting: true });
});
