"use client";

import type { Element, ElementContent, Root, RootContent } from "hast";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { Components } from "react-markdown";
import { MarkdownRenderer } from "@/app/markdown-renderer";
import { splitOnClozeGaps } from "@/lib/cloze-types";

// The cloze text: the public Markdown (`ClozePublic.text`) through the sanitized
// MarkdownRenderer, with every gap placeholder swapped for a widget — an input while
// answering, a verdict chip on the results screen. A small rehype plugin splits the
// rendered text nodes on the placeholders (`splitOnClozeGaps`) and leaves a
// `<cloze-gap data-gap="N">` element in each one's place; that element renders
// through ONE stable component that asks the caller's `renderGap` (via context) what
// to show. Stable on purpose: a new component per render would remount every input
// on each keystroke and lose the focus. The parsed Markdown is memoized on the text,
// so typing re-renders only the gaps.

const GAP_TAG = "cloze-gap";

// Code never holds a gap (the validator rejects one there); its text stays verbatim.
const SKIP = new Set(["code", "pre"]);

function splitTextNodes(parent: Root | Element): void {
  const children: (RootContent | ElementContent)[] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      for (const part of splitOnClozeGaps(child.value)) {
        children.push(
          typeof part === "string"
            ? { type: "text", value: part }
            : { type: "element", tagName: GAP_TAG, properties: { dataGap: part }, children: [] },
        );
      }
    } else {
      if (child.type === "element" && !SKIP.has(child.tagName)) splitTextNodes(child);
      children.push(child);
    }
  }
  parent.children = children as typeof parent.children;
}

function rehypeClozeGaps() {
  return (tree: Root) => splitTextNodes(tree);
}

const GapRenderer = createContext<(gap: number) => ReactNode>(() => null);

function GapSlot(props: { "data-gap"?: string | number }) {
  const renderGap = useContext(GapRenderer);
  return <>{renderGap(Number(props["data-gap"]))}</>;
}

const REHYPE_PLUGINS = [rehypeClozeGaps];
// react-markdown types `components` by intrinsic tag names; the custom gap element
// is resolved by name at runtime all the same.
const COMPONENTS = { [GAP_TAG]: GapSlot } as Components;

export function ClozeText({
  text,
  renderGap,
}: {
  text: string;
  renderGap: (gap: number) => ReactNode;
}) {
  const markdown = useMemo(
    () => (
      <MarkdownRenderer
        content={text}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
        className="prose-li:leading-10 prose-p:leading-10"
      />
    ),
    [text],
  );
  return <GapRenderer.Provider value={renderGap}>{markdown}</GapRenderer.Provider>;
}
