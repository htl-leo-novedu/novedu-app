import { beforeEach, describe, expect, it, vi } from "vitest";

// Behavior-level tests for the stats/delete store. The two I/O seams — the
// Drizzle handle (`@/lib/db`) and the Mastra store (`@/app/mastra`) — are faked;
// the real logic under test is the by-value SQL result handling, the Mastra
// v2 → AG-UI message CONVERSION (the part with the most branches), the stats
// aggregation, and the delete ORDERING. No database, runs in CI.

const fake = vi.hoisted(() => {
  const state = {
    rows: [] as Record<string, unknown>[],
    executeError: undefined as unknown,
    executeCalls: 0,
    deleteError: undefined as unknown,
    // The drizzle table objects passed to db.delete(), in call order — so a test
    // can assert WHICH tables were deleted and in what sequence. A row lock
    // (`SELECT … FOR <strength>`) lands here too, as `"lock <table> for <strength>"`.
    deletedTables: [] as unknown[],
    // The codes the row lock was asked to order by (asserted: code order).
    lockedTables: [] as unknown[],
  };
  const db = {
    execute: async () => {
      state.executeCalls += 1;
      if (state.executeError) throw state.executeError;
      return { rows: state.rows };
    },
    delete: (table: unknown) => ({
      where: async () => {
        state.deletedTables.push(table);
        if (state.deleteError) throw state.deleteError;
      },
    }),
    // The bulk delete batches its row deletes in one transaction; the executor it
    // hands the callback is the same delete-tracking handle, so a thrown delete
    // rejects the transaction (the all-or-nothing rollback the real DB gives).
    transaction: async (cb: (t: unknown) => unknown) => cb(db),
    // The delete's `SELECT code FROM novedu_codes … ORDER BY code FOR UPDATE`.
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({
            for: async (strength: string) => {
              state.lockedTables.push(table);
              state.deletedTables.push(`lock for ${strength}`);
              return [];
            },
          }),
        }),
      }),
    }),
  };
  return { state, db };
});

const mastra = vi.hoisted(() => {
  const state = {
    threads: [] as { id: string }[],
    deletedThreadIds: [] as string[],
    storageNull: false,
    listThreadsError: undefined as unknown,
  };
  const memory = {
    listThreads: async () => {
      if (state.listThreadsError) throw state.listThreadsError;
      return { threads: state.threads };
    },
    deleteThread: async ({ threadId }: { threadId: string }) => {
      state.deletedThreadIds.push(threadId);
    },
  };
  const storage = { getStore: async () => memory };
  return {
    state,
    mastra: { getStorage: () => (state.storageNull ? undefined : storage) },
  };
});

vi.mock("@/lib/db", () => ({ getDb: () => fake.db }));
vi.mock("@/app/mastra", () => ({ mastra: mastra.mastra }));

import {
  deleteCodesAndData,
  getCodeStats,
  getConversationMessages,
  getInteractionCounts,
} from "@/lib/code-stats-store";
import {
  clozeGapCounts,
  codes,
  codingKeys,
  quizResults,
  recentCodes,
  reports,
  userChats,
  writingSubmissions,
} from "@/lib/db/schema";

// Convenience: the stored v2 message envelope, JSON-stringified into a row.
function row(id: string, role: string, content: unknown): Record<string, unknown> {
  return { id, role, content: JSON.stringify(content) };
}

beforeEach(() => {
  fake.state.rows = [];
  fake.state.executeError = undefined;
  fake.state.executeCalls = 0;
  fake.state.deleteError = undefined;
  fake.state.deletedTables = [];
  fake.state.lockedTables = [];
  mastra.state.threads = [];
  mastra.state.deletedThreadIds = [];
  mastra.state.storageNull = false;
  mastra.state.listThreadsError = undefined;
});

