import { Mastra } from "@mastra/core/mastra";
import { SamplingStrategyType } from "@mastra/core/observability";
import { InMemoryDB, WorkflowsInMemory } from "@mastra/core/storage";
import { PinoLogger } from "@mastra/loggers";
import { Observability } from "@mastra/observability";
import { PostgresStore } from "@mastra/pg";
import { getPool } from "@/lib/db/pool";
import { USAGE_CODE, USAGE_MODULE, USAGE_USER_ID } from "@/lib/usage-context-keys";
import { clozeEvaluatorAgent } from "./cloze-agents";
import { evalJudgeAgent, evalTutorAgent } from "./eval-agents";
import { quizDiscussionAgent, quizEvaluatorAgent } from "./quiz-agents";
import { tutorAgent } from "./tutor-agent";
import { usageExporter } from "./usage-exporter";
import { writingAgent } from "./writing-agents";

const logger = new PinoLogger({ name: "Mastra", level: "info" });

// Build the Mastra store on the app's ONE Postgres pool (`getPool()` in
// lib/db/pool.ts — the same pool Drizzle uses for the `novedu_*` tables). A pool
// passed in via `pool:` is never closed by Mastra, so there is no lifecycle
// coupling. Mastra's tables live in their own `mastra` schema, created by
// `initMastraStorage()` below; `init()` only creates the tables inside it. The
// app's tables stay in `public`.
function buildStore(): PostgresStore {
  const store = new PostgresStore({ id: "mastra-storage", pool: getPool(), schemaName: "mastra" });
  // Keep agentic-loop workflow snapshots OUT of the database: every agent run
  // persists a "pending" snapshot at start, reads it back, and deletes it at the
  // end — three round trips per turn for state nothing here ever resumes (no
  // suspend/approval flows). The snapshots are transient scratch state, so
  // swapping the workflows domain to Mastra's in-memory store is the same
  // substitution Mastra itself makes when a composite store lacks the domain.
  // Threads/messages stay in the database untouched.
  store.stores.workflows = new WorkflowsInMemory({ db: new InMemoryDB() });
  return store;
}

// Reuse a single store (and its connection pool) across Next.js HMR reloads in dev,
// otherwise every hot reload would leak a new pool. In production the module is
// evaluated once, so this is just a no-op cache.
const globalForStore = globalThis as unknown as { mastraStore?: PostgresStore };

if (process.env.DATABASE_URL && !globalForStore.mastraStore) {
  globalForStore.mastraStore = buildStore();
} else if (!process.env.DATABASE_URL) {
  // The app still boots (non-chat flows like tutor validation work without a DB),
  // but the tutor's Memory REQUIRES a store — chatting will fail until a database
  // URL is set. We don't degrade gracefully; that surfaces as a server error.
  logger.warn("DATABASE_URL not set — tutor chat will fail without storage");
}

// Create the `mastra` schema and Mastra's own `mastra_*` tables inside it.
// `PostgresStore` auto-initializes the TABLES, but only LAZILY — on the store's first use, i.e.
// the first agent run. That is too late for us: `lib/code-stats-store.ts` reads
// `mastra_threads` / `mastra_messages` directly (the by-value join model in
// docs/codes.md), so on a database where no agent has run yet a teacher opening
// a code detail page hits "relation does not exist" and the stats panel degrades
// to "Stats temporarily unavailable".
// instrumentation.ts therefore calls this at startup, right after the Drizzle
// migrations, so the boot contract stays "every table this server reads exists
// once startup finishes". Failures propagate for the same reason migration
// failures do.
//
// The `CREATE SCHEMA IF NOT EXISTS` lives HERE — not in instrumentation.ts, and not
// in a Drizzle migration — because this is the one function that owns the invariant
// "the schema exists before `PostgresStore.init()` runs": keeping the statement in
// the same call site as the `init()` it guards means no second place can drift out
// of order, and every environment (prod, dev, CI, Compose) gets it from the app's
// own boot instead of from per-environment setup. A Drizzle migration would be the
// wrong home: it would pull Mastra's schema into the `novedu_*` migration history,
// which is deliberately decoupled from Mastra's (no foreign keys, no shared
// bookkeeping — docs/database.md). The app role may create schemas: it holds CREATE
// on the database, which the Drizzle migrator's own `CREATE SCHEMA IF NOT EXISTS
// "public"` already requires (scripts/db/provision-stage.sql).
// Stage provisioning still creates `mastra` explicitly, and that stays: created by
// the Entra admin it is OWNED by the admin with USAGE + CREATE granted to the app
// role, whereas the first boot to reach a fresh database would otherwise own the
// schema (docs/database.md, "Privilege model").
export async function initMastraStorage(): Promise<void> {
  const store = globalForStore.mastraStore;
  if (!store) return;
  await getPool().query('CREATE SCHEMA IF NOT EXISTS "mastra"');
  await store.init();
}

