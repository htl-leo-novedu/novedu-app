import { asc, desc } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake drizzle handle: just enough of the fluent query API for the store's
// operations. Behavior-level tests — what rows come back / what gets inserted —
// not SQL-text assertions.
const fake = vi.hoisted(() => {
  const initial = () => ({
    rows: [] as unknown[],
    // What the paginated list's COUNT(*) reports, plus every LIMIT/OFFSET window
    // the store asked for (so a test can pin the SQL-side paging).
    total: 0,
    windows: [] as { offset: number; limit: number }[],
    // The ORDER BY terms of the most recent row query, so a test can pin that an
    // explicit sort replaced the default order and the tiebreaker still trails.
    order: [] as unknown[],
    // Every WHERE condition handed to a select (the COUNT's and the rows'), so a
    // test can render the SQL a filter produced.
    wheres: [] as unknown[],
    // Every select's projection, so a test can see which columns a query reads.
    selects: [] as (Record<string, unknown> | undefined)[],
    inserted: [] as Record<string, unknown>[],
    insertErrors: [] as unknown[],
    selectError: undefined as unknown,
    deleteCalls: 0,
    deleteError: undefined as unknown,
    updated: [] as Record<string, unknown>[],
    updateError: undefined as unknown,
    updateRowCount: 1 as number,
  });
  const state = initial();
  // The query tail is a lazy thenable (NOT an eager promise): the rejected
  // promise only comes into existence when the store actually awaits it, so
  // error-path tests don't leak unhandled rejections.
  // The list's COUNT(*) goes through the same select/from/where chain as its rows,
  // so the fake tells them apart by the projection: `{ n: … }` is the count.
  const queryTail = (fields?: Record<string, unknown>) => {
    const run = () => {
      if (state.selectError) return Promise.reject(state.selectError);
      const isCount = fields !== undefined && "n" in fields;
      return Promise.resolve(isCount ? [{ n: state.total }] : state.rows);
    };
    return {
      // `orderBy` returns a builder (not a promise) because the paged query
      // continues with `.limit(…).offset(…)`; it stays awaitable for the unpaged call.
      orderBy: (...order: unknown[]) => {
        state.order = order;
        return {
          limit: (limit: number) => ({
            offset: (offset: number) => {
              state.windows.push({ offset, limit });
              return run();
            },
          }),
          // biome-ignore lint/suspicious/noThenProperty: being awaitable is the point — it mimics drizzle's thenable query builder
          then: (...args: Parameters<Promise<unknown[]>["then"]>) => run().then(...args),
        };
      },
      // biome-ignore lint/suspicious/noThenProperty: being awaitable is the point — it mimics drizzle's thenable query builder
      then: (...args: Parameters<Promise<unknown[]>["then"]>) => run().then(...args),
    };
  };
  // `.from(...).$dynamic()` is how the shared `countRows` helper applies its joins
  // in a loop; the tail still resolves through `queryTail`.
  const dynamicTail = (fields?: Record<string, unknown>) => {
    const tail = {
      leftJoin: () => tail,
      where: (condition: unknown) => {
        state.wheres.push(condition);
        return queryTail(fields);
      },
    };
    return tail;
  };
  // `.from(...)` accepts the row query's `.leftJoin(authUsers, …)` (the owner name) as
  // well as the count's `$dynamic()`; both tails resolve through `queryTail`.
  const fromTail = (fields?: Record<string, unknown>) => {
    const tail = {
      leftJoin: () => tail,
      where: (condition: unknown) => {
        state.wheres.push(condition);
        return queryTail(fields);
      },
      $dynamic: () => dynamicTail(fields),
    };
    return tail;
  };
  const select = (fields?: Record<string, unknown>) => {
    state.selects.push(fields);
    return { from: () => fromTail(fields) };
  };
  const insert = () => ({
    values: async (values: Record<string, unknown>) => {
      const error = state.insertErrors.shift();
      if (error) throw error;
      state.inserted.push(values);
    },
  });
  const del = () => ({
    where: async () => {
      state.deleteCalls += 1;
      if (state.deleteError) throw state.deleteError;
    },
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (state.updateError) throw state.updateError;
        state.updated.push(values);
        return { rowCount: state.updateRowCount };
      },
    }),
  });
  return { state, initial, db: { select, selectDistinct: select, insert, delete: del, update } };
});

