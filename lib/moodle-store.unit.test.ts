import { getTableName, type SQL, type Table } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Moodle store (lib/moodle-store.ts): a recording fake stands in for
// Drizzle, so the tests assert each statement's table, that EVERY statement
// filters by the configured issuer, the link transaction's shape, the
// mismatch on a unique violation, and that a failure never passes the raw
// error on. The real statements run in the @live-db round trip
// (e2e/moodle-roundtrip.live.spec.ts).

const fake = vi.hoisted(() => ({
  state: {
    log: [] as string[],
    wheres: [] as unknown[],
    values: [] as unknown[],
    conflicts: [] as unknown[],
    rows: [] as unknown[][],
    updatedRows: 1,
    failOn: undefined as string | undefined,
    error: undefined as unknown,
  },
}));

vi.mock("@/lib/db", () => {
  const { state } = fake;
  const name = (table: Table) => getTableName(table);
  const run = <T>(entry: string, value: () => T): Promise<T> => {
    state.log.push(entry);
    return state.failOn && entry.startsWith(state.failOn)
      ? Promise.reject(state.error)
      : Promise.resolve(value());
  };
  const thenable = <T>(entry: string, value: () => T) => ({
    // biome-ignore lint/suspicious/noThenProperty: mimics Drizzle's thenable builders.
    then: (resolve: (v: T) => unknown, reject: (e: unknown) => unknown) =>
      run(entry, value).then(resolve, reject),
  });
  const db = {
    select: () => ({
      from: (table: Table) => ({
        where: (predicate: unknown) => {
          state.wheres.push(predicate);
          return thenable(`select ${name(table)}`, () => state.rows.shift() ?? []);
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: unknown) => {
        state.values.push(values);
        return {
          ...thenable(`insert ${name(table)}`, () => undefined),
          onConflictDoUpdate: (conflict: unknown) => {
            state.conflicts.push(conflict);
            return thenable(`upsert ${name(table)}`, () => undefined);
          },
        };
      },
    }),
    update: (table: Table) => ({
      set: () => ({
        where: (predicate: unknown) => {
          state.wheres.push(predicate);
          return thenable(`update ${name(table)}`, () => ({ rowCount: state.updatedRows }));
        },
      }),
    }),
    delete: (table: Table) => ({
      where: (predicate: unknown) => {
        state.wheres.push(predicate);
        return thenable(`delete ${name(table)}`, () => undefined);
      },
    }),
    transaction: async (body: (tx: unknown) => Promise<void>) => {
      state.log.push("begin");
      await body(db);
      state.log.push("commit");
    },
  };
  return { getDb: () => db };
});

const recordError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry", () => ({ recordError, emitEvent: vi.fn() }));

import {
  deleteTargetsForCode,
  findLinkState,
  getOwnLink,
  getOwnTarget,
  linkAndStoreTarget,
  markHandedIn,
  storeTarget,
  unlinkOwn,
} from "./moodle-store";

const ISSUER = "https://moodle.example.org";
const TARGET = { code: "quiz-code1", lineitemUrl: `${ISSUER}/mod/lti/services.php/2/lineitems/5` };
const dialect = new PgDialect();
const params = (predicate: unknown) => dialect.sqlToQuery(predicate as SQL).params;
const uniqueViolation = () =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("dup"), { code: "23505" }),
  });

