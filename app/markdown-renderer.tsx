"use client";

import ReactMarkdown, { type Components, type Options } from "react-markdown";
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
// the `content-none` modifiers drop the plugin's backticks around inline code;
// fenced code opts out entirely via `not-prose` (CodeBlock owns its chrome).
//
// `rehypePlugins` / `components` EXTEND the pipeline (appended after / merged over
// the defaults) for a surface that swaps marked text for widgets — the cloze
// runner's gap inputs (app/[code]/_cloze/cloze-text.tsx). Pass module-level
// constants: a new component function per render would remount every widget.
export function MarkdownRenderer({
  content,
  className,
  rehypePlugins,
  components,
}: {
  content: string;
  className?: string;
  rehypePlugins?: Options["rehypePlugins"];
  components?: Components;
}) {
  return (
    <div
      className={cn(
        "prose max-w-none prose-code:before:content-none prose-code:after:content-none",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, ...(rehypePlugins ?? [])]}
        components={{
          code: CodeBlock,
          // CodeBlock renders its own styled container, so drop react-markdown's
          // default <pre> wrapper (CopilotKit styles bare <pre> with a dark frame).
          pre: ({ children }) => <>{children}</>,
          ...components,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