describe("getInteractionCounts", () => {
  it("returns an empty map without querying when given no codes", async () => {
    await expect(getInteractionCounts([])).resolves.toEqual(new Map());
    expect(fake.state.executeCalls).toBe(0);
  });

  it("maps the aggregate rows to a code → count map", async () => {
    fake.state.rows = [
      { code: "aaaaaaaaaa", interactions: 3 },
      { code: "bbbbbbbbbb", interactions: 1 },
    ];
    const counts = await getInteractionCounts(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(counts).toEqual(
      new Map([
        ["aaaaaaaaaa", 3],
        ["bbbbbbbbbb", 1],
      ]),
    );
    // A code with no conversations is simply absent (caller defaults it to 0).
    expect(counts?.has("cccccccccc")).toBe(false);
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getInteractionCounts(["aaaaaaaaaa"])).resolves.toBeUndefined();
  });
});

describe("getCodeStats", () => {
  it("counts conversations and distinct students, mapping each interaction (non-anonymous)", async () => {
    const t1 = new Date("2026-06-12T10:00:00Z");
    const t2 = new Date("2026-06-12T10:05:00Z");
    // Raw execute() rows arrive with the wire strings for timestamps and SUM —
    // the store must hand back real Dates and numbers.
    const raw1 = "2026-06-12 10:00:00+00";
    const raw2 = "2026-06-12 10:05:00+00";
    fake.state.rows = [
      { threadId: "th1", firstAt: raw1, lastAt: raw2, userMessageCount: "3", userId: "stu-1" },
      // Same student, a second conversation — must count as one student.
      { threadId: "th2", firstAt: t1, lastAt: t2, userMessageCount: 1, userId: "stu-1" },
      { threadId: "th3", firstAt: t1, lastAt: t2, userMessageCount: 2, userId: "stu-2" },
      // Anonymous conversation (no recorded user) — counts toward no student.
      { threadId: "th4", firstAt: t1, lastAt: t2, userMessageCount: 1, userId: null },
    ];
    const stats = await getCodeStats("aaaaaaaaaa", false);
    expect(stats?.conversations).toBe(4);
    expect(stats?.studentCount).toBe(2);
    expect(stats?.interactions[0]).toEqual({
      threadId: "th1",
      firstAt: t1,
      lastAt: t2,
      userMessageCount: 3,
      userId: "stu-1",
      // No name recorded for this row → null (the UI falls back to the oid).
      userName: null,
    });
    expect(stats?.interactions[3]?.userId).toBeNull();
  });

  it("surfaces the joined display name (non-anonymous), and redacts it for an anonymous code", async () => {
    const t1 = new Date("2026-06-12T10:00:00Z");
    const t2 = new Date("2026-06-12T10:05:00Z");
    const row = {
      threadId: "th1",
      firstAt: t1,
      lastAt: t2,
      userMessageCount: 3,
      userId: "stu-1",
      userName: "Ada Lovelace",
    };
    fake.state.rows = [row];
    expect((await getCodeStats("aaaaaaaaaa", false))?.interactions[0]?.userName).toBe(
      "Ada Lovelace",
    );
    // Anonymous → the name is nulled at the data layer alongside the id.
    fake.state.rows = [row];
    const anon = await getCodeStats("aaaaaaaaaa", true);
    expect(anon?.interactions[0]?.userName).toBeNull();
    expect(anon?.interactions[0]?.userId).toBeNull();
  });

  it("redacts every userId and zeroes studentCount for an anonymous code", async () => {
    // The privacy gate at the DATA LAYER: even if novedu_user_chats holds rows
    // for this code (e.g. the YAML was toggled non-anonymous after the code was
    // minted), an anonymous code must never surface who a student is.
    const t1 = new Date("2026-06-12T10:00:00Z");
    const t2 = new Date("2026-06-12T10:05:00Z");
    fake.state.rows = [
      { threadId: "th1", firstAt: t1, lastAt: t2, userMessageCount: 3, userId: "stu-1" },
      { threadId: "th2", firstAt: t1, lastAt: t2, userMessageCount: 2, userId: "stu-2" },
    ];
    const stats = await getCodeStats("aaaaaaaaaa", true);
    // Conversations and message counts are still reported — only the identity goes.
    expect(stats?.conversations).toBe(2);
    expect(stats?.studentCount).toBe(0);
    expect(stats?.interactions.map((i) => i.userId)).toEqual([null, null]);
    expect(stats?.interactions[0]?.userMessageCount).toBe(3);
  });

  it("returns zeroes for a code with no conversations", async () => {
    fake.state.rows = [];
    await expect(getCodeStats("aaaaaaaaaa", false)).resolves.toEqual({
      conversations: 0,
      studentCount: 0,
      interactions: [],
    });
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getCodeStats("aaaaaaaaaa", false)).resolves.toBeUndefined();
  });
});

