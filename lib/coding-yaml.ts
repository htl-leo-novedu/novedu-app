import { parse as parseYamlText } from "yaml";
import {
  DEFAULT_PROVIDER,
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
  REASONING_LEVELS,
  type ReasoningLevel,
} from "./llm/provider";
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

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() !== "" ? value : undefined;
  // YAML types unquoted scalars by value, so `title: 1` arrives as a number. Coerce a
  // finite number / boolean to its string form rather than silently dropping it.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Parses and lightly validates a coding YAML. Returns a friendly error message
 * (not structured errors) when an essential field is missing — the proxy and the
 * student page surface it as a notice.
 */
export function parseCoding(content: string): CodingParseResult {
  let doc: unknown;
  try {
    doc = parseYamlText(content);
  } catch {
    return {
      ok: false,
      message: "This coding activity could not be read — its YAML is not valid.",
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, message: "This coding activity is empty or malformed." };
  }
  const root = doc as Record<string, unknown>;

  const llm = root.llm as Record<string, unknown> | undefined;
  const model = asString(llm?.model);
  if (!model) {
    return { ok: false, message: "This coding activity does not specify a model (llm.model)." };
  }

  // Missing ⇒ SCCH; present-but-invalid is rejected so a Foundry-intended
  // activity never silently runs against SCCH.
  const provider =
    llm?.provider === undefined ? DEFAULT_PROVIDER : parseLenientProvider(llm.provider);
  if (!provider) {
    return {
      ok: false,
      message:
        'This coding activity uses an unsupported llm.provider (use "SCCH", "Azure Foundry" or "OpenRouter").',
    };
  }

  // Absent ⇒ nothing is pinned; present-but-invalid is rejected so an activity
  // never silently runs at the model's default effort.
  const reasoning =
    llm?.reasoning === undefined ? undefined : parseLenientReasoningLevel(llm.reasoning);
  if (llm?.reasoning !== undefined && !reasoning) {
    return {
      ok: false,
      message: `This coding activity uses an unsupported llm.reasoning (one of ${REASONING_LEVELS.join(", ")}).`,
    };
  }

  const instructions = asString(root.instructions);
  if (!instructions) {
    return { ok: false, message: "This coding activity has no instructions for the assistant." };
  }

  return {
    ok: true,
    coding: {
      id: asString(root.id) ?? "coding",
      title: asString(root.title),
      model,
      provider,
      reasoning,
      instructions,
      // Carried through for `loadCoding` to resolve + prepend to `instructions`.
      fragmentBlock: readFragmentBlock(root),
    },
  };
}
