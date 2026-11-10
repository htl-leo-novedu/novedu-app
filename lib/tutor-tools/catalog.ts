// The pure tutor-tool catalog: for every name in `names.ts`, the model-facing
// description, the zod input/output schemas, and the pure `execute` logic.
// Framework-agnostic on purpose — the Mastra `createTool` binding lives in
// `app/mastra/tutor-tools.ts`, NOT here: this module may end up in the CLI
// bundle's transitive closure and must import nothing from `app/**`, the DB,
// or `lib/llm/model.ts` (node builtins are fine). Randomness is injected via
// `TutorToolDeps` so unit tests are deterministic; the crypto-backed default
// lives in `defaultTutorToolDeps`. A stateful tool (`board`) gets the thread's
// earlier successful calls injected per call (`TutorToolCallContext`), so its
// executor stays pure too.

import { randomInt } from "node:crypto";
import { z } from "zod";
import { apply, replay, summary } from "@/lib/board/model";
import type { TutorToolName } from "./names";

/**
 * `min`/`max` bounds for `random_number`. ±2^31 keeps every value an exact
 * integer for the model and the range far below node's `randomInt` limit (2^48).
 */
export const RANDOM_NUMBER_BOUND = 2 ** 31;

/** Uniform integer in [minInclusive, maxInclusive]. */
export type RandomIntFn = (minInclusive: number, maxInclusive: number) => number;

/** Injected effects for tool executors — swap in tests for determinism. */
export interface TutorToolDeps {
  randomInt: RandomIntFn;
}

export const defaultTutorToolDeps: TutorToolDeps = {
  // node's crypto.randomInt is rejection-sampled (no modulo bias); its upper
  // bound is exclusive, the tool contract is inclusive.
  randomInt: (min, max) => randomInt(min, max + 1),
};

/** Per-call input of a stateful tool: what earlier calls of the same thread left behind. */
export interface TutorToolCallContext {
  /** The inputs of this tool's earlier SUCCESSFUL calls in the thread, oldest first. */
  priorCalls: readonly unknown[];
}

/** The context of a tool call with no history (stateless tools, a thread's first call). */
export const NO_PRIOR_CALLS: TutorToolCallContext = { priorCalls: [] };

export interface TutorToolDef<In, Out> {
  name: TutorToolName;
  /** Wire-level tool description, written FOR the model. */
  description: string;
  inputSchema: z.ZodType<In>;
  outputSchema: z.ZodType<Out>;
  /**
   * Whether the executor needs the thread's earlier successful calls
   * (`context.priorCalls`); the binding loads them only for such a tool.
   */
  stateful?: true;
  execute: (input: In, deps: TutorToolDeps, context: TutorToolCallContext) => Out;
}

// Erased-generics alias for heterogeneous collections of tool defs; per-tool
// input/output types live on each concrete entry.
// biome-ignore lint/suspicious/noExplicitAny: variance — `unknown` would reject every concrete def.
export type AnyTutorToolDef = TutorToolDef<any, any>;

const randomNumberInput = z
  .strictObject({
    min: z
      .number()
      .int()
      .min(-RANDOM_NUMBER_BOUND)
      .max(RANDOM_NUMBER_BOUND)
      .describe("Lower bound, inclusive."),
    max: z
      .number()
      .int()
      .min(-RANDOM_NUMBER_BOUND)
      .max(RANDOM_NUMBER_BOUND)
      .describe("Upper bound, inclusive."),
  })
  .refine((v) => v.min <= v.max, { message: "min must be <= max" });

const randomNumberOutput = z.strictObject({
  value: z.number().int().describe("The uniformly random integer, min <= value <= max."),
});

export const randomNumberTool: TutorToolDef<
  z.infer<typeof randomNumberInput>,
  z.infer<typeof randomNumberOutput>
> = {
  name: "random_number",
  description:
    "Returns a uniformly random integer between min and max (both inclusive). " +
    "Use it whenever you need to generate a practice problem, pick a random value, " +
    "or choose randomly between alternatives — do not invent 'random' numbers yourself.",
  inputSchema: randomNumberInput,
  outputSchema: randomNumberOutput,
  execute: (input, deps) => ({ value: deps.randomInt(input.min, input.max) }),
};