describe("getConversationMessages — Mastra v2 → AG-UI conversion", () => {
  const CODE = "aaaaaaaaaa";
  const THREAD = "thread-1";

  it("converts a text-only user message to a plain string content", async () => {
    fake.state.rows = [
      row("m1", "user", { format: 2, parts: [{ type: "text", text: "Hi" }], content: "Hi" }),
    ];
    await expect(getConversationMessages(CODE, THREAD)).resolves.toEqual([
      { id: "m1", role: "user", content: "Hi" },
    ]);
  });

  it("rebuilds assistant text from parts even when the top-level content is absent", async () => {
    // Some stored rows have no top-level `content` — the text lives only in parts.
    fake.state.rows = [
      row("m1", "assistant", { format: 2, parts: [{ type: "text", text: "Hello there" }] }),
    ];
    await expect(getConversationMessages(CODE, THREAD)).resolves.toEqual([
      { id: "m1", role: "assistant", content: "Hello there" },
    ]);
  });

  it("concatenates multiple text parts", async () => {
    fake.state.rows = [
      row("m1", "assistant", {
        parts: [
          { type: "text", text: "foo" },
          { type: "text", text: "bar" },
        ],
      }),
    ];
    const messages = await getConversationMessages(CODE, THREAD);
    expect(messages?.[0]).toEqual({ id: "m1", role: "assistant", content: "foobar" });
  });

  it("maps an image (file) part on a user message to an inline image part", async () => {
    const dataUrl = "data:image/png;base64,AAAA";
    fake.state.rows = [
      row("m1", "user", {
        parts: [
          { type: "text", text: "what colour?" },
          { type: "file", data: dataUrl },
        ],
      }),
    ];
    await expect(getConversationMessages(CODE, THREAD)).resolves.toEqual([
      {
        id: "m1",
        role: "user",
        content: [
          { type: "text", text: "what colour?" },
          { type: "image", source: { type: "url", value: dataUrl } },
        ],
      },
    ]);
  });

  it("emits image-only content when a user message has a file part but no text", async () => {
    const dataUrl = "data:image/png;base64,BBBB";
    fake.state.rows = [row("m1", "user", { parts: [{ type: "file", data: dataUrl }] })];
    const messages = await getConversationMessages(CODE, THREAD);
    expect(messages?.[0]).toEqual({
      id: "m1",
      role: "user",
      content: [{ type: "image", source: { type: "url", value: dataUrl } }],
    });
  });

  it("skips messages whose content is not valid JSON", async () => {
    fake.state.rows = [
      { id: "bad", role: "user", content: "not json{" },
      row("m1", "user", { parts: [{ type: "text", text: "ok" }] }),
    ];
    const messages = await getConversationMessages(CODE, THREAD);
    expect(messages).toEqual([{ id: "m1", role: "user", content: "ok" }]);
  });

  it("skips roles that are not part of a tutor chat (system/tool/…)", async () => {
    fake.state.rows = [
      row("sys", "system", { parts: [{ type: "text", text: "system prompt" }] }),
      row("m1", "assistant", { parts: [{ type: "text", text: "answer" }] }),
    ];
    const messages = await getConversationMessages(CODE, THREAD);
    expect(messages).toEqual([{ id: "m1", role: "assistant", content: "answer" }]);
  });

  it("rejects a malformed thread id without querying", async () => {
    await expect(getConversationMessages(CODE, "bad id with spaces")).resolves.toEqual([]);
    expect(fake.state.executeCalls).toBe(0);
  });

  it("returns undefined instead of throwing when the query fails", async () => {
    fake.state.executeError = new Error("connection lost");
    await expect(getConversationMessages(CODE, THREAD)).resolves.toBeUndefined();
  });
});