vi.mock("@/lib/db", () => ({ getDb: () => fake.db }));

import {
  billedTokensSince,
  CODE_PATTERN,
  type CodeEntry,
  checkCode,
  createCode,
  effectiveLlm,
  generateCode,
  getCode,
  LLM_SOURCE_ORDER,
  listCodeOwners,
  listCodes,
  MAX_FILE_URL_LENGTH,
  MAX_LLM_MODEL_LENGTH,
  MAX_NOTE_LENGTH,
  updateCode,
  validateCodeRequest,
  windowStatusCondition,
} from "@/lib/code-store";
import { codes } from "@/lib/db/schema";

const NOW = new Date("2026-06-10T12:00:00Z");

function entry(overrides: Partial<CodeEntry> = {}): CodeEntry {
  return {
    code: "a1b2c3d4e5",
    module: "tutor",
    createdBy: "teacher-sub-1",
    fileUrl: "https://example.com/tutor.yaml",
    validFrom: new Date("2026-06-10T10:00:00Z"),
    validUntil: new Date("2026-06-10T14:00:00Z"),
    note: "",
    origin: null,
    anonymous: true,
    llm: null,
    createdAt: new Date("2026-06-09T09:00:00Z"),
    ...overrides,
  };
}

// The DB-row shape the store reads: the entry's `llm` override flattened into
// the three nullable columns.
function toRow(e: CodeEntry): Record<string, unknown> {
  const { llm, ...rest } = e;
  return {
    ...rest,
    llmProvider: llm?.provider ?? null,
    llmModel: llm?.model ?? null,
    llmReasoning: llm?.reasoning ?? null,
  };
}

// Postgres duplicate-key errors arrive wrapped (DrizzleQueryError → cause chain).
const duplicateKeyError = () =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
    }),
  });

beforeEach(() => {
  Object.assign(fake.state, fake.initial());
});

describe("generateCode", () => {
  it("produces 10 lowercase letters/digits (a subset of CODE_PATTERN)", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[a-z0-9]{10}$/);
      expect(code).toMatch(CODE_PATTERN);
    }
  });
});

describe("CODE_PATTERN", () => {
  it("admits memorable codes (hyphens, varied length) but rejects junk", () => {
    expect("bio101").toMatch(CODE_PATTERN);
    expect("a-b-c").toMatch(CODE_PATTERN);
    expect("UPPER").not.toMatch(CODE_PATTERN);
    expect("has space").not.toMatch(CODE_PATTERN);
    expect("x".repeat(33)).not.toMatch(CODE_PATTERN);
  });
});

