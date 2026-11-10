import { expect, type Page, test } from "@playwright/test";
import { BOARD_TUTOR_URL, mintTutorCode } from "./code.utils";
import { watchErrors, withoutNetworkNoise } from "./page.utils";

// The tutor board end to end (docs/tutor-board.md): a tutor granted `tools:
// [board]` draws through the fake LLM's `[tool:board {…}]` marker (docs/testing.md,
// "Fake LLM"), the real `board` executor applies the call on the server, and the
// browser derives the board from the chat's message list, renders it with
// Excalidraw and shows it beside the chat (laptop) or docked above it (phone).
// @live-db: mints the code through e2e/db.ts — runs in CI against the fake LLM.

test.setTimeout(180_000);

const DRAW = {
  steps: [
    { op: "board", id: "dhcp", title: "DHCP: DORA", kind: "sequence" },
    { op: "box", id: "laptop", text: "Laptop", color: "blue" },
    { op: "box", id: "server", text: "DHCP server", color: "yellow" },
    { op: "arrow", id: "discover", from: "laptop", to: "server", text: "1 Discover" },
    { op: "arrow", id: "offer", from: "server", to: "laptop", text: "2 Offer" },
  ],
};
const HIGHLIGHT = { steps: [{ op: "highlight", ids: ["offer"] }] };
const EXTEND = {
  steps: [{ op: "arrow", id: "request", from: "laptop", to: "server", text: "3 Request" }],
};
// Reuses an id: the board rejects it, nothing changes, no marker appears.
const REJECTED = { steps: [{ op: "box", id: "laptop", text: "Again" }] };

const say = (call: unknown, text: string) => `[tool:board ${JSON.stringify(call)}] ${text}`;

/** Sends turn number `turn` (1-based) and waits until its reply has finished. */
async function send(page: Page, text: string, turn: number) {
  await page.getByTestId("copilot-chat-textarea").fill(text);
  await page.getByTestId("copilot-send-button").click();
  await expect
    .poll(
      async () =>
        (await page.getByTestId("copilot-chat").getAttribute("data-copilot-running")) !== "true",
      { timeout: 90_000 },
    )
    .toBe(true);
  // This turn's own echo, not the previous turn's: every turn adds one.
  await expect(page.getByText(/Fake LLM received the tool result/)).toHaveCount(turn, {
    timeout: 90_000,
  });
}

test.describe("laptop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("draws beside the chat, changes in place, and never shows a board error", {
    tag: ["@live", "@live-db"],
  }, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(`/${await mintTutorCode({ tutor: BOARD_TUTOR_URL })}`);
    await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();
    // No board before the first drawing: the chat looks as always.
    await expect(page.getByTestId("board-pane")).toHaveCount(0);

    await send(page, say(DRAW, "How does my laptop get its IP?"), 1);
    const pane = page.getByTestId("board-pane");
    await expect(pane).toBeVisible();
    const image = pane.getByTestId("board-image");
    await expect(image).toBeVisible({ timeout: 60_000 });
    await expect(image).toHaveAttribute("alt", /Drawing "DHCP: DORA"\. Parts: Laptop, DHCP server/);
    await expect(page.getByTestId("board-status")).toHaveText("Drawn just now");
    await expect(page.getByTestId("board-pill")).toHaveText([/Drew on the board$/]);

    await send(page, say(HIGHLIGHT, "Highlight the offer"), 2);
    await expect(page.getByTestId("board-status")).toHaveText("Highlighted 1 part");
    await expect(image).toHaveAttribute("alt", /Highlighted: 2 Offer\./);
    await expect(page.getByTestId("board-pill")).toHaveText([
      /Drew on the board$/,
      /Changed the board$/,
    ]);
    // Still ONE board pane: the drawing changed in place.
    await expect(page.getByTestId("board-pane")).toHaveCount(1);

    // A rejected call changes nothing and shows no marker.
    await send(page, say(REJECTED, "Draw the laptop again"), 3);
    await expect(page.getByTestId("board-pill")).toHaveCount(2);
    await expect(page.getByTestId("board-status")).toHaveText("Highlighted 1 part");

    // Collapsed: the rail; a change while collapsed sets the dot; the pill reopens it.
    await page.getByTestId("board-collapse").click();
    await expect(page.getByTestId("board-rail")).toBeVisible();
    await send(page, say(EXTEND, "And then?"), 4);
    await expect(page.getByTestId("board-unseen")).toBeVisible();
    await page.getByTestId("board-pill").last().click();
    await expect(page.getByTestId("board-pane")).toBeVisible();
    await expect(page.getByTestId("board-status")).toHaveText("Added 1 part");

    // Start over: a fresh thread, so an empty board and no pane.
    await page.getByRole("button", { name: "Start over" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start over" }).click();
    await expect(page.getByTestId("board-pane")).toHaveCount(0);
    await expect(page.getByTestId("board-pill")).toHaveCount(0);

    expect(withoutNetworkNoise(errors)).toEqual([]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("docks above the chat, zooms to the highlight, and respects a collapse", {
    tag: ["@live", "@live-db"],
  }, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(`/${await mintTutorCode({ tutor: BOARD_TUTOR_URL })}`);
    await expect(page.getByTestId("copilot-chat-textarea")).toBeVisible();

    await send(page, say(DRAW, "How does my laptop get its IP?"), 1);
    const sheet = page.getByTestId("board-sheet");
    await expect(sheet).toHaveAttribute("data-state", "half");
    await expect(sheet.getByTestId("board-image")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("board-zoom-toggle")).toHaveCount(0);

    // Tapping into the message field tucks the board; sending brings it back.
    await page.getByTestId("copilot-chat-textarea").tap();
    await expect(sheet).toHaveAttribute("data-state", "peek");
    await send(page, say(HIGHLIGHT, "Highlight the offer"), 2);
    await expect(sheet).toHaveAttribute("data-state", "half");
    const toggle = page.getByTestId("board-zoom-toggle");
    await expect(toggle).toHaveText("Whole board");
    await toggle.click();
    await expect(toggle).toHaveText("Zoom to highlight");

    // Full screen and back.
    await page.getByTestId("board-full").click();
    await expect(sheet).toHaveAttribute("data-state", "full");
    await page.getByTestId("board-close").click();
    await expect(sheet).toHaveAttribute("data-state", "half");

    // The student's collapse wins: a later change keeps it at peek, with the dot.
    await page.getByTestId("board-collapse").click();
    await expect(sheet).toHaveAttribute("data-state", "peek");
    await send(page, say(EXTEND, "And then?"), 3);
    await expect(sheet).toHaveAttribute("data-state", "peek");
    await expect(page.getByTestId("board-unseen")).toBeVisible();
    await page.getByTestId("board-show").click();
    await expect(sheet).toHaveAttribute("data-state", "half");

    expect(withoutNetworkNoise(errors)).toEqual([]);
  });
});
