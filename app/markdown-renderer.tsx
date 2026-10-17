"use client";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";

// Drop-in replacement for CopilotKit v2's default Streamdown markdown renderer.
//
// Streamdown defaults to `singleDollarTextMath: false` (so inline `$...$` is not
// treated as math) AND runs rehype-sanitize, which strips KaTeX's class names and
// breaks the rendered output. CopilotKit doesn't expose Streamdown's plugin config,
// so we swap the whole renderer via the `markdownRenderer` slot.
//
// This pipeline enables inline + block math (no `singleDollarTextMath: false`), runs
// rehype-katex with no sanitize step (KaTeX classes survive), and renders fenced
// code through ./code-block. Dropping rehype-sanitize is safe here: react-markdown
// does not parse raw HTML and allowlists URL schemes.
// The `prose` wrapper (@tailwindcss/typography) owns the markdown text styling:
// Tailwind's preflight strips the UA heading/list/paragraph defaults, so prose
// puts real ones back. Colors are re-mapped to the app foreground in globals.css;
// the `content-none` modifiers drop the plugin's backticks around inline code —
// `!important`, because CopilotKit's chat wraps every message in its own
// `cpk:prose`, whose backtick rule sits in the same `utilities` layer with the
// same specificity and loads later (tests/component/markdown-renderer.browser.test.tsx);
// fenced code opts out entirely via `not-prose` (CodeBlock owns its chrome).
export function MarkdownRenderer({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose max-w-none prose-code:before:content-none! prose-code:after:content-none!",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code: CodeBlock,
          // CodeBlock renders its own styled container, so drop react-markdown's
          // default <pre> wrapper (CopilotKit styles bare <pre> with a dark frame).
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
