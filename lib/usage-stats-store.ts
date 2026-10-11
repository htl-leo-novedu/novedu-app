import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  bucketKeyOf,
  foldTopN,
  resolveRange,
  type Slice,
  type TokenBucket,
  type TokenSums,
  type UsageRange,
  zeroFill,
} from "@/lib/usage-range";

// Read-side aggregates behind the usage dashboard (docs/dashboard.md). One query
// per chart/KPI, each grouping in SQL so only small result sets cross the wire.
// Mirrors lib/code-stats-store.ts: raw by-value `sql` (the KPI query joins Mastra's
// `mastra_messages`, which Drizzle never declares), reading `res.rows`, and
// the never-throws contract — every function returns `undefined` on a DB error and
// logs it, so a failed panel degrades to "unavailable" instead of a page crash.
//
// Anonymity is preserved: `novedu_usage_by_code` carries no user id, so nothing
// here can link a student to an activity (docs/usage-metering.md). The code
// breakdown labels slices with the teacher's own note, never a student.
//
// All windows are UTC (see lib/usage-range.ts); the caller injects `now`.
//
// SERVER-ONLY: uses the database. Never import from client components.

// Day/month buckets use the three-argument date_trunc('day' | 'month', u.hour,
// 'UTC') on the timestamptz `hour` column: the explicit zone makes the
// truncation UTC regardless of the session TimeZone (the pool pins it to UTC
// too, but the query must not depend on that), and every bucket comes back as a
// timestamptz instant we can re-key in JS.
function bucketExpr(grain: "hour" | "day" | "month") {
  if (grain === "hour") return sql`u.hour`;
  if (grain === "day") return sql`date_trunc('day', u.hour, 'UTC')`;
  return sql`date_trunc('month', u.hour, 'UTC')`;
}

/**
 * Stacked token totals (new / cached / output) per time bucket for a range,
 * zero-filled to the full bucket list. `code` scopes it to a single code — the
 * seam the future single-code stats pages reuse; omitted, it sums across all
 * codes for the dashboard. Returns `undefined` on a DB error. Never throws.
 */
export async function getTokenTimeSeries(opts: {
  range: UsageRange;
  now: Date;
  code?: string;
}): Promise<TokenBucket[] | undefined> {
  const { start, grain, buckets } = resolveRange(opts.range, opts.now);
  const expr = bucketExpr(grain);
  const codeFilter = opts.code ? sql` AND u.code = ${opts.code}` : sql``;
  try {
    const res = await getDb().execute<{
      bucket: Date;
      inputNew: number | string;
      inputCached: number | string;
      output: number | string;
    }>(sql`
      SELECT ${expr} AS bucket,
             SUM(u.input_tokens_new) AS "inputNew",
             SUM(u.input_tokens_cached) AS "inputCached",
             SUM(u.output_tokens) AS output
      FROM novedu_usage_by_code u
      WHERE u.hour >= ${start}${codeFilter}
      GROUP BY ${expr}
    `);
    const byKey = new Map<string, TokenSums>();
    for (const row of res.rows) {
      byKey.set(bucketKeyOf(new Date(row.bucket), grain), {
        inputNew: Number(row.inputNew),
        inputCached: Number(row.inputCached),
        output: Number(row.output),
      });
    }
    return zeroFill(buckets, byKey);
  } catch (error) {
    console.error("usage-stats-store: token time series failed", error);
    return undefined;
  }
}

/** Token totals for the two dashboard pies, both over the same window. */
export interface UsageBreakdown {
  /** Total tokens per module (raw module id; the UI maps to a display label). */
  byModule: Slice[];
  /** Total tokens per code, folded to the top 9 + "Other" (label = teacher note). */
  byCode: Slice[];
}

/**
 * One `(code, module)` scan over the window feeds BOTH pies: summed by module and
 * folded top-9-by-code + "Other". Returns `undefined` on a DB error. Never throws.
 */
export async function getUsageBreakdown(opts: {
  range: UsageRange;
  now: Date;
}): Promise<UsageBreakdown | undefined> {
  const { start } = resolveRange(opts.range, opts.now);
  try {
    const res = await getDb().execute<{
      code: string;
      module: string;
      note: string | null;
      total: number | string;
    }>(sql`
      SELECT u.code AS code, u.module AS module, c.note AS note,
             SUM(u.input_tokens_new + u.input_tokens_cached + u.output_tokens) AS total
      FROM novedu_usage_by_code u
      LEFT JOIN novedu_codes c ON c.code = u.code
      WHERE u.hour >= ${start}
      GROUP BY u.code, u.module, c.note
    `);
    const moduleTotals = new Map<string, number>();
    const codeSlices: Slice[] = [];
    for (const row of res.rows) {
      const total = Number(row.total);
      moduleTotals.set(row.module, (moduleTotals.get(row.module) ?? 0) + total);
      const note = (row.note ?? "").trim();
      codeSlices.push({ key: row.code, label: note.length > 0 ? note : row.code, total });
    }
    // Drop zero-total slices: a code whose only in-window activity is a writing save
    // or a quiz answer (or whose token counts landed in another hour bucket) has a
    // `usage_by_code` row with all three token columns 0. A pie titled "tokens per
    // module/code" must not list a category that contributed no tokens — and folding
    // a zero-total remainder would otherwise render a phantom "Other: 0" slice.
    const byModule: Slice[] = [...moduleTotals.entries()]
      .map(([module, total]) => ({ key: module, label: module, total }))
      .filter((s) => s.total > 0)
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
    return {
      byModule,
      byCode: foldTopN(
        codeSlices.filter((s) => s.total > 0),
        9,
      ),
    };
  } catch (error) {
    console.error("usage-stats-store: usage breakdown failed", error);
    return undefined;
  }
}

