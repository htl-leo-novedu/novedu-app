import type { Instrumentation } from "next";

// Runs ONCE per server instance, before the first request is served (Next.js
// instrumentation file convention). Startup duties, in order:
//
//   0. The build's sign-in mode (docs/auth.md, "Demo mode"), frozen at build time
//      by next.config.ts. A demo build first runs its env lock — refusing the
//      Entra settings and a `novedu.at` AUTH_URL, also when DATABASE_URL is unset
//      — and both builds log the mode they run in.
//   1. Bring up telemetry FIRST (Azure Monitor or standard OTLP export — the
//      facade picks one from the environment, docs/telemetry.md), so its
//      auto-instrumentation can patch the HTTP and `pg` modules before anything
//      opens a connection. No-op when no destination is configured. Also
//      records a content-free `app_started` event.
//   2. Log the image storage root's state (`verifyImageRoot`, `lib/image-fs.ts`)
//      — independent of the database, so it runs even when DATABASE_URL is
//      unset below. A missing/misconfigured root only warns: the app keeps
//      booting and every image operation reports `unavailable` until an
//      operator fixes it (`npm run images:init-root`).
//   3. The provenance preflight (lib/db/auth-mode-preflight.ts): read-only, and
//      BEFORE any DDL, it refuses a database holding the other mode's accounts
//      (one sign-in mode per database).
//   4. Apply pending Drizzle migrations to the app-owned `novedu_*` tables — the
//      server must never run against an older schema than its code expects.
//      Failures abort startup on purpose.
//   5. Create the `mastra` schema and Mastra's `mastra_*` tables inside it
//      (`initMastraStorage`). Mastra would create the tables itself, but only on
//      the store's first use — and `lib/code-stats-store.ts` reads those tables
//      directly, so on a database where no agent has run yet the teacher's stats
//      panels would break first. Same fail-loud policy as (4). The schema
//      statement sits inside that function, beside the `init()` it guards, rather
//      than here — see app/mastra/index.ts.
//   6. Demo builds only: seed the four demo personas (lib/demo-seed.ts), resetting
//      any drift in their rows. Fail-loud like (4).
//
// Expired codes are NOT garbage-collected: codes and their conversation data live
// until a teacher deletes them explicitly, so their stats stay reachable.
//
// Needs Node.js (database driver + OTEL SDK); the edge/browser builds of this
// file do nothing. The dynamic imports keep those modules out of edge bundles.
// The no-DB case (DATABASE_URL unset, e.g. plain `next build`) skips
// migrations: the app boots for DB-less flows like tutor validation, matching
// the graceful degradation in app/mastra/index.ts. Telemetry is independent of
// the DB and gated on its own destination settings.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The literal comparisons fold at build time: an Entra build carries no demo code.
  if (process.env.NOVEDU_AUTH_MODE === "demo") {
    const { startDemoBoot } = await import("@/lib/demo-boot");
    startDemoBoot(process.env);
  } else {
    console.log("instrumentation: auth mode Entra ID");
  }

  const { initTelemetry, emitEvent } = await import("@/lib/telemetry");
  await initTelemetry();
  emitEvent("app_started", { runtime: "nodejs" });

  try {
    const { verifyImageRoot } = await import("@/lib/image-fs");
    const root = await verifyImageRoot();
    if (root.ok) {
      console.log(`instrumentation: image storage root OK — ${root.root}`);
    } else {
      console.warn(`instrumentation: image storage root unavailable — ${root.detail}`);
    }
  } catch (error) {
    console.warn("instrumentation: image storage root check failed", error);
  }

  if (!process.env.DATABASE_URL) {
    console.warn("instrumentation: DATABASE_URL not set — skipping migrations");
    return;
  }

  const { getPool } = await import("@/lib/db/pool");
  const { assertAuthModeProvenance } = await import("@/lib/db/auth-mode-preflight");
  await assertAuthModeProvenance(
    getPool(),
    process.env.NOVEDU_AUTH_MODE === "demo" ? "demo" : "entra",
  );

  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();

  const { initMastraStorage } = await import("@/app/mastra");
  await initMastraStorage();

  if (process.env.NOVEDU_AUTH_MODE === "demo") {
    const { seedDemoPersonas } = await import("@/lib/demo-seed");
    await seedDemoPersonas(getPool());
    console.log("instrumentation: demo personas seeded");
  }
}

// Next calls this for EVERY uncaught server error — route handlers, server
// actions, and RSC renders alike — so one global hook records them without
// wrapping individual calls. This is the capture path for unhandled errors that
// auto-instrumentation misses (e.g. async DB-driver rejections). Node-only: the
// telemetry provider is initialized only in the Node runtime.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordError } = await import("@/lib/telemetry");
  recordError(err, { path: request.path, routeType: context.routeType });
};