export const mastra = new Mastra({
  // The `tutor` agent is configured per request from a tutor-definition YAML
  // (system prompt + model) and persists its conversation via the shared store.
  // NOTE: the registry KEY (not the agent's `id`) is the AG-UI agentId the
  // frontend references — so this must be `tutor` to match `agentId="tutor"`.
  //
  // The quiz agents share the same store. `quizDiscussion` is reached through the
  // CopilotKit route (agentId="quizDiscussion") for the per-question discussion
  // chat; the route's quiz branch allows ONLY that agent id. `quizEvaluator` is
  // invoked server-side by the `submitAnswer` action (never through the route —
  // the route never allows its id), so the grader is never web-exposed.
  //
  // The `writing` agent backs the Writing feature's feedback chat (agentId="writing"
  // through the runtime route); it is configured per request from the writing YAML
  // and has no write/edit tool, so it can never mutate the student's text.
  //
  // `evalJudge` and `evalTutor` are the other internal-only agents: the first audits a
  // model's output for the teacher-only `POST /api/eval/judge`, the second generates the
  // ONE tutor turn a tutor eval measures for `POST /api/eval/respond`
  // (docs/cli-eval.md). Like `quizEvaluator`, the runtime route never allows their ids,
  // so neither is ever web-reachable by students.
  //
  // `clozeEvaluator` grades a cloze exercise and writes its feedback, invoked
  // server-side by the `gradeCloze` / `explainCloze` actions only; the cloze module
  // has no runtime, so the route never allows its id either.
  agents: {
    tutor: tutorAgent,
    quizDiscussion: quizDiscussionAgent,
    quizEvaluator: quizEvaluatorAgent,
    evalJudge: evalJudgeAgent,
    evalTutor: evalTutorAgent,
    writing: writingAgent,
    clozeEvaluator: clozeEvaluatorAgent,
  },
  // Persistent storage is Postgres via `@mastra/pg`, on the app's shared pool
  // (schema `mastra`); the pool decides password-vs-Entra auth from `DATABASE_URL`
  // (lib/db/pool.ts). Undefined when no database URL is configured (see above).
  storage: globalForStore.mastraStore,
  logger,
  // Usage metering: one observability instance whose only exporter meters token
  // usage + tool calls into our `novedu_usage_*` tables (lib/usage-store.ts). `default:
  // { enabled: false }` keeps Mastra's built-in storage/platform exporters out — we
  // only want ours. `requestContextKeys` snapshots the three attribution keys the
  // seams set (the CopilotKit route's `built.context`; the quiz grader's
  // RequestContext) onto every span for the exporter to read. The auto-applied
  // SensitiveDataFilter is left on (privacy-safe default); it uses EXACT field-name
  // matching and only touches attributes/metadata/input/output, so these three keys
  // survive. See docs/usage-metering.md.
  observability: new Observability({
    default: { enabled: false },
    configs: {
      usage: {
        serviceName: "novedu-usage",
        sampling: { type: SamplingStrategyType.ALWAYS },
        requestContextKeys: [USAGE_CODE, USAGE_USER_ID, USAGE_MODULE],
        exporters: [usageExporter],
      },
    },
  }),
});
