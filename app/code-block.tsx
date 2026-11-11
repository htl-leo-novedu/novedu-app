"use client";

import type { ComponentProps } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useCopyToClipboard } from "@/components/use-copy-to-clipboard";
import { useIsDark } from "@/lib/use-is-dark";
import { cn } from "@/lib/utils";

// Renders a fenced code block: a header (language label + copy button) above a
// syntax-highlighted body with soft-wrapped long lines, plus line numbers for
// multi-line snippets. Inline code (no language fence) falls through to a plain
// <code>.
//
// The Prism theme follows the app's colour theme (oneLight / oneDark, via
// `useIsDark`); the surrounding chrome pairs fixed grays with `dark:` partners.
export function CodeBlock({
  className,
  children,
  // `node` is react-markdown's hast node; drop it so it doesn't leak onto the DOM.
  node: _node,
  ...rest
}: ComponentProps<"code"> & { node?: unknown }) {
  const dark = useIsDark();
  const match = /language-(\w+)/.exec(className ?? "");
  const text = String(children).replace(/\n$/, "");

  // No language class → inline code (or a fence without a language). Render plainly.
  if (!match) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  const language = match[1];
  const multiline = text.includes("\n");

  return (
    // `not-prose` exempts the block from the surrounding markdown `prose` styles —
    // Prism + this chrome own everything inside.
    <div className="not-prose my-3 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-foreground/15 dark:bg-foreground/[0.03]">
      <div className="flex items-center justify-between border-gray-200 border-b bg-gray-100 py-1.5 pr-2 pl-3 dark:border-foreground/15 dark:bg-foreground/5">
        <span className="font-mono font-semibold text-gray-600 text-xs tracking-wide dark:text-foreground/60">
          {language}
        </span>
        <CopyButton text={text} />
      </div>
      <SyntaxHighlighter
        language={language}
        style={dark ? oneDark : oneLight}
        showLineNumbers={multiline}
        wrapLongLines
        PreTag="div"
        // Let the wrapping .block own the background, border, and rounding.
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "0.75rem",
          fontSize: "0.85rem",
        }}
        lineNumberStyle={{ color: dark ? "#5c6370" : "#afb8c1", minWidth: "2.2em" }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  // Clipboard may be unavailable (e.g. an insecure context) — copy() ignores it.
  const { copied, copy } = useCopyToClipboard({ resetMs: 1500 });

  return (
    <button
      type="button"
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-0.5 font-semibold text-gray-600 text-xs transition-colors hover:bg-gray-100 hover:text-gray-900 dark:border-foreground/25 dark:bg-background dark:text-foreground/60 dark:hover:bg-foreground/5 dark:hover:text-foreground",
        copied && "border-success text-success",
      )}
      onClick={() => copy(text)}
      aria-label="Copy code to clipboard"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
