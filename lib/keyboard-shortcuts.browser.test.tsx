import { useState } from "react";
import { expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { onModEnter, useSaveShortcut } from "@/lib/keyboard-shortcuts";

// The DOM wiring of lib/keyboard-shortcuts.ts in a real browser: Ctrl+Enter on
// a textarea submits without inserting a newline (plain Enter still inserts
// one), and Ctrl+S reaches the page-level save listener from inside a focused
// field, suppresses the browser's own handling, and calls the LATEST callback.
// The predicates themselves live in keyboard-shortcuts.unit.test.ts.

function SubmitHarness({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <textarea
      aria-label="answer"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onModEnter(() => onSubmit(value))}
    />
  );
}

test("Ctrl+Enter submits the current text and adds no newline", async () => {
  const onSubmit = vi.fn();
  const screen = await render(<SubmitHarness onSubmit={onSubmit} />);
  const box = screen.getByRole("textbox", { name: "answer" });
  await userEvent.click(box);
  await userEvent.keyboard("hello");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("hello");
  await expect.element(box).toHaveValue("hello");
});

test("plain Enter inserts a newline and does not submit", async () => {
  const onSubmit = vi.fn();
  const screen = await render(<SubmitHarness onSubmit={onSubmit} />);
  const box = screen.getByRole("textbox", { name: "answer" });
  await userEvent.click(box);
  await userEvent.keyboard("a{Enter}b");

  await expect.element(box).toHaveValue("a\nb");
  expect(onSubmit).not.toHaveBeenCalled();
});

function SaveHarness({ onSave, enabled }: { onSave: (n: number) => void; enabled?: boolean }) {
  const [n, setN] = useState(0);
  useSaveShortcut(() => onSave(n), enabled);
  return (
    <>
      <input aria-label="field" />
      <button type="button" onClick={() => setN((x) => x + 1)}>
        bump
      </button>
    </>
  );
}

/** Records whether the last Ctrl+S that reached `window` was default-prevented.
 * Registered after the hook's listener, so it observes the final state. */
function watchDefaultPrevented() {
  const seen: boolean[] = [];
  const listener = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === "s") seen.push(e.defaultPrevented);
  };
  window.addEventListener("keydown", listener);
  return { seen, stop: () => window.removeEventListener("keydown", listener) };
}

test("Ctrl+S from a focused field prevents the default and calls the latest callback", async () => {
  const onSave = vi.fn();
  const screen = await render(<SaveHarness onSave={onSave} />);
  const watch = watchDefaultPrevented();
  try {
    await screen.getByRole("button", { name: "bump" }).click();
    await screen.getByRole("button", { name: "bump" }).click();
    await userEvent.click(screen.getByRole("textbox", { name: "field" }));
    await userEvent.keyboard("{Control>}s{/Control}");

    expect(onSave).toHaveBeenCalledExactlyOnceWith(2);
    expect(watch.seen).toEqual([true]);
  } finally {
    watch.stop();
  }
});

test("enabled=false leaves Ctrl+S untouched", async () => {
  const onSave = vi.fn();
  await render(<SaveHarness onSave={onSave} enabled={false} />);
  const watch = watchDefaultPrevented();
  try {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }),
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(watch.seen).toEqual([false]);
  } finally {
    watch.stop();
  }
});

test("unmounting removes the listener", async () => {
  const onSave = vi.fn();
  const screen = await render(<SaveHarness onSave={onSave} />);
  await screen.unmount();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true }));
  expect(onSave).not.toHaveBeenCalled();
});
