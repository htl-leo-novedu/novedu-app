"use client";

import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { type ChangeEvent, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useIsDark } from "@/lib/use-is-dark";
import { cn } from "@/lib/utils";

// CodeMirror 6 editor (via @uiw/react-codemirror), shared by the `/files` create
// and edit forms and the writing student surface. Controlled: the parent owns the
// text. The language extension adds syntax highlighting — `yaml()` for hosted YAML
// files (the default) or `markdown()` for writing. The `/files` forms also show an
// Upload button that loads a local file's text into the editor; writing turns it
// off with `upload={false}` (a student writes prose in place, not by uploading).
//
// A "use client" component — CodeMirror touches the DOM and is created in an
// effect by the wrapper, so it hydrates fine without a dynamic import.

// Stable per-language extension references (created once) so CodeMirror doesn't
// reconfigure on every render; the editor picks one by the `language` prop.
// Markdown is prose, so it WRAPS long lines (`EditorView.lineWrapping` →
// `white-space: pre-wrap`) instead of scrolling horizontally; YAML keeps the
// default no-wrap so its indentation structure stays aligned.
const YAML_EXTENSIONS = [yaml()];
const MARKDOWN_EXTENSIONS = [markdown(), EditorView.lineWrapping];
// In dark mode CodeMirror's built-in dark theme brings its own bluish surface;
// this lets the wrapper's `bg-background` show instead, as in light mode.
const DARK_SURFACE = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "transparent" },
});

export function YamlEditor({
  value,
  onChange,
  disabled,
  language = "yaml",
  upload = true,
  fill = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  language?: "yaml" | "markdown";
  /** Show the "Upload file…" button (load a local file into the editor). The
   * `/files` forms keep it (default); the writing surface passes `false`. */
  upload?: boolean;
  /** Fill the parent's height instead of the default fixed `420px`. The writing
   * surface passes `true` inside a viewport-bounded column, so the editor spans
   * the split-screen height and scrolls internally; the `/files` forms pass it
   * inside PageBody's `min-h-full` column, so the editor starts viewport-high
   * and then GROWS with its content (the page scrolls, not the editor). */
  fill?: boolean;
}) {
  const dark = useIsDark();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extensions = useMemo(() => {
    const base = language === "markdown" ? MARKDOWN_EXTENSIONS : YAML_EXTENSIONS;
    return dark ? [...base, DARK_SURFACE] : base;
  }, [language, dark]);

  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input so picking the SAME file again still fires `change`.
    event.target.value = "";
    if (!file) return;
    onChange(await file.text());
  }

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      {upload ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            Upload file…
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".yaml,.yml,.txt,text/yaml,application/yaml,text/plain"
            className="hidden"
            onChange={onUpload}
          />
          <span className="text-foreground/55 text-xs">
            Uploading replaces the editor contents.
          </span>
        </div>
      ) : null}
      {/* Fill mode: each level — wrap, box, the CodeMirror root, and the editor —
          must fill so the `height: 100%` on `.cm-editor` resolves to the available
          column height; the `.cm-scroller` inside then scrolls. The parent
          establishes the height this chain fills. */}
      <div
        className={cn(
          // Explicit bg: CodeMirror itself is transparent, and on PageBody's
          // gray canvas the editor must read as a white input surface.
          "overflow-hidden rounded-lg border border-foreground/25 bg-background",
          fill && "flex min-h-0 flex-1 flex-col *:min-h-0 *:flex-1 [&_.cm-editor]:h-full",
        )}
      >
        <CodeMirror
          value={value}
          height={fill ? "100%" : "420px"}
          extensions={extensions}
          editable={!disabled}
          onChange={onChange}
          theme={dark ? "dark" : "light"}
        />
      </div>
    </div>
  );
}
