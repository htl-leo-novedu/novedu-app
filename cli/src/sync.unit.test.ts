import { describe, expect, it } from "vitest";
import type { RegistryEntry } from "./registry";
import {
  buildLockCodes,
  collectWarnings,
  formatSyncReport,
  matchEntry,
  mintBody,
  parseLock,
  parseServerCodes,
  type ServerCode,
  type SyncEntryResult,
  selectMatches,
  serializeLock,
} from "./sync";

// The sync engine's pure half: which stored code IS a registry entry, what the
// lock file says afterwards, and what the run reports. The matcher is the part
// that must never be wrong in either direction — a false match hands a class the
// wrong window, a false miss mints a duplicate code every run.

const URL_A = "https://example.com/course/welcome-quiz.yaml";
const URL_B = "https://example.com/course/exam-quiz.yaml";

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    key: "welcome",
    module: "quiz",
    fileUrl: URL_A,
    validFrom: null,
    validUntil: null,
    note: null,
    llm: null,
    moodle: false,
    ...overrides,
  };
}

function code(overrides: Partial<ServerCode> = {}): ServerCode {
  return {
    code: "aaaaaaaaaa",
    url: "https://novedu.at/aaaaaaaaaa",
    module: "quiz",
    fileUrl: URL_A,
    note: null,
    validFrom: null,
    validUntil: null,
    llm: null,
    moodle: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchEntry", () => {
  it("matches on URL + module + window + llm, ignoring the note", () => {
    expect(
      matchEntry(entry({ note: "3A Monday" }), [code({ note: "something else" })]),
    ).toHaveLength(1);
  });

  it("does not match a different URL or a different module", () => {
    expect(matchEntry(entry(), [code({ fileUrl: URL_B })])).toEqual([]);
    expect(matchEntry(entry(), [code({ module: "tutor" })])).toEqual([]);
  });

  it("compares window bounds as instants, not as strings", () => {
    const matches = matchEntry(entry({ validFrom: "2026-09-01T00:00:00+02:00" }), [
      code({ validFrom: "2026-08-31T22:00:00.000Z" }),
    ]);

    expect(matches).toHaveLength(1);
  });

  it("treats an absent bound and a stored bound as different", () => {
    expect(matchEntry(entry(), [code({ validUntil: "2026-12-31T23:00:00.000Z" })])).toEqual([]);
    expect(matchEntry(entry({ validUntil: "2026-12-31T23:00:00.000Z" }), [code()])).toEqual([]);
  });

  it("matches only an identical llm override pair", () => {
    const override = { provider: "SCCH", model: "m1" } as const;
    const stored = { ...override, reasoning: null };

    expect(matchEntry(entry({ llm: override }), [code({ llm: stored })])).toHaveLength(1);
    expect(
      matchEntry(entry({ llm: override }), [
        code({ llm: { provider: "SCCH", model: "m2", reasoning: null } }),
      ]),
    ).toEqual([]);
    expect(matchEntry(entry({ llm: override }), [code()])).toEqual([]);
    expect(matchEntry(entry(), [code({ llm: stored })])).toEqual([]);
  });

  // A code minted at another reasoning effort serves DIFFERENT behavior, so reusing it
  // would silently run the class at an effort the registry no longer asks for. Sync never
  // edits a code, so the only correct answer is "no match" — the entry mints a new one.
  it("treats a differing reasoning level as a different override", () => {
    const pair = { provider: "SCCH", model: "m1" } as const;

    expect(
      matchEntry(entry({ llm: { ...pair, reasoning: "high" } }), [
        code({ llm: { ...pair, reasoning: "high" } }),
      ]),
    ).toHaveLength(1);
    expect(
      matchEntry(entry({ llm: { ...pair, reasoning: "high" } }), [
        code({ llm: { ...pair, reasoning: "low" } }),
      ]),
    ).toEqual([]);
    // An entry without a level never matches a code minted with one, and vice versa —
    // "no reasoning effort" is a real, different configuration.
    expect(
      matchEntry(entry({ llm: pair }), [code({ llm: { ...pair, reasoning: "low" } })]),
    ).toEqual([]);
    expect(
      matchEntry(entry({ llm: { ...pair, reasoning: "low" } }), [
        code({ llm: { ...pair, reasoning: null } }),
      ]),
    ).toEqual([]);
    // An entry with no level matches a stored code whose llm has reasoning null
    // (the server omits it).
    expect(
      matchEntry(entry({ llm: pair }), [code({ llm: { ...pair, reasoning: null } })]),
    ).toHaveLength(1);
  });

  it("returns several matches newest first", () => {
    const older = code({ code: "older00000", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = code({ code: "newer00000", createdAt: "2026-06-01T00:00:00.000Z" });

    expect(matchEntry(entry(), [older, newer]).map((match) => match.code)).toEqual([
      "newer00000",
      "older00000",
    ]);
  });
});

// Selection is what keeps a published code under a key. Two entries may describe
// the SAME activity on purpose (one quiz linked from two chapters, each with its
// own statistics), and then both match both codes — picking per entry in
// isolation would give both keys one code and move it again on the next run.
describe("selectMatches", () => {
  const older = code({ code: "older00000", createdAt: "2026-01-01T00:00:00.000Z" });
  const newer = code({ code: "newer00000", createdAt: "2026-06-01T00:00:00.000Z" });

  it("gives two identical entries a code each instead of the same one twice", () => {
    const entries = [entry({ key: "alpha" }), entry({ key: "beta" })];

    const selected = selectMatches(entries, [older, newer], {});

    expect(selected.get("alpha")?.code).toBe("newer00000");
    expect(selected.get("beta")?.code).toBe("older00000");
  });

  it("keeps every key on the code the lock already gave it, whatever is newest", () => {
    const entries = [entry({ key: "alpha" }), entry({ key: "beta" })];
    const lock = { alpha: "older00000", beta: "newer00000" };

    const selected = selectMatches(entries, [older, newer], lock);

    // The straightforward "newest first, in entry order" rule would swap these.
    expect(selected.get("alpha")?.code).toBe("older00000");
    expect(selected.get("beta")?.code).toBe("newer00000");
  });

  it("is stable: re-selecting from its own result changes nothing", () => {
    const entries = [entry({ key: "alpha" }), entry({ key: "beta" })];
    const codes = [older, newer];

    const first = selectMatches(entries, codes, {});
    const lock = Object.fromEntries([...first].map(([key, match]) => [key, match.code] as const));
    const second = selectMatches(entries, codes, lock);

    expect([...second].map(([key, match]) => [key, match.code])).toEqual(
      [...first].map(([key, match]) => [key, match.code]),
    );
  });

  it("moves a key on only when its code no longer matches the entry", () => {
    const entries = [entry({ key: "alpha", validUntil: "2026-12-31T23:00:00.000Z" })];

    const selected = selectMatches(
      entries,
      [older, code({ code: "window0000", validUntil: "2026-12-31T23:00:00.000Z" })],
      { alpha: "older00000" },
    );

    expect(selected.get("alpha")?.code).toBe("window0000");
  });

  it("leaves an entry unselected when every match is taken", () => {
    const entries = [entry({ key: "alpha" }), entry({ key: "beta" })];

    const selected = selectMatches(entries, [newer], {});

    expect(selected.get("alpha")?.code).toBe("newer00000");
    expect(selected.has("beta")).toBe(false); // mints instead of stealing alpha's code
  });
});

describe("parseServerCodes", () => {
  it("keeps the fields matching needs and drops unusable rows", () => {
    const parsed = parseServerCodes([
      {
        code: "aaaaaaaaaa",
        url: "https://novedu.at/aaaaaaaaaa",
        module: "quiz",
        fileUrl: URL_A,
        note: "3A",
        validFrom: null,
        validUntil: "2026-12-31T23:00:00.000Z",
        llm: { provider: "SCCH", model: "m1" },
        createdAt: "2026-01-01T00:00:00.000Z",
        anonymous: true,
        somethingNew: 42,
      },
      { code: "bbbbbbbbbb" },
      null,
      "nonsense",
    ]);

    expect(parsed).toHaveLength(1);
    // A server that never heard of the reasoning level reads as "no level", not as junk.
    expect(parsed[0]?.llm).toEqual({ provider: "SCCH", model: "m1", reasoning: null });
    expect(parsed[0]?.validUntil).toBe("2026-12-31T23:00:00.000Z");
    // A server without the Moodle switch reads as off.
    expect(parsed[0]?.moodle).toBe(false);
    expect(
      parseServerCodes([{ code: "c", module: "quiz", fileUrl: URL_A, moodle: true }])[0]?.moodle,
    ).toBe(true);
  });

  it("reads the override's reasoning level, defensively", () => {
    const withLevel = parseServerCodes([
      {
        code: "aaaaaaaaaa",
        module: "quiz",
        fileUrl: URL_A,
        llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "high" },
      },
    ]);
    expect(withLevel[0]?.llm).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5.6-terra",
      reasoning: "high",
    });

    // Anything that is not a string is "no level" — never a value the matcher could
    // accidentally compare equal to an entry's.
    const junk = parseServerCodes([
      {
        code: "bbbbbbbbbb",
        module: "quiz",
        fileUrl: URL_A,
        llm: { provider: "SCCH", model: "m1", reasoning: 3 },
      },
    ]);
    expect(junk[0]?.llm?.reasoning).toBeNull();
  });

  it("answers an unexpected payload with an empty list", () => {
    expect(parseServerCodes({ message: "Unauthorized" })).toEqual([]);
  });
});