beforeEach(() => {
  Object.assign(fake.state, {
    log: [],
    wheres: [],
    values: [],
    conflicts: [],
    rows: [],
    updatedRows: 1,
    failOn: undefined,
    error: undefined,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("every statement is filtered by the configured issuer", () => {
  it("reads, updates and deletes carry the issuer and the session user", async () => {
    await getOwnLink(ISSUER, "u1");
    await findLinkState(ISSUER, "u1", "m42");
    await getOwnTarget(ISSUER, "u1", "quiz-code1");
    await markHandedIn(ISSUER, "u1", TARGET, new Date());
    await unlinkOwn(ISSUER, "u1");
    expect(fake.state.wheres).toHaveLength(7);
    for (const predicate of fake.state.wheres) expect(params(predicate)).toContain(ISSUER);
  });

  it("writes carry the issuer", async () => {
    await linkAndStoreTarget(ISSUER, "u1", "m42", TARGET);
    await storeTarget(ISSUER, "u1", TARGET);
    for (const values of fake.state.values)
      expect(values).toMatchObject({ issuer: ISSUER, userId: "u1" });
  });
});

describe("linkAndStoreTarget", () => {
  it("inserts the link and upserts the target in one transaction", async () => {
    const now = new Date("2026-11-14T10:00:00Z");
    await expect(linkAndStoreTarget(ISSUER, "u1", "m42", TARGET, now)).resolves.toBe("linked");
    expect(fake.state.log).toEqual([
      "begin",
      "insert novedu_moodle_links",
      "upsert novedu_moodle_targets",
      "commit",
    ]);
    expect(fake.state.values[0]).toEqual({
      issuer: ISSUER,
      userId: "u1",
      moodleUserId: "m42",
      linkedAt: now,
    });
    expect(fake.state.values[1]).toMatchObject({
      code: "quiz-code1",
      lineitemUrl: TARGET.lineitemUrl,
    });
  });

  it("answers a unique violation (either key) as a mismatch, quietly", async () => {
    fake.state.failOn = "insert novedu_moodle_links";
    fake.state.error = uniqueViolation();
    await expect(linkAndStoreTarget(ISSUER, "u1", "m42", TARGET)).resolves.toBe("mismatch");
    expect(fake.state.log).not.toContain("upsert novedu_moodle_targets");
    expect(recordError).not.toHaveBeenCalled();
  });

  it("reports any other failure with a fixed message", async () => {
    fake.state.failOn = "upsert";
    fake.state.error = new Error("select * where user_id = 'u1' — leaks parameters");
    await expect(linkAndStoreTarget(ISSUER, "u1", "m42", TARGET)).resolves.toBe("error");
    expect(recordError).toHaveBeenCalledOnce();
    expect(String(recordError.mock.calls[0]?.[0])).toBe("Error: moodle-store: link failed");
  });
});

describe("storeTarget", () => {
  it("keeps handed_in_at only for the same grade column", async () => {
    await expect(storeTarget(ISSUER, "u1", TARGET)).resolves.toBe(true);
    const conflict = fake.state.conflicts[0] as { set: { handedInAt: SQL } };
    expect(dialect.sqlToQuery(conflict.set.handedInAt).sql).toMatch(
      /CASE WHEN "novedu_moodle_targets"."lineitem_url" = excluded.lineitem_url THEN "novedu_moodle_targets"."handed_in_at" ELSE NULL END/,
    );
  });

  it("is false on a failure", async () => {
    fake.state.failOn = "upsert";
    fake.state.error = new Error("down");
    await expect(storeTarget(ISSUER, "u1", TARGET)).resolves.toBe(false);
  });
});

describe("reads", () => {
  it("return the row, null without one, undefined on a failure", async () => {
    const linkedAt = new Date();
    fake.state.rows = [[{ moodleUserId: "m42", linkedAt }], []];
    await expect(getOwnLink(ISSUER, "u1")).resolves.toEqual({ moodleUserId: "m42", linkedAt });
    await expect(getOwnLink(ISSUER, "u1")).resolves.toBeNull();
    fake.state.failOn = "select";
    fake.state.error = new Error("down");
    await expect(getOwnTarget(ISSUER, "u1", "quiz-code1")).resolves.toBeUndefined();
  });

  it("findLinkState reads both directions", async () => {
    fake.state.rows = [[{ moodleUserId: "m41" }], [{ userId: "u2" }]];
    await expect(findLinkState(ISSUER, "u1", "m42")).resolves.toEqual({
      ownMoodleUserId: "m41",
      moodleUserOwner: "u2",
    });
  });
});

describe("markHandedIn", () => {
  it("only marks the target still pointing at that grade column", async () => {
    await expect(markHandedIn(ISSUER, "u1", TARGET, new Date())).resolves.toBe(true);
    expect(params(fake.state.wheres[0])).toEqual(
      expect.arrayContaining([ISSUER, "u1", "quiz-code1", TARGET.lineitemUrl]),
    );
    fake.state.updatedRows = 0;
    await expect(markHandedIn(ISSUER, "u1", TARGET, new Date())).resolves.toBe(false);
  });
});

describe("unlinkOwn", () => {
  it("deletes the user's targets and link together", async () => {
    await expect(unlinkOwn(ISSUER, "u1")).resolves.toBe(true);
    expect(fake.state.log).toEqual([
      "begin",
      "delete novedu_moodle_targets",
      "delete novedu_moodle_links",
      "commit",
    ]);
  });
});

describe("deleteTargetsForCode", () => {
  it("drops every target of the code, on every site, and throws on a failure", async () => {
    const { getDb } = await import("@/lib/db");
    await deleteTargetsForCode(getDb(), "quiz-code1");
    expect(params(fake.state.wheres[0])).toEqual(["quiz-code1"]);
    fake.state.failOn = "delete";
    fake.state.error = new Error("down");
    await expect(deleteTargetsForCode(getDb(), "quiz-code1")).rejects.toThrow("down");
  });
});
