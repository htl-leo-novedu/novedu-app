import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
// The stylesheets in the app's order: the root layout loads KaTeX and globals,
// the chat loads CopilotKit's after them (app/module-chat.tsx).
import "katex/dist/katex.min.css";
import "@/app/globals.css";
import "@copilotkit/react-core/v2/styles.css";
import { MarkdownRenderer } from "@/app/markdown-renderer";

// A chat reply as the student sees it: CopilotKit wraps every message in its own
// `cpk:prose`, whose rule puts backticks around inline code and loads after ours.
// Pins that inline code shows no backticks there, and that math and fenced code
// still render as KaTeX and as the code block.

const REPLY = [
  "Schauen wir auf `[5, 2, 4, 1]`.",
  "",
  "Inline $a^2 + b^2 = c^2$ und als Block:",
  "",
  "$$",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "$$",
  "",
  "```ts",
  "const a = [5, 2];",
  "```",
].join("\n");

test("a chat reply shows inline code without backticks, math and a code block", async () => {
  const screen = await render(
    <div className="cpk:prose">
      <MarkdownRenderer content={REPLY} />
    </div>,
  );

  const inline = screen.container.querySelector("p code");
  if (!inline) throw new Error("no inline code rendered");
  expect(getComputedStyle(inline, "::before").content).toBe("none");
  expect(getComputedStyle(inline, "::after").content).toBe("none");

  // Inline math in the text, block math in display mode.
  expect(screen.container.querySelector("p .katex")).not.toBeNull();
  expect(screen.container.querySelector(".katex-display")).not.toBeNull();

  // The fenced block goes through CodeBlock: language header + copy button.
  await expect.element(screen.getByText("ts", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /copy/i })).toBeVisible();
});