/**
 * Total tokens per MODEL over the window, folded to the top 9 + "Other". Grouped
 * by the denormalized `model` column (the activity YAML's `llm.model`), so slices
 * are raw model ids / deployment names. This is a MODEL breakdown only — the
 * provider split is its own query (`getTokensByProvider`), because model ids are
 * not provider-disjoint (the same id can be served by more than one provider).
 * Rows with a NULL model (metered before models were recorded) show as
 * "(unknown)"; zero-token rows (buckets that only counted messages/saves) are
 * dropped like in the other pies. Returns `undefined` on a DB error. Never throws.
 */
export async function getTokensByModel(opts: {
  range: UsageRange;
  now: Date;
}): Promise<Slice[] | undefined> {
  const { start } = resolveRange(opts.range, opts.now);
  try {
    const res = await getDb().execute<{ model: string | null; total: number | string }>(sql`
      SELECT u.model AS model,
             SUM(u.input_tokens_new + u.input_tokens_cached + u.output_tokens) AS total
      FROM novedu_usage_by_code u
      WHERE u.hour >= ${start}
      GROUP BY u.model
    `);
    const slices: Slice[] = res.rows
      .map((row) => {
        const model = row.model ?? "(unknown)";
        return { key: model, label: model, total: Number(row.total) };
      })
      .filter((s) => s.total > 0);
    return foldTopN(slices, 9);
  } catch (error) {
    console.error("usage-stats-store: tokens by model failed", error);
    return undefined;
  }
}

/**
 * Total tokens per LLM PROVIDER over the window. Grouped by the denormalized
 * `provider` column — the app-level provider label the recorder stamped (e.g.
 * "SCCH" / "Azure Foundry", docs/usage-metering.md) — so this is the cost split:
 * which provider's tokens were spent, independent of the model ids they ran.
 * Rows with a NULL provider (metered before providers were recorded) show as
 * "(unknown)"; zero-token rows (buckets that only counted messages/saves) are
 * dropped like in the other pies. Folded to the top 9 + "Other" for consistency
 * with the sibling pies, though the provider count is far below that in practice.
 * Returns `undefined` on a DB error. Never throws.
 */
export async function getTokensByProvider(opts: {
  range: UsageRange;
  now: Date;
}): Promise<Slice[] | undefined> {
  const { start } = resolveRange(opts.range, opts.now);
  try {
    const res = await getDb().execute<{ provider: string | null; total: number | string }>(sql`
      SELECT u.provider AS provider,
             SUM(u.input_tokens_new + u.input_tokens_cached + u.output_tokens) AS total
      FROM novedu_usage_by_code u
      WHERE u.hour >= ${start}
      GROUP BY u.provider
    `);
    const slices: Slice[] = res.rows
      .map((row) => {
        const provider = row.provider ?? "(unknown)";
        return { key: provider, label: provider, total: Number(row.total) };
      })
      .filter((s) => s.total > 0);
    return foldTopN(slices, 9);
  } catch (error) {
    console.error("usage-stats-store: tokens by provider failed", error);
    return undefined;
  }
}

/** The headline KPIs, all windowed to the selected range. */
export interface DashboardKpis {
  /** Distinct Mastra threads with ≥1 user message in the window (a real chat). */
  chats: number;
  /** Quiz answers graded in the window (`SUM(quiz_answers)` for quiz codes). */
  quizAnswers: number;
  /** Cloze submissions graded in the window (`SUM(cloze_submissions)` for cloze codes). */
  clozeSubmissions: number;
}

/**
 * All KPIs in one round trip (windowed subselects). `chats` counts threads
 * that have a user message in the window (the repo's "real conversation"
 * definition, matching code-stats-store); `quizAnswers` and `clozeSubmissions`
 * sum their counters. Returns `undefined` on a DB error. Never throws.
 *
 * `chats` is phrased as an EXISTS over `mastra_threads` (small — one row per chat)
 * probing `mastra_messages` by its `thread_id` index, NOT a `COUNT(DISTINCT
 * thread_id)` scan of `mastra_messages` filtered by `createdAt` — the latter scans
 * the (large, replay-inflated) message table by time with no time index and blows
 * past the driver's request timeout.
 */
export async function getDashboardKpis(opts: {
  range: UsageRange;
  now: Date;
}): Promise<DashboardKpis | undefined> {
  const { start } = resolveRange(opts.range, opts.now);
  try {
    const res = await getDb().execute<{
      chats: number | string;
      quizAnswers: number | string;
      clozeSubmissions: number | string;
    }>(sql`
      SELECT
        (SELECT COUNT(*)
           FROM mastra.mastra_threads t
          WHERE EXISTS (
            SELECT 1 FROM mastra.mastra_messages m
            WHERE m.thread_id = t.id AND m.role = 'user'
              AND m."createdAtZ" >= ${start}
          )) AS chats,
        (SELECT COALESCE(SUM(u.quiz_answers), 0)
           FROM novedu_usage_by_code u
          WHERE u.module = 'quiz' AND u.hour >= ${start}) AS "quizAnswers",
        (SELECT COALESCE(SUM(u.cloze_submissions), 0)
           FROM novedu_usage_by_code u
          WHERE u.module = 'cloze' AND u.hour >= ${start}) AS "clozeSubmissions"
    `);
    const row = res.rows[0];
    return {
      chats: Number(row?.chats ?? 0),
      quizAnswers: Number(row?.quizAnswers ?? 0),
      clozeSubmissions: Number(row?.clozeSubmissions ?? 0),
    };
  } catch (error) {
    console.error("usage-stats-store: dashboard KPIs failed", error);
    return undefined;
  }
}
