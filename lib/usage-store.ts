import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { usageByCode, usageByUser } from "@/lib/db/schema";
import { reportStoreFailure } from "@/lib/store-failure";

// The write seam for usage metering — the ONLY access to `novedu_usage_by_code`
// and `novedu_usage_by_user`. Mirrors lib/user-chat-store.ts discipline: it NEVER
// throws (errors go through `reportStoreFailure`), so a lost increment can never
// break a chat, a grade, a save, or the coding proxy. Every write is an
// increment-UPSERT into a tiny hourly bucket, called OFF the response path (the
// observability exporter is async; the route/action counters run in `after()` /
// fire-and-forget).
//
// Anonymity: `usage_by_code` carries no user and `usage_by_user` carries no code —
// neither table ever links a student to an activity (docs/codes.md,
// docs/usage-metering.md). A caller with a `userId` meters BOTH tables (even for an
// anonymous code — the user id is only ever stored against an hour bucket); a caller
// without one meters `usage_by_code` alone.
//
// SERVER-ONLY: uses the database. Never import from client components.

/** The nine metric deltas; any omitted field defaults to 0 (a no-op increment). */
interface UsageDeltas {
  inputTokensNew?: number;
  inputTokensCached?: number;
  outputTokens?: number;
  toolCalls?: number;
  userMessages?: number;
  quizAnswers?: number;
  writingSaves?: number;
  codingRequests?: number;
  clozeSubmissions?: number;
}

/**
 * Truncates a Date to the top of its UTC hour — the bucket key for both tables.
 * Exported for unit testing.
 */
export function hourBucket(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0),
  );
}

/**
 * Which LLM served the bucket's tokens — known only to `recordLlmUsage` (the
 * counter recorders pass nothing). Values are truncated to their column widths so
 * an oversized id can never fail (and thus drop) a whole increment.
 */
interface LlmAttribution {
  provider?: string;
  model?: string;
}

// Increment-UPSERT as ONE statement: INSERT the bucket with the deltas as its
// initial values, ON CONFLICT DO UPDATE incrementing each column in place —
// `excluded` is the row that would have been inserted, so the UPDATE adds
// exactly the same deltas the INSERT would have set. Two concurrent writers on
// one bucket both land: whichever commits first creates the row, the other
// increments it.
//
// `provider`/`model` are NOT increments: the INSERT sets them when known, and a
// NULL insert value makes the UPDATE's COALESCE a no-op, so the column only
// ever fills in from empty (a user-message counter usually creates the bucket
// BEFORE the generation finishes, so an insert-only write would leave them
// NULL). First writer WITH the knowledge wins; the rare bucket straddling a
// republished YAML keeps its first-seen value — negligible for a cost aggregate.
async function bumpByCode(
  code: string,
  hour: Date,
  module: string,
  d: UsageDeltas,
  attr?: LlmAttribution,
): Promise<void> {
  const provider = attr?.provider?.slice(0, 32) ?? null;
  const model = attr?.model?.slice(0, 256) ?? null;
  await getDb()
    .insert(usageByCode)
    .values({
      code,
      hour,
      module,
      provider,
      model,
      inputTokensNew: d.inputTokensNew ?? 0,
      inputTokensCached: d.inputTokensCached ?? 0,
      outputTokens: d.outputTokens ?? 0,
      toolCalls: d.toolCalls ?? 0,
      userMessages: d.userMessages ?? 0,
      quizAnswers: d.quizAnswers ?? 0,
      writingSaves: d.writingSaves ?? 0,
      codingRequests: d.codingRequests ?? 0,
      clozeSubmissions: d.clozeSubmissions ?? 0,
    })
    .onConflictDoUpdate({
      target: [usageByCode.code, usageByCode.hour],
      set: {
        inputTokensNew: sql`${usageByCode.inputTokensNew} + excluded.input_tokens_new`,
        inputTokensCached: sql`${usageByCode.inputTokensCached} + excluded.input_tokens_cached`,
        outputTokens: sql`${usageByCode.outputTokens} + excluded.output_tokens`,
        toolCalls: sql`${usageByCode.toolCalls} + excluded.tool_calls`,
        userMessages: sql`${usageByCode.userMessages} + excluded.user_messages`,
        quizAnswers: sql`${usageByCode.quizAnswers} + excluded.quiz_answers`,
        writingSaves: sql`${usageByCode.writingSaves} + excluded.writing_saves`,
        codingRequests: sql`${usageByCode.codingRequests} + excluded.coding_requests`,
        clozeSubmissions: sql`${usageByCode.clozeSubmissions} + excluded.cloze_submissions`,
        provider: sql`COALESCE(${usageByCode.provider}, excluded.provider)`,
        model: sql`COALESCE(${usageByCode.model}, excluded.model)`,
      },
    });
}

