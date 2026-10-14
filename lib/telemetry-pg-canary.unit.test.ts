import { createRequire } from "node:module";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closedPort, type OtlpReceiver, spansOf, startOtlpReceiver } from "../tests/otlp-receiver";

// Privacy canary for the pg instrumentation: a query with a bound string must
// export the statement with its `$1` placeholder and NEVER the bound value.
// The SQL text IS exported as `db.query.text` — accepted, and documented in
// docs/telemetry.md — but bound values are not (`enhancedDatabaseReporting`
// stays false). Own file: it starts the real NodeSDK (see the delivery test).
//
// No database is needed. `pg` is loaded through a hooked `require` AFTER the
// SDK patched the module loader, and the query is queued while `connect()` is
// failing against a closed port: pg then rejects every queued query, and the
// instrumentation ends (and exports) the span it had already started.

const CANARY = "CANARY-LITERAL-9f3a";
let receiver: OtlpReceiver;
let sdk: NodeSDK;
let queryOutcome: PromiseSettledResult<unknown>;

beforeAll(async () => {
  receiver = await startOtlpReceiver();
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", receiver.url);
  vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
  vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
  vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
  vi.stubEnv("OTEL_LOG_LEVEL", "");
  vi.resetModules();
  const { startOtlpSdk } = await import("@/lib/telemetry-otlp");
  sdk = startOtlpSdk();

  const require = createRequire(import.meta.url);
  const { Client } = require("pg") as typeof import("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: await closedPort(),
    user: "canary_user",
    password: "canary-password",
    database: "canary_db",
    connectionTimeoutMillis: 2_000,
  });
  const connecting = client.connect();
  const querying = client.query("select $1::text as v", [CANARY]);
  [, queryOutcome] = await Promise.allSettled([connecting, querying]);
  await sdk.shutdown();
}, 30_000);

afterAll(async () => {
  await receiver.close();
});

describe("pg instrumentation privacy", () => {
  it("rejects the query (no database) yet exports its span with the placeholder statement", () => {
    expect(queryOutcome.status).toBe("rejected");
    const query = spansOf(receiver.requests).find((s) => s.name.startsWith("pg.query"));
    expect(query, "a pg.query span was exported").toBeDefined();
    expect(query?.attributes["db.query.text"]).toContain("$1");
  });

  it("never exports the bound value or the password on any span", () => {
    const spans = spansOf(receiver.requests);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      const serialized = JSON.stringify(span.attributes);
      expect(serialized, span.name).not.toContain(CANARY);
      expect(serialized, span.name).not.toContain("canary-password");
      expect(span.attributes["db.postgresql.values"]).toBeUndefined();
    }
  });
});
