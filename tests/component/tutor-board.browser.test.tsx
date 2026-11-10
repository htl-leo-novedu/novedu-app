import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@/app/globals.css";

// The tutor's board pane (docs/tutor-board.md) in a real browser with the real
// Excalidraw renderer. CopilotKit is stubbed: `useAgent` hands out the message
// list the test sets, `useRenderTool` captures the chat-marker renderer so the
// stub chat can render it the way CopilotChat would. The live chat is covered by
// e2e/tutor-board.spec.ts.

type RenderFn = (props: { toolCallId: string; status: string }) => ReactElement | null;
const ck = vi.hoisted(() => ({
  messages: [] as unknown[],
  render: null as RenderFn | null,
  failRender: false,
}));

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent: { messages: ck.messages }, isReady: true }),
  useRenderTool: (config: { render: RenderFn }) => {
    ck.render = config.render;
  },
}));

// The real renderer, unless a test makes it fail.
vi.mock("@/app/_tutor/board/render", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_tutor/board/render")>();
  return {
    ...real,
    renderBoard: (...args: Parameters<typeof real.renderBoard>) =>
      ck.failRender ? Promise.reject(new Error("render failed")) : real.renderBoard(...args),
  };
});

import { BoardFrame } from "@/app/_tutor/board/board-frame";
import { renderBoard } from "@/app/_tutor/board/render";
import { apply, emptyBoard, MARK } from "@/lib/board";

const DRAW = {
  steps: [
    { op: "board", id: "flow", title: "Request flow" },
    { op: "box", id: "browser", text: "Browser", row: 0, col: 0, color: "blue" },
    { op: "box", id: "server", text: "Server", row: 0, col: 1 },
    { op: "arrow", from: "browser", to: "server", text: "GET /" },
  ],
};
const HIGHLIGHT = { steps: [{ op: "highlight", ids: ["server"] }] };

/** One assistant reply that called the board, and its result. */
function reply(id: string, input: unknown, ok = true) {
  return [
    {
      id: `m-${id}`,
      role: "assistant",
      toolCalls: [
        { id, type: "function", function: { name: "board", arguments: JSON.stringify(input) } },
      ],
    },
    {
      id: `r-${id}`,
      role: "tool",
      toolCallId: id,
      content: JSON.stringify(ok ? { ok: true, board: "…" } : { ok: false, errors: ["x"] }),
    },
  ];
}

/** The chat stand-in: renders the marker for each board call, as CopilotChat would. */
function StubChat({ ids }: { ids: string[] }) {
  return (
    <div data-testid="chat">
      <p>The chat</p>
      {ids.map((id) => (
        <div key={id}>{ck.render?.({ toolCallId: id, status: "complete" })}</div>
      ))}
    </div>
  );
}

function frame(ids: string[]) {
  return (
    <div style={{ height: 700, display: "flex", flexDirection: "column" }}>
      <BoardFrame>
        <StubChat ids={ids} />
      </BoardFrame>
    </div>
  );
}

afterEach(async () => {
  ck.messages = [];
  ck.failRender = false;
  await page.viewport(1280, 800);
});