// No `provider`/`model` here — `usage_by_user` never carries an LLM (or code)
// signal that could hint which activity a student used (the anonymity
// invariant, docs/usage-metering.md).
async function bumpByUser(userId: string, hour: Date, d: UsageDeltas): Promise<void> {
  await getDb()
    .insert(usageByUser)
    .values({
      userId,
      hour,
      inputTokensNew: d.inputTokensNew ?? 0,
      inputTokensCached: d.inputTokensCached ?? 0,
      outputTokens: d.outputTokens ?? 0,
      toolCalls: d.toolCalls ?? 0,
      userMessages: d.userMessages ?? 0,
      quizAnswers: d.quizAnswers ?? 0,
      writingSaves: d.writingSaves ?? 0,
      codingRequests: d.codingRequests ?? 0,
      clozeSubmissions: d.clozeSubmissions ?? 0,
    })
    .onConflictDoUpdate({
      target: [usageByUser.userId, usageByUser.hour],
      set: {
        inputTokensNew: sql`${usageByUser.inputTokensNew} + excluded.input_tokens_new`,
        inputTokensCached: sql`${usageByUser.inputTokensCached} + excluded.input_tokens_cached`,
        outputTokens: sql`${usageByUser.outputTokens} + excluded.output_tokens`,
        toolCalls: sql`${usageByUser.toolCalls} + excluded.tool_calls`,
        userMessages: sql`${usageByUser.userMessages} + excluded.user_messages`,
        quizAnswers: sql`${usageByUser.quizAnswers} + excluded.quiz_answers`,
        writingSaves: sql`${usageByUser.writingSaves} + excluded.writing_saves`,
        codingRequests: sql`${usageByUser.codingRequests} + excluded.coding_requests`,
        clozeSubmissions: sql`${usageByUser.clozeSubmissions} + excluded.cloze_submissions`,
      },
    });
}

// Applies deltas to `usage_by_code` (always) and `usage_by_user` (only when a
// userId is present). The single fan-out point, guarded so a metering write never
// throws into a caller.
async function record(
  code: string,
  module: string,
  userId: string | undefined,
  at: Date,
  d: UsageDeltas,
  op: string,
  attr?: LlmAttribution,
): Promise<void> {
  const hour = hourBucket(at);
  // Provider/model attribution goes to `usage_by_code` ONLY — on `usage_by_user`
  // even a coarse provider signal would hint WHICH activity a student did
  // (the anonymity invariant, docs/usage-metering.md). The two upserts touch
  // independent tables, so they run concurrently; a failure of one never
  // suppresses the other, and each failure is reported on its own.
  const results = await Promise.allSettled([
    bumpByCode(code, hour, module, d, attr),
    ...(userId ? [bumpByUser(userId, hour, d)] : []),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      reportStoreFailure("usage", op, result.reason);
    }
  }
}

/** LLM token usage for one generation, from the observability exporter or the coding proxy. */
export interface LlmUsageInput {
  code: string;
  module: string;
  /** Absent ⇒ only `usage_by_code` is metered. */
  userId?: string;
  /** The LLM provider that served the generation (e.g. "SCCH"). `usage_by_code` only. */
  provider?: string;
  /** The raw model id / deployment name that served it. `usage_by_code` only. */
  model?: string;
  inputNew: number;
  inputCached: number;
  output: number;
  toolCalls: number;
  /** Requests through the coding proxy this generation counts as (the proxy passes 1). */
  codingRequests?: number;
  /** The event time (e.g. the span end); defaults to now. Selects the hour bucket. */
  at?: Date;
}

/** Records token counts (+ tool calls) for one generation. Never throws. */
export function recordLlmUsage(input: LlmUsageInput): Promise<void> {
  return record(
    input.code,
    input.module,
    input.userId,
    input.at ?? new Date(),
    {
      inputTokensNew: input.inputNew,
      inputTokensCached: input.inputCached,
      outputTokens: input.output,
      toolCalls: input.toolCalls,
      codingRequests: input.codingRequests,
    },
    "recordLlmUsage",
    { provider: input.provider, model: input.model },
  );
}

/** +1 user message for a code and its student. Never throws. */
export function recordUserMessage(input: {
  code: string;
  module: string;
  userId: string;
}): Promise<void> {
  return record(
    input.code,
    input.module,
    input.userId,
    new Date(),
    { userMessages: 1 },
    "recordUserMessage",
  );
}

/** +1 quiz answer for a quiz code and its student. Never throws. */
export function recordQuizAnswer(input: { code: string; userId: string }): Promise<void> {
  return record(
    input.code,
    "quiz",
    input.userId,
    new Date(),
    { quizAnswers: 1 },
    "recordQuizAnswer",
  );
}

/** +1 writing save for a writing code and its student. Never throws. */
export function recordWritingSave(input: { code: string; userId: string }): Promise<void> {
  return record(
    input.code,
    "writing",
    input.userId,
    new Date(),
    { writingSaves: 1 },
    "recordWritingSave",
  );
}

/** +1 graded cloze submission for a cloze code and its student. Never throws. */
export function recordClozeSubmission(input: { code: string; userId: string }): Promise<void> {
  return record(
    input.code,
    "cloze",
    input.userId,
    new Date(),
    { clozeSubmissions: 1 },
    "recordClozeSubmission",
  );
}
