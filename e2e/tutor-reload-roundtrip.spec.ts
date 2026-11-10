import { expect, type Page, test } from "@playwright/test";
import { loadThreadBoardCalls } from "@/lib/tutor-board-store";
import {
  BOARD_TUTOR_URL,
  getStoredMessages,
  LIVE_TUTOR_URL,
  mintCode,
  mintTutorCode,
} from "./code.utils";
import { query } from "./db";
import { watchErrors, withoutNetworkNoise } from "./page.utils";

// The reload round-trip through a real chat in a WARM dev server — the one test
// of the snapshot runner's in-process replay filter that a unit test cannot give
// (app/api/copilotkit/history-snapshot-runner.ts). After a turn, the library's
// in-memory runner replays it on the next `connect` while the snapshot runner
// also sends it from the database; only the id alignment between the two
// (client-minted user ids, streamed assistant ids, both stored by Mastra) keeps
// the browser from showing every message twice. That alignment is undocumented
// behaviour of CopilotKit / AG-UI / Mastra, so this spec guards every
// `@copilotkit/*`, `@ag-ui/*` or `@mastra/*` bump (docs/chat.md). It runs in CI
// against the fake LLM (docs/testing.md, "Fake LLM"), whose streamed replies take
// the same path as a real model's; `@live-db` because it reads the stored
// messages through e2e/db.ts.

test.setTimeout(240_000);

const Q1 = "RT-ONE please name one linked list operation";
const Q2 = "RT-TWO please name another linked list operation";

/** Waits until the chat's run has finished (the streaming flag is gone). */
async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const running = await page.getByTestId("copilot-chat").getAttribute("data-copilot-running");
        return running === null || running === "false";
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

/** Sends one turn and waits for its reply to finish streaming. */
async function sendTurn(page: Page, text: string, expectedAssistantCount: number) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  const assistants = page.getByTestId("copilot-assistant-message");
  await expect(assistants).toHaveCount(expectedAssistantCount, { timeout: 90_000 });
  await expect
    .poll(
      async () => (await assistants.nth(expectedAssistantCount - 1).innerText()).trim().length,
      {
        timeout: 90_000,
      },
    )
    .toBeGreaterThan(0);
  await settle(page);
}

/** Waits until `text` is stored as a user message of `code`. */
async function storedUserMessage(code: string, text: string) {
  await expect
    .poll(async () =>
      (await getStoredMessages(code)).some((m) => m.role === "user" && m.content.includes(text)),
    )
    .toBe(true);
}

async function reloadAndWaitForChat(page: Page) {
  await page.reload();
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
}

test("a reload in a warm process shows each message exactly once", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  const code = await mintTutorCode({ tutor: LIVE_TUTOR_URL });
  const errors = watchErrors(page);
  await page.goto(`/${code}`);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();

  await sendTurn(page, Q1, 1);
  await storedUserMessage(code, Q1);

  // Reload: snapshot from the database + the filtered in-process replay.
  await reloadAndWaitForChat(page);
  await expect(page.getByTestId("copilot-user-message")).toHaveCount(1);
  await expect(page.getByTestId("copilot-user-message").first()).toContainText(Q1);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(1);
  await expect(page.getByText("Minimal tutor with a REAL model")).toHaveCount(0);
  const firstReply = (await page.getByTestId("copilot-assistant-message").innerText()).trim();
  expect(firstReply.length).toBeGreaterThan(0);

  // Continue the restored conversation: the second turn is stored once.
  await sendTurn(page, Q2, 2);
  await storedUserMessage(code, Q2);
  const users = (await getStoredMessages(code)).filter((m) => m.role === "user");
  expect(users.filter((m) => m.content.includes(Q1))).toHaveLength(1);
  expect(users.filter((m) => m.content.includes(Q2))).toHaveLength(1);

  // And once more: two runs replayed now, still one copy of everything.
  await reloadAndWaitForChat(page);
  await expect(page.getByTestId("copilot-user-message")).toHaveCount(2);
  await expect(page.getByTestId("copilot-assistant-message")).toHaveCount(2);
  // The replayed reply text is not appended to the restored one.
  await expect(page.getByTestId("copilot-assistant-message").first()).toHaveText(firstReply);

  expect(errors.filter((e) => !e.includes("Failed to load resource"))).toEqual([]);
});