describe("laptop", () => {
  test("without a board the chat renders alone", async () => {
    const screen = await render(frame([]));
    await expect.element(screen.getByTestId("chat")).toBeVisible();
    expect(screen.container.querySelector('[data-testid="board-pane"]')).toBeNull();
  });

  test("the first drawing opens the pane beside the chat; a change updates it in place", async () => {
    ck.messages = reply("t1", DRAW);
    const screen = await render(frame(["t1"]));
    const image = screen.getByTestId("board-image");
    await expect.element(image).toBeVisible();
    await expect.element(screen.getByTestId("board-status")).toHaveTextContent("Drawn just now");
    await expect
      .element(image)
      .toHaveAttribute("alt", expect.stringContaining('Drawing "Request flow"'));
    await expect.element(screen.getByTestId("board-pill")).toHaveTextContent("Drew on the board");

    ck.messages = [
      ...reply("t1", DRAW),
      ...reply("t2", { steps: [{ op: "nope" }] }, false),
      ...reply("t3", HIGHLIGHT),
    ];
    await screen.rerender(frame(["t1", "t2", "t3"]));
    await expect
      .element(screen.getByTestId("board-status"))
      .toHaveTextContent("Highlighted 1 part");
    // the rejected call shows no marker
    expect(screen.container.querySelectorAll('[data-testid="board-pill"]')).toHaveLength(2);
    await expect
      .element(screen.getByTestId("board-announcement"))
      .toHaveTextContent("Board updated: Highlighted 1 part");
  });

  test("collapses to the rail and reopens from the chat marker", async () => {
    ck.messages = reply("t1", DRAW);
    const screen = await render(frame(["t1"]));
    await screen.getByTestId("board-collapse").click();
    await expect.element(screen.getByTestId("board-rail")).toBeVisible();
    ck.messages = [...reply("t1", DRAW), ...reply("t2", HIGHLIGHT)];
    await screen.rerender(frame(["t1", "t2"]));
    await expect.element(screen.getByTestId("board-unseen")).toBeVisible();
    await screen.getByTestId("board-pill").last().click();
    await expect.element(screen.getByTestId("board-pane")).toBeVisible();
  });

  test("a failed render keeps the last good image", async () => {
    ck.messages = reply("t1", DRAW);
    const screen = await render(frame(["t1"]));
    const image = screen.getByTestId("board-image");
    await expect.element(image).toBeVisible();
    const src = image.element().getAttribute("src");

    ck.failRender = true;
    ck.messages = [...reply("t1", DRAW), ...reply("t2", HIGHLIGHT)];
    await screen.rerender(frame(["t1", "t2"]));
    await expect
      .element(screen.getByTestId("board-status"))
      .toHaveTextContent("Highlighted 1 part");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.container.querySelectorAll('[data-testid="board-image"]')).toHaveLength(1);
    expect(screen.getByTestId("board-image").element().getAttribute("src")).toBe(src);
  });
});

describe("phone", () => {
  test("docks above the chat as a sheet: half, collapse to peek, full and back", async () => {
    await page.viewport(390, 760);
    ck.messages = [...reply("t1", DRAW), ...reply("t2", HIGHLIGHT)];
    const screen = await render(frame(["t1", "t2"]));
    const sheet = screen.getByTestId("board-sheet");
    await expect.element(sheet).toHaveAttribute("data-state", "half");
    await expect.element(screen.getByTestId("board-image")).toBeVisible();
    await expect.element(screen.getByTestId("board-zoom-toggle")).toHaveTextContent("Whole board");
    // the sheet sits above the chat
    const sheetBox = sheet.element().getBoundingClientRect();
    const chatBox = screen.getByTestId("chat").element().getBoundingClientRect();
    expect(sheetBox.bottom).toBeLessThanOrEqual(chatBox.top + 1);

    await screen.getByTestId("board-collapse").click();
    await expect.element(sheet).toHaveAttribute("data-state", "peek");
    await screen.getByTestId("board-show").click();
    await expect.element(sheet).toHaveAttribute("data-state", "half");
    await screen.getByTestId("board-full").click();
    await expect.element(sheet).toHaveAttribute("data-state", "full");
    await screen.getByTestId("board-close").click();
    await expect.element(sheet).toHaveAttribute("data-state", "half");
  });
});

describe("rendering", () => {
  test("the highlighted part's bounds land on its marker pixels in the PNG", async () => {
    const state = [DRAW, HIGHLIGHT].reduce((s, call) => apply(s, call).state ?? s, emptyBoard());
    const out = await renderBoard(state, 2);
    expect(out.focus).not.toBeNull();
    const bitmap = await createImageBitmap(out.blob);
    // The image is the drawing at scale 2.
    expect(bitmap.width / out.width).toBeCloseTo(2, 1);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / out.width;
    const pixel = (x: number, y: number) => {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return `#${[d[0], d[1], d[2]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
    };
    const f = out.focus as NonNullable<typeof out.focus>;
    // Inside the highlighted box, away from its centred label and rough outline: the marker fill.
    expect(pixel(f.x + f.w * 0.12, f.y + f.h * 0.25)).toBe(MARK);
    expect(pixel(f.x + f.w * 0.88, f.y + f.h * 0.75)).toBe(MARK);
    // Just outside it: the white sheet.
    expect(pixel(f.x + f.w + 12, f.y + f.h / 2)).toBe("#ffffff");
  });
});