// The board's description is the model's only documentation of the drawing
// language (lib/board/model.ts) — ported verbatim from the drawings spike, where
// GPT-6 Luna was tuned against it. Change it only with a live re-check.
const BOARD_DESCRIPTION = `Draw on the whiteboard next to the chat. The drawing stays for the whole conversation; every call adds to it.
You never give coordinates: the board does all positioning, arrow routing and label placement.
Draw in the order you explain, keep every text to a few words, and refer to the drawing in your answer.
On follow-up questions change the existing drawing (add, remove, highlight) instead of starting over.

Input: {"steps": [...]}, each step one of:
{"op":"board","id","title","kind"?}  starts a board; up to 3 boards appear side by side. kind:
   "grid" (default): parts and how they connect (architecture, data flow, flowcharts, memory)
   "sequence": who sends what to whom, in time order (protocols, request/response, handshakes)
   "bits": a binary format field by field (packet/file headers, an address split into network and host bits);
           optional "bits": bits per row (8|16|32|64, default 32)
   To compare two things (A vs. B), draw each on its own board, side by side.
{"op":"group","id","text","in"?,"color"?}   grid only: a labelled frame around boxes, e.g. a network, subnet, module, object
   or vtable; boxes and groups join it with "in":"<group id>". The frame spans its members' cells, so put members in
   adjacent cells and keep other boxes out of that area. Groups nest (a subnet "in" a VNet); arrows may start or end at a group.
{"op":"box","id","text","color"?,"board"?,"in"?, ...}   board defaults to the board of the previous step
   grid: "row" 0–4, "col" 0–3, one box per cell; "shape": rect (default) | ellipse (start/end, people, concepts) | diamond (decision)
   sequence: no position; boxes are the participants, left to right in drawing order
   bits: "bits": the field's size in bits (omit for variable length); fields fill the rows left to right; sizes and
         bit offsets are shown automatically, so the text is just the field's name
   color: blue | green | yellow | red | gray | white (default)
{"op":"arrow","from","to","text"?,"style"?,"id"?}   id defaults to "<from>-<to>"
   on a sequence board every arrow is the next message, top to bottom; from = to is an action inside one participant
   style: normal | problem (red: wrong or questionable) | dashed (optional, indirect, or a reply)
          | inherits (UML, from subclass to base class) | has (UML composition, from the whole to its part)
{"op":"note","on","text"}   an extra line inside a box (e.g. a class member) or under an arrow's text (max 3)
{"op":"change","id","text"?,"color"?,"style"?,"title"?,"in"?}   changes a box (text, color, group), group (text, color),
   arrow (text, style) or board (title) in place
{"op":"remove","ids"}       removes boards, boxes or arrows (arrows of removed boxes go too)
{"op":"highlight","ids"}    makes these (and whatever this call adds) stand out while you talk about them; lasts until your next call

Ids: meaningful, lowercase with dashes, never reused (not even after remove).
If a call has errors, nothing of it is applied and you get the errors back: fix them and call again.`;

// Deliberately loose (as in the spike): the board's own checks, not zod, explain
// a malformed step to the model — with the ids on the board and how to fix it.
const boardInput = z.object({
  steps: z.array(z.looseObject({})).describe("The drawing steps, applied in order."),
});

const boardOutput = z.union([
  z.strictObject({
    ok: z.literal(true),
    board: z.string().describe("What is on the board now: boards, box ids, groups, arrow ids."),
    warnings: z.array(z.string()).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Why nothing of the call was applied."),
  }),
]);

export const boardTool: TutorToolDef<z.infer<typeof boardInput>, z.infer<typeof boardOutput>> = {
  name: "board",
  description: BOARD_DESCRIPTION,
  inputSchema: boardInput,
  outputSchema: boardOutput,
  stateful: true,
  // The board is the replay of the thread's successful calls; this call applies
  // on top, all or nothing.
  execute: (input, _deps, context) => {
    const result = apply(replay(context.priorCalls), input);
    if (result.errors) return { ok: false, errors: result.errors };
    return {
      ok: true,
      board: summary(result.state),
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    };
  },
};

/**
 * Every tool, keyed by name. The `satisfies` clause forces this record to stay
 * in lockstep with `TUTOR_TOOL_NAMES`: adding a name without a catalog entry
 * (or vice versa) is a type error.
 */
export const tutorToolCatalog = {
  random_number: randomNumberTool,
  board: boardTool,
} satisfies Record<TutorToolName, AnyTutorToolDef>;

/** Resolve a validated `tools:` selection to its catalog entries, in YAML order. */
export function resolveTutorTools(names: readonly TutorToolName[]): AnyTutorToolDef[] {
  return names.map((name) => tutorToolCatalog[name]);
}