describe("validateCodeRequest", () => {
  const valid = {
    file: "https://example.com/tutor.yaml",
    start: "1700000000",
    end: "1700003600",
    note: "  My class  ",
    llmProvider: "",
    llmModel: "",
    llmReasoning: "",
  };

  it("accepts a valid request, normalizing the URL and trimming the note", () => {
    const result = validateCodeRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.fileUrl).toBe("https://example.com/tutor.yaml");
      expect(result.payload.validFrom).toEqual(new Date(1_700_000_000 * 1000));
      expect(result.payload.validUntil).toEqual(new Date(1_700_003_600 * 1000));
      expect(result.payload.note).toBe("My class");
    }
  });

  it("normalizes the file URL to URL.href (e.g. percent-encoding)", () => {
    const result = validateCodeRequest({ ...valid, file: " https://example.com/tütor.yaml " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.fileUrl).toBe("https://example.com/t%C3%BCtor.yaml");
  });

  it("treats a missing note as empty", () => {
    const result = validateCodeRequest({ ...valid, note: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.note).toBe("");
  });

  it("rejects an over-long file URL (the column is unbounded text; this is the cap)", () => {
    const file = `https://example.com/${"a".repeat(MAX_FILE_URL_LENGTH)}`;
    const result = validateCodeRequest({ ...valid, file });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("2048") });
  });

  it("rejects an over-long note", () => {
    const result = validateCodeRequest({ ...valid, note: "x".repeat(MAX_NOTE_LENGTH + 1) });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("200") });
  });

  it.each(["not a url", "ftp://example.com/t.yaml", "", undefined])(
    "rejects file input %j",
    (file) => {
      expect(validateCodeRequest({ ...valid, file }).ok).toBe(false);
    },
  );

  it("rejects a supplied timestamp that is non-numeric", () => {
    expect(validateCodeRequest({ ...valid, start: "12abc" }).ok).toBe(false);
    expect(validateCodeRequest({ ...valid, end: "12abc" }).ok).toBe(false);
  });

  it("rejects a window that ends before (or at) its start", () => {
    const result = validateCodeRequest({ ...valid, end: valid.start });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/after its start/) });
  });

  it("accepts a blank start as an open (null) lower bound", () => {
    const result = validateCodeRequest({ ...valid, start: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.validFrom).toBeNull();
      expect(result.payload.validUntil).toEqual(new Date(1_700_003_600 * 1000));
    }
  });

  it("accepts a blank end as an open (null) upper bound", () => {
    const result = validateCodeRequest({ ...valid, end: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.validFrom).toEqual(new Date(1_700_000_000 * 1000));
      expect(result.payload.validUntil).toBeNull();
    }
  });

  it("accepts both bounds blank as an always-valid (null/null) window", () => {
    const result = validateCodeRequest({ ...valid, start: "", end: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.validFrom).toBeNull();
      expect(result.payload.validUntil).toBeNull();
    }
  });

  it("treats blank LLM override fields as no override", () => {
    const result = validateCodeRequest(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.llm).toBeNull();
  });

  it("accepts a full LLM override pair, trimmed", () => {
    const result = validateCodeRequest({
      ...valid,
      llmProvider: " Azure Foundry ",
      llmModel: " gpt-5.4-mini ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.llm).toEqual({ provider: "Azure Foundry", model: "gpt-5.4-mini" });
    }
  });

  it("accepts an OpenRouter override pair", () => {
    const result = validateCodeRequest({
      ...valid,
      llmProvider: "OpenRouter",
      llmModel: "z-ai/glm-5.3-flash",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.llm).toEqual({ provider: "OpenRouter", model: "z-ai/glm-5.3-flash" });
    }
  });

  it("rejects an unknown override provider, naming the valid ones", () => {
    const result = validateCodeRequest({ ...valid, llmProvider: "OpenAI", llmModel: "gpt-4o" });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/SCCH.*Azure Foundry.*OpenRouter/),
    });
  });

  it("rejects a half-filled pair (both-or-nothing)", () => {
    expect(validateCodeRequest({ ...valid, llmProvider: "SCCH" }).ok).toBe(false);
    expect(validateCodeRequest({ ...valid, llmModel: "gpt-5.4-mini" }).ok).toBe(false);
  });

  it("rejects an over-long override model", () => {
    const result = validateCodeRequest({
      ...valid,
      llmProvider: "SCCH",
      llmModel: "x".repeat(MAX_LLM_MODEL_LENGTH + 1),
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("256") });
  });

  it("carries a reasoning level alongside the pair, trimmed", () => {
    const result = validateCodeRequest({
      ...valid,
      llmProvider: "Azure Foundry",
      llmModel: "gpt-5.6-terra",
      llmReasoning: " high ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.llm).toEqual({
        provider: "Azure Foundry",
        model: "gpt-5.6-terra",
        reasoning: "high",
      });
    }
  });

  it("omits a blank reasoning level from an otherwise full override", () => {
    const result = validateCodeRequest({ ...valid, llmProvider: "SCCH", llmModel: "gemma" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.llm).toEqual({ provider: "SCCH", model: "gemma" });
  });

  it("rejects a reasoning level without the override pair", () => {
    const result = validateCodeRequest({ ...valid, llmReasoning: "high" });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/provider and a model override/),
    });
  });

  it("rejects an unknown reasoning level, naming the levels", () => {
    const result = validateCodeRequest({
      ...valid,
      llmProvider: "SCCH",
      llmModel: "gemma",
      llmReasoning: "turbo",
    });
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringMatching(/minimal.*low.*medium.*high.*xhigh/),
    });
  });
});