describe("mintBody", () => {
  it("sends the Moodle switch only when it is on", () => {
    expect(mintBody(entry({ moodle: true }))).toEqual({
      module: "quiz",
      fileUrl: URL_A,
      moodle: true,
    });
    expect(mintBody(entry({ moodle: false }))).not.toHaveProperty("moodle");
  });

  it("sends only the fields the entry actually sets", () => {
    expect(mintBody(entry())).toEqual({ module: "quiz", fileUrl: URL_A });
    expect(
      mintBody(
        entry({
          validFrom: "2026-09-01T00:00:00+02:00",
          note: "3A",
          llm: { provider: "SCCH", model: "m1" },
        }),
      ),
    ).toEqual({
      module: "quiz",
      fileUrl: URL_A,
      validFrom: "2026-09-01T00:00:00+02:00",
      note: "3A",
      llm: { provider: "SCCH", model: "m1" },
    });
  });

  it("carries the override's reasoning level into the mint body", () => {
    expect(
      mintBody(
        entry({ llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "low" } }),
      ),
    ).toEqual({
      module: "quiz",
      fileUrl: URL_A,
      llm: { provider: "Azure Foundry", model: "gpt-5.6-terra", reasoning: "low" },
    });
  });
});

describe("buildLockCodes", () => {
  const results: SyncEntryResult[] = [
    { entry: entry({ key: "welcome" }), action: "reused", code: "aaaaaaaaaa" },
    { entry: entry({ key: "exam", fileUrl: URL_B }), action: "minted", code: "bbbbbbbbbb" },
  ];

  it("takes the code of every resolved entry", () => {
    expect(buildLockCodes(results, {})).toEqual({ welcome: "aaaaaaaaaa", exam: "bbbbbbbbbb" });
  });

  it("keeps a failed entry's previous code so a transient error cannot break a build", () => {
    const failed: SyncEntryResult[] = [
      { entry: entry({ key: "welcome" }), action: "failed", error: { message: "boom" } },
      { entry: entry({ key: "exam" }), action: "failed", error: { message: "boom" } },
    ];

    expect(buildLockCodes(failed, { welcome: "aaaaaaaaaa" })).toEqual({ welcome: "aaaaaaaaaa" });
  });

  it("drops keys that left the registry", () => {
    expect(buildLockCodes(results, { gone: "cccccccccc" })).not.toHaveProperty("gone");
  });
});

