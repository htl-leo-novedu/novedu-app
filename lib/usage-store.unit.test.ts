import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageByCode, usageByUser } from "@/lib/db/schema";

// The usage-store write seam: hour bucketing, the increment-UPSERT column mapping,
// the userId-absent gate (only usage_by_code is metered), and the
// never-throws contract. The DB is mocked — the real UPSERT/concurrency is a
// @live-db concern (docs/testing.md); here we assert WHICH table + WHICH deltas.

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  insertValues: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: (table: unknown) => {
      mocks.insert(table);
      return {
        values: (values: unknown) => {
          mocks.insertValues(values);
          return { onConflictDoUpdate: mocks.onConflictDoUpdate };
        },
      };
    },
  }),
}));
vi.mock("@/lib/telemetry", () => ({ recordError: mocks.recordError }));

import {
  hourBucket,
  recordClozeSubmission,
  recordLlmUsage,
  recordQuizAnswer,
  recordUserMessage,
  recordWritingSave,
} from "@/lib/usage-store";

const CODE = "a1b2c3d4e5";
const USER = "student-oid-1";

// The table object the store hands to insert(), to assert which table was hit.
const tableOf = (call: unknown[]): unknown => call[0];

// The `set` object passed to the Nth insert's onConflictDoUpdate call.
const setOf = (n: number): Record<string, unknown> => {
  const config = mocks.onConflictDoUpdate.mock.calls[n]?.[0] as { set: Record<string, unknown> };
  return config.set;
};

const COUNTER_KEYS = [
  "inputTokensNew",
  "inputTokensCached",
  "outputTokens",
  "toolCalls",
  "userMessages",
  "quizAnswers",
  "writingSaves",
  "codingRequests",
  "clozeSubmissions",
];

beforeEach(() => {
  mocks.onConflictDoUpdate.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("hourBucket", () => {
  it("truncates to the top of the UTC hour", () => {
    const b = hourBucket(new Date("2026-07-01T09:37:41.512Z"));
    expect(b.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  it("uses UTC, not local time", () => {
    const b = hourBucket(new Date(Date.UTC(2026, 0, 1, 23, 59, 59)));
    expect(b.toISOString()).toBe("2026-01-01T23:00:00.000Z");
  });
});

describe("recordLlmUsage", () => {
  it("meters BOTH tables when a userId is present, mapping tokens to the right columns", async () => {
    const at = new Date("2026-07-01T09:15:00.000Z");
    await recordLlmUsage({
      code: CODE,
      module: "tutor",
      userId: USER,
      inputNew: 70,
      inputCached: 30,
      output: 50,
      toolCalls: 0,
      at,
    });

    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.insert.mock.calls.map(tableOf)).toEqual([usageByCode, usageByUser]);

    // usage_by_code carries the module; usage_by_user does not.
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        code: CODE,
        module: "tutor",
        hour: hourBucket(at),
        inputTokensNew: 70,
        inputTokensCached: 30,
        outputTokens: 50,
      }),
    );
    const userRow = mocks.insertValues.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(userRow).toMatchObject({ userId: USER, inputTokensNew: 70, outputTokens: 50 });
    expect(userRow).not.toHaveProperty("code");
    expect(userRow).not.toHaveProperty("module");
  });

  it("meters ONLY usage_by_code when there is no userId", async () => {
    await recordLlmUsage({
      code: CODE,
      module: "coding",
      inputNew: 100,
      inputCached: 0,
      output: 20,
      toolCalls: 0,
    });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(tableOf(mocks.insert.mock.calls[0] ?? [])).toBe(usageByCode);
  });

  it("writes provider/model to usage_by_code ONLY — never to usage_by_user", async () => {
    await recordLlmUsage({
      code: CODE,
      module: "tutor",
      userId: USER,
      provider: "Azure Foundry",
      model: "gpt-5.4-mini",
      inputNew: 10,
      inputCached: 0,
      output: 5,
      toolCalls: 0,
    });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "Azure Foundry", model: "gpt-5.4-mini" }),
    );
    // The anonymity invariant: the per-user row must carry no activity dimension.
    const userRow = mocks.insertValues.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(userRow).not.toHaveProperty("provider");
    expect(userRow).not.toHaveProperty("model");
    expect(setOf(1)).not.toHaveProperty("provider");
    expect(setOf(1)).not.toHaveProperty("model");
  });

  it("passes null provider/model into the INSERT when the caller has no attribution — a no-op COALESCE", async () => {
    await recordUserMessage({ code: CODE, module: "tutor", userId: USER });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: null, model: null }),
    );
    // The ON CONFLICT set still names both — COALESCE is a no-op on a NULL insert
    // value, it doesn't remove the column from the statement.
    expect(setOf(0)).toHaveProperty("provider");
    expect(setOf(0)).toHaveProperty("model");
  });

  it("counts a coding request on BOTH tables in the same increment as the tokens", async () => {
    await recordLlmUsage({
      code: CODE,
      module: "coding",
      userId: USER,
      inputNew: 10,
      inputCached: 0,
      output: 5,
      toolCalls: 0,
      codingRequests: 1,
    });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ module: "coding", codingRequests: 1, outputTokens: 5 }),
    );
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: USER, codingRequests: 1, outputTokens: 5 }),
    );
  });

  it("a generation outside the coding proxy counts no coding request", async () => {
    await recordLlmUsage({
      code: CODE,
      module: "tutor",
      userId: USER,
      inputNew: 10,
      inputCached: 0,
      output: 5,
      toolCalls: 0,
    });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ codingRequests: 0 }),
    );
  });

  it("never throws on a database error and reports a fixed failure without the user id", async () => {
    const cause = Object.assign(new Error("connection refused"), { code: "08006" });
    mocks.onConflictDoUpdate.mockRejectedValue(
      Object.assign(new Error(`Failed query: insert … params: ${USER},${CODE}`), { cause }),
    );
    await expect(
      recordLlmUsage({
        code: CODE,
        module: "tutor",
        userId: USER,
        inputNew: 1,
        inputCached: 0,
        output: 1,
        toolCalls: 0,
      }),
    ).resolves.toBeUndefined();

    // One report per failed table; each carries the fixed message and the SQLSTATE only.
    expect(mocks.recordError).toHaveBeenCalledTimes(2);
    for (const [error, attributes] of mocks.recordError.mock.calls) {
      expect((error as Error).message).toBe("usage: recordLlmUsage failed");
      expect((error as Error).cause).toBeUndefined();
      expect(attributes).toEqual({
        store: "usage",
        op: "recordLlmUsage",
        sqlState: "08006",
      });
    }
    const leaked = JSON.stringify([
      ...mocks.recordError.mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(leaked).not.toContain(USER);
  });
});

