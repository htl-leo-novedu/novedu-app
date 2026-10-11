import { and, eq, inArray, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake drizzle handle for the grant store's three shapes:
// select().from().where(), insert().values().onConflictDoNothing().returning(),
// update().set().where(). Plus a raw `execute` for the facts store.
const fake = vi.hoisted(() => {
  const state = {
    selectRows: [] as unknown[],
    returning: [] as unknown[],
    executeRows: [] as unknown[],
    error: undefined as unknown,
    inserted: [] as unknown[],
    updateSet: undefined as unknown,
    updateWhere: undefined as unknown,
    selectWhere: [] as unknown[],
  };
  const fail = <T>(value: T) =>
    state.error ? Promise.reject(state.error) : Promise.resolve(value);
  const db = {
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          state.selectWhere.push(where);
          return fail(state.selectRows);
        },
      }),
    }),
    insert: () => ({
      values: (values: unknown[]) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            state.inserted = values;
            return fail(state.returning);
          },
        }),
      }),
    }),
    update: () => ({
      set: (set: unknown) => ({
        where: (where: unknown) => {
          state.updateSet = set;
          state.updateWhere = where;
          return fail(undefined);
        },
      }),
    }),
    execute: () => fail({ rows: state.executeRows }),
  };
  return { state, db };
});

const recordError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ getDb: () => fake.db }));
vi.mock("@/lib/telemetry", () => ({ recordError }));

import { insertGrants, listGrants, markSeen } from "@/lib/achievement-store";
import { listOwnKeyDates } from "@/lib/coding-key-store";
import { achievements } from "@/lib/db/schema";
import { loadStudentUsage } from "@/lib/student-facts-store";

/** A Drizzle-shaped failure whose message embeds SQL parameters (user id, counts). */
function drizzleError() {
  const cause = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  return Object.assign(new Error("Failed query: select … params: user-secret-id,42"), { cause });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.assign(fake.state, {
    selectRows: [],
    returning: [],
    executeRows: [],
    error: undefined,
    inserted: [],
    updateSet: undefined,
    updateWhere: undefined,
    selectWhere: [],
  });
});

describe("achievement-store", () => {
  it("lists the user's grants", async () => {
    const rows = [{ id: "a-1", qualifiedOn: "2026-09-01", seenAt: null }];
    fake.state.selectRows = rows;
    await expect(listGrants("u1")).resolves.toEqual(rows);
    expect(fake.state.selectWhere).toEqual([eq(achievements.userId, "u1")]);
  });

  it("inserts new grants for the session user and returns existing + inserted", async () => {
    const existing = [{ id: "a-1", qualifiedOn: "2026-09-01", seenAt: new Date() }];
    const inserted = { id: "a-2", qualifiedOn: "2026-09-02", seenAt: null };
    fake.state.returning = [inserted];
    await expect(
      insertGrants("u1", [{ id: "a-2", qualifiedOn: "2026-09-02" }], existing),
    ).resolves.toEqual([...existing, inserted]);
    expect(fake.state.inserted).toEqual([
      { userId: "u1", achievementId: "a-2", qualifiedOn: "2026-09-02" },
    ]);
  });

  it("re-reads the stored rows when a concurrent load inserted some first", async () => {
    const stored = [
      { id: "a-1", qualifiedOn: "2026-09-01", seenAt: null },
      { id: "a-2", qualifiedOn: "2026-09-02", seenAt: null },
    ];
    fake.state.returning = [stored[1]];
    fake.state.selectRows = stored;
    const result = await insertGrants(
      "u1",
      [
        { id: "a-1", qualifiedOn: "2026-09-01" },
        { id: "a-2", qualifiedOn: "2026-09-02" },
      ],
      [],
    );
    expect(result).toEqual(stored);
    expect(fake.state.selectWhere).toEqual([eq(achievements.userId, "u1")]);
  });

  it("needs no statement when nothing is new", async () => {
    const existing = [{ id: "a-1", qualifiedOn: "2026-09-01", seenAt: null }];
    fake.state.error = new Error("must not run");
    await expect(insertGrants("u1", [], existing)).resolves.toEqual(existing);
  });

  it("marks only the session user's unseen rows of the given ids", async () => {
    await expect(markSeen("u1", ["a-1", "a-2"])).resolves.toBe(true);
    expect(fake.state.updateSet).toEqual({ seenAt: expect.any(Date) });
    expect(fake.state.updateWhere).toEqual(
      and(
        eq(achievements.userId, "u1"),
        inArray(achievements.achievementId, ["a-1", "a-2"]),
        isNull(achievements.seenAt),
      ),
    );
  });
});

describe("student-facts-store", () => {
  it("maps the usage rows (string sums from Postgres) to usage days", async () => {
    fake.state.executeRows = [
      {
        day: "2026-10-25",
        activeHours: "2",
        userMessages: "3",
        quizAnswers: "5",
        writingSaves: "0",
        codingRequests: "7",
        clozeSubmissions: "2",
        codingHours: "1",
      },
    ];
    await expect(loadStudentUsage("u1")).resolves.toEqual([
      {
        date: "2026-10-25",
        activeHours: 2,
        userMessages: 3,
        quizAnswers: 5,
        writingSaves: 0,
        codingRequests: 7,
        clozeSubmissions: 2,
        codingHours: 1,
      },
    ]);
  });
});

describe("coding-key-store: own key dates", () => {
  it("returns only the issue dates, oldest first as the statement orders them", async () => {
    fake.state.executeRows = [{ day: "2026-09-01" }, { day: "2026-09-03" }];
    await expect(listOwnKeyDates("u1")).resolves.toEqual(["2026-09-01", "2026-09-03"]);
  });
});

describe("failures never throw and never pass the raw error on", () => {
  const cases: [string, string, () => Promise<unknown>, unknown][] = [
    ["achievement-store", "list grants", () => listGrants("u1"), undefined],
    [
      "achievement-store",
      "insert grants",
      () => insertGrants("u1", [{ id: "a-1", qualifiedOn: "2026-09-01" }], []),
      undefined,
    ],
    ["achievement-store", "mark seen", () => markSeen("u1", ["a-1"]), false],
    ["student-facts-store", "load usage", () => loadStudentUsage("u1"), undefined],
    ["coding-key-store", "list own key dates", () => listOwnKeyDates("u1"), undefined],
  ];

  it.each(cases)("%s: %s", async (store, op, call, failed) => {
    fake.state.error = drizzleError();
    await expect(call()).resolves.toEqual(failed);

    expect(recordError).toHaveBeenCalledTimes(1);
    const [error, attributes] = recordError.mock.calls[0] ?? [];
    expect((error as Error).message).toBe(`${store}: ${op} failed`);
    expect((error as Error).cause).toBeUndefined();
    expect(attributes).toEqual({ store, op, sqlState: "42P01" });

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("user-secret-id");
    expect(JSON.stringify(recordError.mock.calls)).not.toContain("user-secret-id");
  });
});