describe("serializeLock / parseLock", () => {
  it("sorts keys and round-trips", () => {
    const text = serializeLock({ welcome: "aaaaaaaaaa", exam: "bbbbbbbbbb" }, "activities.yaml");

    expect(text).toBe(
      [
        "# Generated by @novedu/cli — do not edit.",
        "# Regenerate with: novedu-cli codes sync activities.yaml",
        "activity-codes:",
        "  exam: bbbbbbbbbb",
        "  welcome: aaaaaaaaaa",
        "",
      ].join("\n"),
    );
    expect(parseLock(text)).toEqual({ exam: "bbbbbbbbbb", welcome: "aaaaaaaaaa" });
  });

  it("is deterministic regardless of insertion order", () => {
    expect(serializeLock({ b: "2222222222", a: "1111111111" }, "r.yaml")).toBe(
      serializeLock({ a: "1111111111", b: "2222222222" }, "r.yaml"),
    );
  });

  it("quotes an all-digit code so it stays a string", () => {
    expect(parseLock(serializeLock({ a: "1234567890" }, "r.yaml"))).toEqual({ a: "1234567890" });
  });

  it("reads a missing or unusable lock as empty", () => {
    expect(parseLock("")).toEqual({});
    expect(parseLock("other-key:\n  a: b\n")).toEqual({});
    expect(parseLock("[oops")).toEqual({});
  });
});