describe("getConversationMessages collapses replays end to end", () => {
  it("returns each turn once for a telescoping result set", async () => {
    const text = (role: string, content: string) =>
      row(crypto.randomUUID(), role, { parts: [{ type: "text", text: content }], content });
    fake.state.rows = [
      text("user", "hi"),
      text("assistant", "hello"),
      text("user", "hi"),
      text("assistant", "hello"),
      text("user", "q2"),
      text("assistant", "ans2"),
    ];
    const messages = await getConversationMessages("aaaaaaaaaa", "thread-1");
    expect(messages?.map((m) => m.content)).toEqual(["hi", "hello", "q2", "ans2"]);
  });
});

// Bulk delete (the list's "Delete Selected", the only way to delete a code):
// conversations per code (Mastra), then ALL the app rows in ONE transaction — the
// selection's coding API keys batched first, then each code's own rows. These pin
// the batch contract — the row ordering, the all-or-nothing rollback, the
// Mastra-failure-but-rows-still-attempted paths (storage unavailable AND listThreads
// throwing), and the empty short-circuit.
describe("deleteCodesAndData", () => {
  it("deletes each code's conversations then all app rows (per code) and reports success", async () => {
    mastra.state.threads = [{ id: "th1" }];
    const result = await deleteCodesAndData(["aaaaaaaaaa", "bbbbbbbbbb"]);
    expect(result).toEqual({ ok: true, deleted: 2 });
    // One thread listed+deleted per code (the fake lists the same set each time).
    expect(mastra.state.deletedThreadIds).toEqual(["th1", "th1"]);
    // All in one transaction: the selected code rows locked FOR UPDATE first
    // (so a concurrent quiz-result save, holding its row FOR SHARE, finishes or
    // finds the code gone), the selection's coding keys in ONE batched
    // statement, then the same delete-safe order repeated once per code.
    expect(fake.state.lockedTables).toEqual([codes]);
    expect(fake.state.deletedTables).toEqual([
      "lock for update",
      codingKeys,
      userChats,
      recentCodes,
      writingSubmissions,
      reports,
      quizResults,
      clozeGapCounts,
      codes,
      userChats,
      recentCodes,
      writingSubmissions,
      reports,
      quizResults,
      clozeGapCounts,
      codes,
    ]);
  });

  it("reports failure with deleted 0 when an app-row delete throws", async () => {
    fake.state.deleteError = new Error("connection lost");
    await expect(deleteCodesAndData(["aaaaaaaaaa", "bbbbbbbbbb"])).resolves.toEqual({
      ok: false,
      deleted: 0,
    });
  });

  it("reports failure when conversations can't be removed, but still deletes the rows", async () => {
    mastra.state.storageNull = true;
    const result = await deleteCodesAndData(["aaaaaaaaaa", "bbbbbbbbbb"]);
    expect(result).toEqual({ ok: false, deleted: 2 });
    expect(fake.state.deletedTables).toEqual([
      "lock for update",
      codingKeys,
      userChats,
      recentCodes,
      writingSubmissions,
      reports,
      quizResults,
      clozeGapCounts,
      codes,
      userChats,
      recentCodes,
      writingSubmissions,
      reports,
      quizResults,
      clozeGapCounts,
      codes,
    ]);
  });

  it("reports failure (but still deletes the rows) when listing threads throws", async () => {
    mastra.state.listThreadsError = new Error("mastra down");
    const result = await deleteCodesAndData(["aaaaaaaaaa"]);
    expect(result).toEqual({ ok: false, deleted: 1 });
    expect(mastra.state.deletedThreadIds).toEqual([]);
    expect(fake.state.deletedTables).toEqual([
      "lock for update",
      codingKeys,
      userChats,
      recentCodes,
      writingSubmissions,
      reports,
      quizResults,
      clozeGapCounts,
      codes,
    ]);
  });

  it("short-circuits an empty selection without touching Mastra or the database", async () => {
    fake.state.deleteError = new Error("must not be reached");
    await expect(deleteCodesAndData([])).resolves.toEqual({ ok: true, deleted: 0 });
    expect(mastra.state.deletedThreadIds).toEqual([]);
    expect(fake.state.deletedTables).toEqual([]);
  });
});