describe("discrete counters", () => {
  it("recordUserMessage bumps user_messages on both tables, with the caller's module on usage_by_code", async () => {
    await recordUserMessage({ code: CODE, module: "writing", userId: USER });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ code: CODE, module: "writing", userMessages: 1 }),
    );
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: USER, userMessages: 1 }),
    );
  });

  it("the by-code ON CONFLICT set carries the 9 counters plus provider/model; by-user carries only the 9", async () => {
    await recordUserMessage({ code: CODE, module: "writing", userId: USER });
    expect(Object.keys(setOf(0)).sort()).toEqual([...COUNTER_KEYS, "provider", "model"].sort());
    expect(Object.keys(setOf(1)).sort()).toEqual([...COUNTER_KEYS].sort());
  });

  it("recordQuizAnswer bumps quiz_answers with module 'quiz'", async () => {
    await recordQuizAnswer({ code: CODE, userId: USER });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ module: "quiz", quizAnswers: 1 }),
    );
  });

  it("recordClozeSubmission bumps cloze_submissions with module 'cloze'", async () => {
    await recordClozeSubmission({ code: CODE, userId: USER });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ module: "cloze", clozeSubmissions: 1 }),
    );
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: USER, clozeSubmissions: 1 }),
    );
  });

  it("recordWritingSave bumps writing_saves with module 'writing'", async () => {
    await recordWritingSave({ code: CODE, userId: USER });
    expect(mocks.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ module: "writing", writingSaves: 1 }),
    );
  });
});

describe("table structure", () => {
  const keyColumns = (table: Parameters<typeof getTableConfig>[0]) =>
    getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));

  it("usage_by_code has no user column and is keyed by (code, hour)", () => {
    expect(Object.keys(getTableColumns(usageByCode))).not.toContain("userId");
    expect(keyColumns(usageByCode)).toEqual(["code", "hour"]);
  });

  it("usage_by_user has no code, module, provider or model column and is keyed by (user_id, hour)", () => {
    const columns = Object.keys(getTableColumns(usageByUser));
    for (const forbidden of ["code", "module", "provider", "model"]) {
      expect(columns).not.toContain(forbidden);
    }
    expect(keyColumns(usageByUser)).toEqual(["user_id", "hour"]);
  });
});