describe("collectWarnings", () => {
  it("reports several matches, a differing note, superseded codes and orphaned lock keys", () => {
    const newer = code({
      code: "newer00000",
      createdAt: "2026-06-01T00:00:00.000Z",
      note: "old note",
    });
    const older = code({ code: "older00000", createdAt: "2026-01-01T00:00:00.000Z" });
    const superseded = code({
      code: "stale00000",
      validUntil: "2026-12-31T23:00:00.000Z",
    });
    const results: SyncEntryResult[] = [
      { entry: entry({ note: "new note" }), action: "reused", code: "newer00000" },
    ];

    const warnings = collectWarnings(results, [newer, older, superseded], { gone: "cccccccccc" });

    expect(warnings.map((warning) => warning.type)).toEqual([
      "duplicate",
      "note",
      "superseded",
      "orphaned",
    ]);
    expect(warnings[2]?.codes).toEqual(["stale00000"]);
    expect(warnings[0]?.codes).toEqual(["newer00000", "older00000"]);
    expect(warnings.at(-1)?.key).toBe("gone");
  });

  it("does not call a code spare when another key is using it", () => {
    const older = code({ code: "older00000", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = code({ code: "newer00000", createdAt: "2026-06-01T00:00:00.000Z" });
    const results: SyncEntryResult[] = [
      { entry: entry({ key: "alpha" }), action: "reused", code: "newer00000" },
      { entry: entry({ key: "beta" }), action: "reused", code: "older00000" },
    ];

    // Both entries match both codes, but each code is in use — nothing is
    // duplicate, nothing is superseded.
    expect(collectWarnings(results, [older, newer], {})).toEqual([]);
  });

  it("reports the code it actually used, not the newest match", () => {
    const older = code({ code: "older00000", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = code({ code: "newer00000", createdAt: "2026-06-01T00:00:00.000Z" });
    const results: SyncEntryResult[] = [
      { entry: entry({ key: "alpha" }), action: "reused", code: "older00000" },
    ];

    const [duplicate] = collectWarnings(results, [older, newer], { alpha: "older00000" });

    expect(duplicate?.message).toContain("using older00000");
    expect(duplicate?.message).toContain("unused: newer00000");
  });

  it("compares the note of the code it used, not of some other match", () => {
    const used = code({ code: "used000000", note: "3A Monday" });
    const other = code({
      code: "other00000",
      note: "something else",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const results: SyncEntryResult[] = [
      { entry: entry({ note: "3A Monday" }), action: "reused", code: "used000000" },
    ];

    const types = collectWarnings(results, [used, other], {}).map((warning) => warning.type);

    expect(types).not.toContain("note");
  });

  it("never matches on the Moodle switch, but reports a difference as info", () => {
    expect(matchEntry(entry({ moodle: true }), [code({ moodle: false })])).toHaveLength(1);
    const warnings = collectWarnings(
      [{ entry: entry({ moodle: true }), action: "reused", code: "aaaaaaaaaa" }],
      [code()],
      {},
    );
    expect(warnings).toEqual([
      {
        type: "moodle",
        key: "welcome",
        codes: ["aaaaaaaaaa"],
        message: "welcome: moodle differs — change it on the code's edit page",
      },
    ]);
  });

  it("stays silent when every entry matches exactly one code", () => {
    expect(
      collectWarnings([{ entry: entry(), action: "reused", code: "aaaaaaaaaa" }], [code()], {
        welcome: "aaaaaaaaaa",
      }),
    ).toEqual([]);
  });
});

describe("formatSyncReport", () => {
  it("labels each entry and closes with the summary", () => {
    const lines = formatSyncReport(
      [
        {
          entry: entry({ key: "welcome" }),
          action: "reused",
          code: "aaaaaaaaaa",
          url: "https://novedu.at/aaaaaaaaaa",
        },
        {
          entry: entry({ key: "exam" }),
          action: "failed",
          error: { message: "The file could not be read." },
        },
      ],
      [
        {
          type: "orphaned",
          key: "gone",
          message: "gone: in the lock file but not in the registry",
        },
      ],
      { registryFileName: "activities.yaml", dryRun: false },
    );

    expect(lines[0]).toBe("activities.yaml: 2 entries");
    expect(lines[1]).toContain("reused");
    expect(lines[1]).toContain("https://novedu.at/aaaaaaaaaa");
    expect(lines[2]).toContain("failed");
    expect(lines[2]).toContain("The file could not be read.");
    expect(lines).toContain("  - gone: in the lock file but not in the registry");
    expect(lines.at(-1)).toBe("1 reused, 0 minted, 1 failed");
  });

  it("labels a dry run's mints as would-be actions", () => {
    const lines = formatSyncReport([{ entry: entry(), action: "minted" }], [], {
      registryFileName: "activities.yaml",
      dryRun: true,
    });

    expect(lines[1]).toContain("would mint");
    expect(lines.at(-1)).toBe("0 reused, 1 to mint, 0 failed");
  });
});
