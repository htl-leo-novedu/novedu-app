import { asString, parseActivityYaml } from "./activity-load";
import type { LlmProvider, ReasoningLevel } from "./llm/provider";
import type { FragmentBlock } from "./prompt-fragments";
import { readFragmentBlock } from "./prompt-fragments/block";

// LENIENT runtime parse of a coding YAML — the path the OpenAI-compatible proxy
// uses to read the activity behind a (verified) code's file_url. Coding activities
// are stored in `novedu_files` under `kind: "coding"`. This is a small typed read
// of just the essentials the proxy needs (the teacher's system prompt + the pinned
// model), with a friendly message when something required is missing.
//
// This is NOT the authoring gate: the strict authoring validation for coding YAMLs
// lives in lib/coding-validate.ts (CodingYamlSchema) and is deliberately separate
// from this lenient read. A coding activity is ALWAYS anonymous (there are no
// in-app conversations to attribute), so there is no `anonymous` flag here.
//
// SERVER-SIDE: exposes the server-only `instructions` (the teacher's system prompt)
// and `model`. Neither must ever reach the browser — the student connection page
// needs only `title` (the proxy pins the model and ignores the client's).

/** A parsed coding activity. `instructions` and `model` are server-side only. */
export interface Coding {
  /**
   * The activity's own `id`. Never student-facing — it names the activity in teacher
   * tooling (the `@novedu/cli prompts` dump). Falls back to `"coding"` when this lenient
   * read finds none (the strict authoring schema requires one).
   */
  id: string;
  /** Student-facing display name. Optional — the surfaces fall back to a default. */
  title?: string;
  /** The model id that answers. SERVER-ONLY — the proxy pins it. */
  model: string;
  /** The LLM provider serving `model` (`llm.provider`, default SCCH). SERVER-ONLY. */
  provider: LlmProvider;
  /**
   * Optional reasoning effort for `model` (`llm.reasoning`). Absent ⇒ no
   * `reasoning_effort` is pinned and the client's own value passes through.
   * SERVER-ONLY.
   */
  reasoning?: ReasoningLevel;
  /**
   * The teacher's system prompt, prepended ahead of the client's. SERVER-ONLY.
   * `loadCoding` prepends the assembled document-level fragment block ahead of it;
   * `parseCoding` alone leaves it as authored.
   */
  instructions: string;
  /**
   * The unresolved document-level fragment block (server-only, transient). `parseCoding`
   * leaves it here for `loadCoding` to fetch + assemble and prepend to `instructions`;
   * `loadCoding` then clears it (`EMPTY_FRAGMENT_BLOCK`) so no stale block lingers on the
   * loaded activity. Never reaches the browser (only `title` is public).
   */
  fragmentBlock: FragmentBlock;
}

/** How this kind names itself in its student-facing load messages. */
export const CODING_NOUN = "coding activity";

export type CodingParseResult = { ok: true; coding: Coding } | { ok: false; message: string };

/**
 * Parses and lightly validates a coding YAML. Returns a friendly error message
 * (not structured errors) when an essential field is missing — the proxy and the
 * student page surface it as a notice.
 */
export function parseCoding(content: string): CodingParseResult {
  const parsed = parseActivityYaml(content, CODING_NOUN);
  if (!parsed.ok) return parsed;
  const { root, llm } = parsed;

  const instructions = asString(root.instructions);
  if (!instructions) {
    return { ok: false, message: "This coding activity has no instructions for the assistant." };
  }

  return {
    ok: true,
    coding: {
      id: asString(root.id) ?? "coding",
      title: asString(root.title),
      ...llm,
      instructions,
      // Carried through for `loadCoding` to resolve + prepend to `instructions`.
      fragmentBlock: readFragmentBlock(root),
    },
  };
}
