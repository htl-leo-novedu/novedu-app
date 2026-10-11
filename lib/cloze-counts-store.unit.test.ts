import { getTableName, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The cloze per-gap counts store (lib/cloze-counts-store.ts). A recording fake stands
// in for Drizzle, so the tests assert the statement SHAPE — one multi-row upsert
// whose rows carry a 1 in exactly the verdict's counter, incrementing on conflict —
// and that every read and write except the code-delete one never throws and never
// passes the raw error on. The real upsert arithmetic is covered by the `@live-db`
// spec e2e/cloze.spec.ts (a first submission shows on the detail page).

const fake = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    values: [] as unknown[],
    conflict: undefined as { target: unknown[]; set: Record<string, unknown> } | undefined,
    rows: [] as unknown[],
    error: undefined as unknown,
  };
  const step = <T>(entry: string, value: T): Promise<T> => {
    state.log.push(entry);
    return state.error === undefined ? Promise.resolve(value) : Promise.reject(state.error);
  };
  const name = (table: Table) => getTableName(table);
  const db = {
    insert: (table: Table) => ({
      values: (values: unknown) => {
        state.values.push(values);
        return {
          onConflictDoUpdate: (conflict: { target: unknown[]; set: Record<string, unknown> }) => {
            state.conflict = conflict;
            return step(`upsert ${name(table)}`, undefined);
          },
        };
      },
    }),
    select: () => ({
      from: (table: Table) => ({
        where: () => ({
          orderBy: () => step(`select ${name(table)}`, state.rows),
          groupBy: () => step(`select ${name(table)} grouped`, state.rows),
        }),
      }),
    }),
    delete: (table: Table) => ({
      where: () => step(`delete ${name(table)}`, undefined),
    }),
  };
  return { state, db };
});

const recordError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ getDb: () => fake.db }));
vi.mock("@/lib/telemetry", () => ({ recordError }));

import {
  countClozeSubmissions,
  deleteGapCountsForCode,
  listClozeGapCounts,
  recordClozeGapCounts,
} from "@/lib/cloze-counts-store";
import type { DbExecutor } from "@/lib/db";
import { clozeGapCounts } from "@/lib/db/schema";

const CODE = "a1b2c3d4e5";
const dialect = new PgDialect();

beforeEach(() => {
  fake.state.log = [];
  fake.state.values = [];
  fake.state.conflict = undefined;
  fake.state.rows = [];
  fake.state.error = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordClozeGapCounts", () => {
  it("writes ONE multi-row upsert with a 1 in the verdict's counter per gap", async () => {
    await recordClozeGapCounts(CODE, [
      { gap: 1, reference: "is going to", verdict: "correct" },
      { gap: 2, reference: "starts", verdict: "partial" },
      { gap: 3, reference: "", verdict: "incorrect" },
    ]);
    expect(fake.state.log).toEqual(["upsert novedu_cloze_gap_counts"]);
    const [rows] = fake.state.values as Record<string, unknown>[][];
    expect(rows?.map(({ updatedAt: _, ...row }) => row)).toEqual([
      { code: CODE, gap: 1, reference: "is going to", correct: 1, partial: 0, incorrect: 0 },
      { code: CODE, gap: 2, reference: "starts", correct: 0, partial: 1, incorrect: 0 },
      { code: CODE, gap: 3, reference: "", correct: 0, partial: 0, incorrect: 1 },
    ]);
  });

  it("increments the existing row on (code, gap, reference)", async () => {
    await recordClozeGapCounts(CODE, [{ gap: 1, reference: "x", verdict: "correct" }]);
    const conflict = fake.state.conflict;
    expect(conflict?.target).toEqual([
      clozeGapCounts.code,
      clozeGapCounts.gap,
      clozeGapCounts.reference,
    ]);
    const set = Object.fromEntries(
      Object.entries(conflict?.set ?? {}).map(([key, value]) => [
        key,
        dialect.sqlToQuery(value as never).sql,
      ]),
    );
    expect(set).toEqual({
      correct: '"novedu_cloze_gap_counts"."correct" + excluded.correct',
      partial: '"novedu_cloze_gap_counts"."partial" + excluded.partial',
      incorrect: '"novedu_cloze_gap_counts"."incorrect" + excluded.incorrect',
      updatedAt: "excluded.updated_at",
    });
  });

  it("writes nothing for an empty submission", async () => {
    await recordClozeGapCounts(CODE, []);
    expect(fake.state.log).toEqual([]);
  });

  it("never throws, and reports a fixed message without the raw error", async () => {
    fake.state.error = new Error('insert failed: params ["is going to"]');
    await expect(
      recordClozeGapCounts(CODE, [{ gap: 1, reference: "is going to", verdict: "correct" }]),
    ).resolves.toBeUndefined();
    expect(recordError).toHaveBeenCalledTimes(1);
    const [error] = recordError.mock.calls[0] ?? [];
    expect((error as Error).message).toBe("cloze-counts-store: record counts failed");
  });
});

describe("reads", () => {
  it("lists a code's rows", async () => {
    fake.state.rows = [{ gap: 1, reference: "a", correct: 2, partial: 0, incorrect: 1 }];
    await expect(listClozeGapCounts(CODE)).resolves.toEqual(fake.state.rows);
  });

  it("maps the per-code submission maxima", async () => {
    fake.state.rows = [
      { code: "aaaaaaaaaa", submissions: 3 },
      { code: "bbbbbbbbbb", submissions: "7" },
    ];
    const counts = await countClozeSubmissions(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(counts).toEqual(
      new Map([
        ["aaaaaaaaaa", 3],
        ["bbbbbbbbbb", 7],
      ]),
    );
  });

  it("answers an empty code list without a query", async () => {
    await expect(countClozeSubmissions([])).resolves.toEqual(new Map());
    expect(fake.state.log).toEqual([]);
  });

  it("returns undefined instead of throwing when a read fails", async () => {
    fake.state.error = new Error("connection lost");
    await expect(listClozeGapCounts(CODE)).resolves.toBeUndefined();
    await expect(countClozeSubmissions([CODE])).resolves.toBeUndefined();
  });
});

describe("deleteGapCountsForCode", () => {
  it("throws, so the code-delete transaction rolls back", async () => {
    fake.state.error = new Error("connection lost");
    await expect(deleteGapCountsForCode(fake.db as unknown as DbExecutor, CODE)).rejects.toThrow(
      "connection lost",
    );
    expect(fake.state.log).toEqual(["delete novedu_cloze_gap_counts"]);
  });
});
