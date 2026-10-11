// CLIENT-SAFE module metadata for the generic "codes" subsystem. PURE — no I/O,
// no server-only imports — so client components (the /codes list badge + module
// filter select, the count-column header) and the server registry can both name
// modules without pulling in agents, the database, or the validators.
//
// A `CodeModule` is a shareable activity reachable at `/<code>`. It is a SUBSET
// of `FileKind` (lib/file-name.ts): `fragment` is a file kind with a validator
// and NO module; every other kind is added here together with its descriptor
// (lib/code-modules/registry.ts) and its own student code.

/** The shareable-activity modules a code can dispatch to. */
export const CODE_MODULES = ["tutor", "quiz", "writing", "coding", "cloze"] as const;

export type CodeModule = (typeof CODE_MODULES)[number];

export function isCodeModule(value: unknown): value is CodeModule {
  return typeof value === "string" && (CODE_MODULES as readonly string[]).includes(value);
}

/**
 * Narrows a URL search-param value (Next gives `string | string[] | undefined`)
 * to a `CodeModule`, or `undefined` when it is absent/unrecognized. Shared by the
 * /codes list (module filter) and /codes/new (module pre-fill) so the parse lives
 * in one place.
 */
export function parseModuleParam(value: string | string[] | undefined): CodeModule | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return isCodeModule(first) ? first : undefined;
}

/** Display strings for a module, used by the teacher list (badge + count column). */
export interface CodeModuleLabels {
  /** Short badge text in the list's Module column. */
  badge: string;
  /** Header of the per-code count column (tutor chats, quiz discussions, cloze submissions). */
  countColumn: string;
  /**
   * Badge tone of the module's identity pill — the module's color everywhere it
   * appears (the /codes Module column + row accent, the /files kind column).
   * A subset of the Badge tone palette (components/ui/badge.tsx), spelled as
   * literals so this module stays free of component imports.
   */
  tone: "teal" | "orange" | "green" | "blue" | "rose";
}

export const codeModuleLabels: Record<CodeModule, CodeModuleLabels> = {
  tutor: { badge: "Tutor", countColumn: "Conversations", tone: "teal" },
  quiz: { badge: "Quiz", countColumn: "Discussions", tone: "orange" },
  writing: { badge: "Writing", countColumn: "Conversations", tone: "green" },
  // Coding has no in-app conversations and renders its own detail (not
  // ConversationStats), so `countColumn` is never displayed for it.
  coding: { badge: "Coding", countColumn: "—", tone: "blue" },
  // Cloze has no conversations either: its count is first submissions.
  cloze: { badge: "Cloze", countColumn: "Submissions", tone: "rose" },
};