test("a failed turn followed by a good one still reloads cleanly", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  // An override onto a model the endpoint does not serve (the fake LLM answers
  // any `no-such-model` id with a 404): the first turn fails IN-BAND, so the in-memory runner keeps it with a terminal RUN_ERROR — which
  // the snapshot runner must close as a RUN_FINISHED on the replay, or the
  // browser's verifier rejects every run after it.
  const code = await mintCode({
    module: "tutor",
    file: LIVE_TUTOR_URL,
    llm: { provider: "SCCH", model: "novedu-e2e-no-such-model" },
  });
  const errors = watchErrors(page);
  await page.goto(`/${code}`);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();

  await page.getByTestId("copilot-chat-textarea").fill(Q1);
  await page.getByTestId("copilot-send-button").click();
  await settle(page);

  // Back to the tutor's own (working) model for the same thread.
  await query(`UPDATE novedu_codes SET llm_provider = NULL, llm_model = NULL WHERE code = $1`, [
    code,
  ]);
  const before = (await page.getByTestId("copilot-assistant-message").count()) + 1;
  await sendTurn(page, Q2, before);
  await storedUserMessage(code, Q2);

  // Only the errors of the deliberately failed turn are expected so far.
  errors.length = 0;
  await reloadAndWaitForChat(page);
  await expect(page.getByTestId("copilot-user-message").filter({ hasText: Q2 })).toHaveCount(1);
  // No AG-UI verifier error (or any other) on the reload's connect.
  expect(errors.filter((e) => !e.includes("Failed to load resource"))).toEqual([]);
});

test("a drawing on the board comes back after a reload, once", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  // The snapshot carries the reply's successful `board` calls as AG-UI tool calls
  // (lib/conversation-collapse.ts → toAguiChatMessages), and the browser rebuilds
  // the board from them exactly as it does live (docs/tutor-board.md). The
  // replayed in-process tool call must not show a second marker.
  const draw = {
    steps: [
      { op: "board", id: "stack", title: "Call stack", kind: "sequence" },
      { op: "box", id: "main", text: "main()" },
      { op: "box", id: "helper", text: "helper()" },
      { op: "arrow", id: "call", from: "main", to: "helper", text: "calls" },
    ],
  };
  const code = await mintTutorCode({ tutor: BOARD_TUTOR_URL });
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/${code}`);
  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();

  await page
    .getByTestId("copilot-chat-textarea")
    .fill(`[tool:board ${JSON.stringify(draw)}] RT-BOARD draw the call stack`);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("board-image")).toBeVisible({ timeout: 90_000 });
  await settle(page);
  await storedUserMessage(code, "RT-BOARD");
  await expect
    .poll(async () =>
      (await getStoredMessages(code)).some(
        (m) => m.role === "assistant" && m.content.includes('"toolName":"board"'),
      ),
    )
    .toBe(true);

  await reloadAndWaitForChat(page);
  const image = page.getByTestId("board-image");
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect(image).toHaveAttribute("alt", /Drawing "Call stack"\. Parts: main\(\), helper\(\)/);
  await expect(page.getByTestId("board-pill")).toHaveCount(1);
  await expect(page.getByTestId("copilot-user-message")).toHaveCount(1);
  await expect(page.getByText(/Fake LLM received the tool result/)).toHaveCount(1);

  // Continue the restored conversation: the browser now re-sends the restored
  // tool call and result with every run. A second drawing turn must store cleanly
  // and come back after another reload, each message once.
  const highlight = { steps: [{ op: "highlight", ids: ["call"] }] };
  await page
    .getByTestId("copilot-chat-textarea")
    .fill(`[tool:board ${JSON.stringify(highlight)}] RT-BOARD-2 highlight the call`);
  await page.getByTestId("copilot-send-button").click();
  await expect(page.getByTestId("board-status")).toHaveText("Highlighted 1 part", {
    timeout: 90_000,
  });
  await settle(page);
  await storedUserMessage(code, "RT-BOARD-2");
  await expect
    .poll(async () => {
      const rows = await getStoredMessages(code);
      return rows.filter((m) => m.role === "assistant" && m.content.includes("Fake LLM received"))
        .length;
    })
    .toBe(2);
  const rows = await getStoredMessages(code);
  expect(rows.filter((m) => m.role === "user")).toHaveLength(2);
  // Each board call is stored exactly once.
  const callIds = rows
    .flatMap((m) => [...m.content.matchAll(/"toolCallId":"([^"]+)","toolName":"board"/g)])
    .map((match) => match[1]);
  expect(callIds).toHaveLength(2);
  expect(new Set(callIds).size).toBe(2);
  // The board tool's own server-side read (lib/tutor-board-store.ts) finds both
  // calls — scoped by thread AND code, so another code sees nothing.
  const [thread] = await query<{ id: string }>(
    `SELECT id FROM mastra.mastra_threads WHERE "resourceId" = $1`,
    [code],
  );
  if (!thread) throw new Error(`no stored thread for ${code}`);
  expect((await loadThreadBoardCalls(code, thread.id)).map((c) => c.input)).toEqual([
    draw,
    highlight,
  ]);
  expect(await loadThreadBoardCalls("not-this-code", thread.id)).toEqual([]);

  await reloadAndWaitForChat(page);
  await expect(page.getByTestId("board-image")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("board-status")).toHaveText("Highlighted 1 part");
  await expect(page.getByTestId("board-pill")).toHaveText([
    /Drew on the board$/,
    /Changed the board$/,
  ]);
  await expect(page.getByTestId("copilot-user-message")).toHaveCount(2);
  await expect(page.getByText(/Fake LLM received the tool result/)).toHaveCount(2);

  expect(withoutNetworkNoise(errors)).toEqual([]);
});
