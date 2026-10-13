import { expect, test } from "@playwright/test";
import { getStoredMessages, LIVE_TUTOR_URL, mintTutorCode } from "./code.utils";

// REGRESSION GUARD for the "replayed history" persistence bug (issue #28).
//
// CopilotKit/AG-UI re-sends the ENTIRE conversation on every run. The route
// forwards it untouched and relies on `@ag-ui/mastra` dropping the messages the
// thread's memory already holds (by id); if that ever stops working, Mastra
// re-persists the whole history each turn and a k-turn chat balloons to
// k·(k+1) rows — the early turns stored over and over. This is the ONE thing a
// unit test can't prove: it needs the real chat → real Mastra → real database
// round-trip, asserting Mastra STORES only the new turn. The replies come from the fake LLM (docs/testing.md, "Fake LLM")
// — their content is irrelevant here.
//
// @live-db: it reads the stored messages through e2e/db.ts — runs in CI.
//
// The check: after two turns, the FIRST user message must be stored exactly
// once (telescoping would store it twice — once for its own turn, once replayed
// inside turn two) and there must be exactly two user messages total.
//
// CopilotKit v2 testids (see tutor-chat-reply.spec.ts): composer
// `copilot-chat-textarea`, send `copilot-send-button`, assistant bubbles
// `copilot-assistant-message`.

// Distinctive markers so the stored USER rows are unambiguous to count. The
// query is already scoped to this run's freshly minted code, so they only need
// to be recognizable, not globally unique. The tutor may quote them back, but
// that lands in an ASSISTANT row, which the user-message filter ignores.
const Q1 = "QONE-please-name-one-linked-list-operation";
const Q2 = "QTWO-please-name-another-linked-list-operation";

// Two full chat round-trips plus the Next compile — give it room.
test.setTimeout(180_000);

// Send one turn and wait for the run to FULLY finish before returning. Waiting
// only for a non-empty reply is not enough: the composer accepts the next turn
// while streaming, but a send issued mid-stream is dropped — so we wait for the
// chat root to drop `data-copilot-running` (set while streaming).
async function sendTurnAndSettle(
  page: import("@playwright/test").Page,
  text: string,
  expectedAssistantCount: number,
) {
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

  // Run finished → the streaming flag is gone (attribute removed or "false").
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

test("a two-turn chat stores each turn once (no replayed-history duplicates)", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  const code = await mintTutorCode({ tutor: LIVE_TUTOR_URL });
  await page.goto(`/${code}`);

  await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();

  // Two distinct turns, each fully settled before the next is sent.
  await sendTurnAndSettle(page, Q1, 1);
  await sendTurnAndSettle(page, Q2, 2);

  // Wait until the second turn has landed in storage (persistence is part of
  // the run, but settle for any async tail before asserting).
  await expect
    .poll(async () =>
      (await getStoredMessages(code)).some((m) => m.role === "user" && m.content.includes(Q2)),
    )
    .toBe(true);

  const stored = await getStoredMessages(code);
  const userMessages = stored.filter((m) => m.role === "user");

  // The regression signal: telescoping re-stores turn 1 inside turn 2, so the
  // first user message would appear twice. It must appear exactly once.
  expect(userMessages.filter((m) => m.content.includes(Q1))).toHaveLength(1);
  expect(userMessages.filter((m) => m.content.includes(Q2))).toHaveLength(1);
  // And no other user rows snuck in — exactly the two turns we sent.
  expect(userMessages).toHaveLength(2);
});