describe("effectiveLlm", () => {
  const activityLlm = { provider: "SCCH" as const, model: "yaml-model" };

  it("returns the activity YAML's llm when the code has no override", () => {
    expect(effectiveLlm(entry(), activityLlm)).toEqual(activityLlm);
  });

  it("returns the code's override pair wholesale when set", () => {
    const withOverride = entry({ llm: { provider: "Azure Foundry", model: "gpt-5.4-mini" } });
    expect(effectiveLlm(withOverride, activityLlm)).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5.4-mini",
    });
  });

  it("carries the activity YAML's reasoning level when the code has no override", () => {
    expect(effectiveLlm(entry(), { ...activityLlm, reasoning: "medium" })).toEqual({
      ...activityLlm,
      reasoning: "medium",
    });
  });

  it("carries the override's own reasoning level when it has one", () => {
    const withOverride = entry({
      llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "high" },
    });
    expect(effectiveLlm(withOverride, { ...activityLlm, reasoning: "medium" })).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5.6-terra",
      reasoning: "high",
    });
  });

  // WHOLESALE: the override replaces the whole llm block, so a code that pins
  // only provider+model runs with NO reasoning effort — the YAML's level does
  // not leak through onto a different model.
  it("suppresses the activity YAML's reasoning level when the override has none", () => {
    const withOverride = entry({ llm: { provider: "SCCH", model: "gemma" } });
    expect(effectiveLlm(withOverride, { ...activityLlm, reasoning: "medium" })).toEqual({
      provider: "SCCH",
      model: "gemma",
    });
  });
});

describe("createCode", () => {
  const data = {
    module: "quiz" as const,
    fileUrl: "https://example.com/quiz.yaml",
    validFrom: new Date("2026-06-10T10:00:00Z"),
    validUntil: new Date("2026-06-10T14:00:00Z"),
    note: "My class",
    origin: "http://localhost:3000",
    anonymous: false,
    llm: null,
  };

  it("stores the row under the creating teacher and returns the code", async () => {
    const result = await createCode("teacher-sub-1", data);
    expect(result.stored).toBe(true);
    if (result.stored) expect(result.code).toMatch(/^[a-z0-9]{10}$/);
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0]).toMatchObject({
      module: "quiz",
      createdBy: "teacher-sub-1",
      fileUrl: data.fileUrl,
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      note: "My class",
      origin: "http://localhost:3000",
      // The activity's anonymity flag is frozen onto the row at create time.
      anonymous: false,
      // No LLM override → all three columns NULL.
      llmProvider: null,
      llmModel: null,
      llmReasoning: null,
    });
    expect(fake.state.inserted[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("stores the LLM override pair in the two columns", async () => {
    const result = await createCode("teacher-sub-1", {
      ...data,
      llm: { provider: "Azure Foundry", model: "gpt-5.4-mini" },
    });
    expect(result.stored).toBe(true);
    expect(fake.state.inserted[0]).toMatchObject({
      llmProvider: "Azure Foundry",
      llmModel: "gpt-5.4-mini",
      // No level on the override → the third column stays NULL.
      llmReasoning: null,
    });
  });

  it("stores an override's reasoning level in the third column", async () => {
    const result = await createCode("teacher-sub-1", {
      ...data,
      llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "high" },
    });
    expect(result.stored).toBe(true);
    expect(fake.state.inserted[0]).toMatchObject({
      llmProvider: "Azure Foundry",
      llmModel: "gpt-5.6-terra",
      llmReasoning: "high",
    });
  });

  it("retries with a fresh code on a duplicate-key error", async () => {
    fake.state.insertErrors = [duplicateKeyError()];
    const result = await createCode("teacher-sub-1", data);
    expect(result.stored).toBe(true);
    expect(fake.state.inserted).toHaveLength(1); // second attempt landed
  });

  it("returns { stored: false } instead of throwing on other database errors", async () => {
    fake.state.insertErrors = [new Error("connection lost")];
    await expect(createCode("teacher-sub-1", data)).resolves.toEqual({ stored: false });
  });
});

describe("checkCode", () => {
  it("rejects malformed codes without a database round-trip", async () => {
    fake.state.selectError = new Error("must not be reached");
    await expect(checkCode("NOT_A_CODE", NOW)).resolves.toEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("reports unknown-code when no row matches", async () => {
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("accepts a code whose window contains now (bounds inclusive)", async () => {
    const row = entry({ validFrom: NOW, validUntil: NOW });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({ ok: true, entry: row });
  });

  it("reports not-started carrying only the start bound", async () => {
    const row = entry({ validFrom: new Date(NOW.getTime() + 1000) });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({
      ok: false,
      reason: "not-started",
      validFrom: row.validFrom,
    });
  });

  it("reports expired carrying only the end bound", async () => {
    const row = entry({ validUntil: new Date(NOW.getTime() - 1000) });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({
      ok: false,
      reason: "expired",
      validUntil: row.validUntil,
    });
  });

  it("treats a null start as open: never not-started, even before the end", async () => {
    const row = entry({ validFrom: null, validUntil: new Date(NOW.getTime() + 1000) });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({ ok: true, entry: row });
  });

  it("treats a null end as open: never expired, even after the start", async () => {
    const row = entry({ validFrom: new Date(NOW.getTime() - 1000), validUntil: null });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({ ok: true, entry: row });
  });

  it("accepts an always-valid code (both bounds null)", async () => {
    const row = entry({ validFrom: null, validUntil: null });
    fake.state.rows = [toRow(row)];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({ ok: true, entry: row });
  });

  it("reports lookup-failed instead of throwing when the database is down", async () => {
    fake.state.selectError = new Error("connection lost");
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({
      ok: false,
      reason: "lookup-failed",
    });
  });
});

describe("listCodes", () => {
  it("returns all rows unpaged, without a COUNT or a LIMIT/OFFSET", async () => {
    const rows = [entry(), entry({ code: "f6g7h8i9j0", createdBy: "another-teacher" })];
    fake.state.rows = rows.map(toRow);
    await expect(listCodes()).resolves.toEqual({ rows, total: 2, page: 1, pageSize: 2 });
    expect(fake.state.windows).toEqual([]);
  });

  it("carries the owner's display name from the join — null when there is none", async () => {
    const named = entry();
    const unnamed = entry({ code: "f6g7h8i9j0", createdBy: "cli-only-teacher" });
    fake.state.rows = [
      { ...toRow(named), ownerName: "Alex Muster" },
      // A teacher who has never signed in through the web app has no
      // `novedu_user` row; the page falls back to the raw oid.
      { ...toRow(unnamed), ownerName: null },
    ];
    const result = await listCodes();
    expect(result?.rows).toEqual([
      { ...named, ownerName: "Alex Muster" },
      { ...unnamed, ownerName: null },
    ]);
  });

  it("returns the rows the fake db yields when filters are supplied", async () => {
    // The fake doesn't execute SQL — it just confirms the call shape resolves to
    // the configured rows (the WHERE/LIKE itself is covered by the @live e2e).
    const rows = [entry({ note: "linked lists" })];
    fake.state.rows = rows.map(toRow);
    const result = await listCodes({
      search: "linked",
      createdBy: "teacher-sub-1",
      module: "tutor",
    });
    expect(result?.rows).toEqual(rows);
  });

  it("pushes the skip and the limit into SQL and reports the DB-side total", async () => {
    fake.state.rows = [toRow(entry())];
    fake.state.total = 137;

    const result = await listCodes({ paging: { page: 3, pageSize: 20 } });

    expect(fake.state.windows).toEqual([{ offset: 40, limit: 20 }]);
    expect(result).toMatchObject({ total: 137, page: 3, pageSize: 20 });
  });

  it("returns undefined instead of throwing when the database is down", async () => {
    fake.state.selectError = new Error("connection lost");
    await expect(listCodes()).resolves.toBeUndefined();
  });

  it("lets an explicit sort replace the default order, keeping the tiebreaker last", async () => {
    await listCodes({ sort: { key: "note", dir: "asc" } });
    expect(fake.state.order).toEqual([asc(codes.note), asc(codes.code)]);

    await listCodes();
    expect(fake.state.order).toEqual([desc(codes.createdAt), asc(codes.code)]);
  });
});

// Renders a condition the way Postgres receives it: SQL text plus parameters.
const render = (condition: unknown) => new PgDialect().sqlToQuery(condition as never);

describe("listCodes filters (new list)", () => {
  it("puts the multi-activity and status filters into BOTH the COUNT and the rows", async () => {
    await listCodes({
      modules: ["tutor", "quiz"],
      statuses: ["expired"],
      now: NOW,
      paging: { page: 1, pageSize: 20 },
    });

    expect(fake.state.wheres).toHaveLength(2);
    for (const where of fake.state.wheres) {
      const { sql, params } = render(where);
      expect(sql).toContain('"novedu_codes"."module" in ($5, $6)');
      expect(sql).toContain('"novedu_codes"."valid_until" < $');
      expect(params).toEqual(expect.arrayContaining(["tutor", "quiz", NOW.toISOString()]));
    }
  });

  it("adds no condition for an empty activity or status list", async () => {
    await listCodes({ modules: [], statuses: [] });
    const { sql } = render(fake.state.wheres[0]);
    // Only the known-module guard remains.
    expect(sql).toBe('"novedu_codes"."module" in ($1, $2, $3, $4)');
  });
});

describe("listCodes model and usage columns", () => {
  const rowQuery = () => fake.state.selects.find((fields) => fields && !("n" in fields));

  it("reads no usage unless asked for the billed tokens", async () => {
    await listCodes({ sort: { key: "tokens", dir: "desc" } });
    expect(rowQuery()).not.toHaveProperty("billedTokens");
    // `tokens` is no sort key without them: the default order applies.
    expect(fake.state.order).toEqual([desc(codes.createdAt), asc(codes.code)]);
  });

  it("selects and sorts by the billed tokens when asked", async () => {
    const since = new Date("2026-09-18T12:00:00Z");
    fake.state.rows = [{ ...toRow(entry()), ownerName: null, billedTokens: 1234 }];
    const result = await listCodes({
      billedTokensSince: since,
      sort: { key: "tokens", dir: "desc" },
    });
    expect(result?.rows[0]?.billedTokens).toBe(1234);
    const { sql, params } = render(rowQuery()?.billedTokens);
    expect(sql).toContain('"novedu_usage_by_code"."code" = "novedu_codes"."code"');
    expect(sql).toContain("COALESCE(SUM(");
    expect(params).toEqual(["OpenRouter", since]);
    expect(render(fake.state.order[0]).sql).toMatch(/^\(SELECT COALESCE.* desc$/);
  });

  it("billedTokensSince bounds the sum by provider and hour", () => {
    const flat = render(billedTokensSince(NOW)).sql.replace(/[()]/g, "");
    expect(flat).toContain('"novedu_usage_by_code"."provider" = $1');
    expect(flat).toContain('"novedu_usage_by_code"."hour" >= $2');
  });

  it("orders a usable override before the YAML default, as toLlmOverride reads it", () => {
    const { sql, params } = render(LLM_SOURCE_ORDER);
    expect(sql).toMatch(/^CASE WHEN "novedu_codes"\."llm_provider" in \(\$1, \$2, \$3\)/);
    expect(sql).toContain(
      `"novedu_codes"."llm_model" IS NOT NULL AND "novedu_codes"."llm_model" <> ''`,
    );
    expect(sql).toContain("THEN 0 ELSE 1 END");
    expect(params).toEqual(["SCCH", "Azure Foundry", "OpenRouter"]);
  });
});

describe("windowStatusCondition", () => {
  // Drizzle wraps every operand in parentheses; comparing without them keeps the
  // assertions readable (the e2e list spec runs the real query).
  const flat = (condition: unknown) => render(condition).sql.replace(/[()]/g, "");
  const from = '"novedu_codes"."valid_from"';
  const until = '"novedu_codes"."valid_until"';

  it("filters nothing for none or all three states", () => {
    expect(windowStatusCondition([], NOW)).toBeUndefined();
    expect(windowStatusCondition(["active", "upcoming", "expired"], NOW)).toBeUndefined();
  });

  it("reads open bounds and inclusive bounds the way the badge does", () => {
    const started = `${from} is null or ${from} <= $1`;
    expect(flat(windowStatusCondition(["upcoming"], NOW))).toBe(`${from} > $1`);
    expect(flat(windowStatusCondition(["expired"], NOW))).toBe(`${started} and ${until} < $2`);
    expect(flat(windowStatusCondition(["active"], NOW))).toBe(
      `${started} and ${until} is null or ${until} >= $2`,
    );
  });

  it("ORs several states, each judged against the same now", () => {
    const { sql, params } = render(windowStatusCondition(["active", "upcoming"], NOW));
    expect(sql.replace(/[()]/g, "")).toMatch(/ or "novedu_codes"\."valid_from" > \$3$/);
    expect(new Set(params)).toEqual(new Set([NOW.toISOString()]));
  });
});

describe("getCode", () => {
  it("returns the row regardless of who created it (no ownership check)", async () => {
    const row = entry({ createdBy: "another-teacher" });
    fake.state.rows = [toRow(row)];
    await expect(getCode("a1b2c3d4e5")).resolves.toEqual(row);
  });

  it("returns null for an unknown code", async () => {
    fake.state.rows = [];
    await expect(getCode("a1b2c3d4e5")).resolves.toBeNull();
  });

  it("rejects a malformed code without a database round-trip", async () => {
    fake.state.selectError = new Error("must not be reached");
    await expect(getCode("NOT A CODE")).resolves.toBeNull();
  });

  it("returns undefined instead of throwing when the database is down", async () => {
    fake.state.selectError = new Error("connection lost");
    await expect(getCode("a1b2c3d4e5")).resolves.toBeUndefined();
  });
});

describe("listCodeOwners", () => {
  it("maps the distinct owner rows to dropdown options", async () => {
    fake.state.rows = [
      { userId: "oid-1", label: "Alex Muster" },
      // No display name: `lib/db/owners.ts` COALESCEs the oid into the label, so
      // the option is still selectable and still sorts into the alphabet.
      { userId: "oid-2", label: "oid-2" },
    ];
    await expect(listCodeOwners()).resolves.toEqual([
      { userId: "oid-1", label: "Alex Muster" },
      { userId: "oid-2", label: "oid-2" },
    ]);
  });

  it("returns an empty list instead of throwing when the database is down", async () => {
    // The page then renders just the "me" and "all owners" entries.
    fake.state.selectError = new Error("connection lost");
    await expect(listCodeOwners()).resolves.toEqual([]);
  });
});

describe("unknown module (forward-compat / corrupt row)", () => {
  // A row whose module is not a known CodeModule — e.g. a module written to the DB
  // before its registry entry exists, or a corrupt row. The store treats it as
  // ABSENT so no consumer ever indexes the module registry with an unknown key.
  const unknownRow = { ...toRow(entry()), module: "future-module" };

  it("checkCode reports unknown-code (never a half-built entry)", async () => {
    fake.state.rows = [unknownRow];
    await expect(checkCode("a1b2c3d4e5", NOW)).resolves.toEqual({
      ok: false,
      reason: "unknown-code",
    });
  });

  it("getCode returns null", async () => {
    fake.state.rows = [unknownRow];
    await expect(getCode("a1b2c3d4e5")).resolves.toBeNull();
  });

  // For the LIST the module check is a WHERE condition (`inArray`), so a row like
  // this never comes back at all — which is what keeps a page's rows and its
  // COUNT in agreement. The post-query filter below it stays as belt-and-braces;
  // this fake ignores the WHERE, so it is what actually drops the row here.
  it("listCodes drops the row instead of yielding an unknown module", async () => {
    fake.state.rows = [toRow(entry()), unknownRow, toRow(entry({ code: "f6g7h8i9j0" }))];
    const result = await listCodes();
    expect(result?.rows).toHaveLength(2);
    expect(result?.rows.every((e) => e.module === "tutor")).toBe(true);
  });
});

describe("LLM override on read", () => {
  it("maps the two columns to the entry's llm pair", async () => {
    const row = entry({ llm: { provider: "Azure Foundry", model: "gpt-5.4-mini" } });
    fake.state.rows = [toRow(row)];
    await expect(getCode("a1b2c3d4e5")).resolves.toEqual(row);
  });

  it("maps the third column to the override's reasoning level", async () => {
    const row = entry({
      llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "high" },
    });
    fake.state.rows = [toRow(row)];
    await expect(getCode("a1b2c3d4e5")).resolves.toEqual(row);
  });

  // A corrupt reasoning level is the MILDER corruption: the pair still means
  // something on its own, so it survives and only the level is dropped (the code
  // then runs at the model's default effort instead of failing).
  it("keeps the pair but drops an invalid stored reasoning level", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stored = entry({ llm: { provider: "SCCH", model: "gemma" } });
      fake.state.rows = [{ ...toRow(stored), llmReasoning: "turbo" }];
      await expect(getCode("a1b2c3d4e5")).resolves.toEqual(stored);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Only the validated actions write the pair, so a lone half or an unknown
  // provider is a corrupt row: the store logs it and treats it as NO override,
  // keeping the code usable on the activity YAML's own llm values.
  it.each([
    { llmProvider: "SCCH", llmModel: null },
    { llmProvider: null, llmModel: "gpt-5.4-mini" },
    { llmProvider: "OpenAI", llmModel: "gpt-4o" },
  ])("treats a corrupt stored pair %j as no override", async (columns) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.state.rows = [{ ...toRow(entry()), ...columns }];
      await expect(getCode("a1b2c3d4e5")).resolves.toEqual(entry({ llm: null }));
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("updateCode", () => {
  const data = {
    validFrom: new Date("2026-07-01T08:00:00Z"),
    validUntil: new Date("2026-07-01T10:00:00Z"),
    note: "edited",
    llm: null,
  };

  it("updates only the window + note + LLM override (never the url/anonymous/createdBy)", async () => {
    await expect(updateCode("a1b2c3d4e5", data)).resolves.toEqual({ ok: true });
    expect(fake.state.updated).toHaveLength(1);
    expect(fake.state.updated[0]).toEqual({
      validFrom: data.validFrom,
      validUntil: data.validUntil,
      note: "edited",
      // A null override CLEARS all three columns (it is set/cleared as a whole).
      llmProvider: null,
      llmModel: null,
      llmReasoning: null,
    });
  });

  it("stores an override pair into the two columns", async () => {
    await expect(
      updateCode("a1b2c3d4e5", { ...data, llm: { provider: "SCCH", model: "some-model" } }),
    ).resolves.toEqual({ ok: true });
    expect(fake.state.updated[0]).toMatchObject({
      llmProvider: "SCCH",
      llmModel: "some-model",
      // An override without a level clears the column too.
      llmReasoning: null,
    });
  });

  it("stores an override's reasoning level into the third column", async () => {
    await expect(
      updateCode("a1b2c3d4e5", {
        ...data,
        llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "low" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fake.state.updated[0]).toMatchObject({
      llmProvider: "Azure Foundry",
      llmModel: "gpt-5.6-terra",
      llmReasoning: "low",
    });
  });

  it("reports not-found for a malformed code without a database round-trip", async () => {
    fake.state.updateError = new Error("must not be reached");
    await expect(updateCode("NOT A CODE", data)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("reports not-found when no row was affected", async () => {
    fake.state.updateRowCount = 0;
    await expect(updateCode("a1b2c3d4e5", data)).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("reports an error instead of throwing when the database is down", async () => {
    fake.state.updateError = new Error("connection lost");
    await expect(updateCode("a1b2c3d4e5", data)).resolves.toEqual({
      ok: false,
      reason: "error",
    });
  });
});
