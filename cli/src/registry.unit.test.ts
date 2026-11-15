import { describe, expect, it } from "vitest";
import { defaultLockPath, parseRegistry, type RegistryResult } from "./registry";

// The activity registry's schema + URL resolution (docs/registry.md). The format
// is hand-written by teachers, so the tests pin BOTH halves of its contract:
// every real mistake is caught with a path that points at the offending line,
// and unknown extra properties are tolerated so a newer registry keeps working
// with an older CLI.

const BASE = "https://raw.githubusercontent.com/acme/course/refs/heads/main/";

function entries(result: RegistryResult) {
  if (!result.ok)
    throw new Error(`expected a valid registry, got ${JSON.stringify(result.errors)}`);
  return result.entries;
}

function errors(result: RegistryResult) {
  if (result.ok) throw new Error("expected an invalid registry");
  return result.errors;
}

describe("parseRegistry — valid documents", () => {
  it("resolves every group into its module, in registry order", () => {
    const result = parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    welcome:
      file: 0010-introduction/0010-welcome-quiz.yaml
      note: "Creative Coding: Welcome"
  tutors:
    sorting:
      url: https://example.com/hosted/tutor.yaml
  writing:
    essay:
      file: writing/essay.yaml
  coding:
    kata:
      file: coding/kata.yaml
`);

    expect(entries(result)).toEqual([
      {
        key: "welcome",
        module: "quiz",
        fileUrl: `${BASE}0010-introduction/0010-welcome-quiz.yaml`,
        validFrom: null,
        validUntil: null,
        note: "Creative Coding: Welcome",
        llm: null,
        moodle: false,
      },
      {
        key: "sorting",
        module: "tutor",
        fileUrl: "https://example.com/hosted/tutor.yaml",
        validFrom: null,
        validUntil: null,
        note: null,
        llm: null,
        moodle: false,
      },
      {
        key: "essay",
        module: "writing",
        fileUrl: `${BASE}writing/essay.yaml`,
        validFrom: null,
        validUntil: null,
        note: null,
        llm: null,
        moodle: false,
      },
      {
        key: "kata",
        module: "coding",
        fileUrl: `${BASE}coding/kata.yaml`,
        validFrom: null,
        validUntil: null,
        note: null,
        llm: null,
        moodle: false,
      },
    ]);
  });

  it("keeps the window bounds verbatim and the llm pair as authored", () => {
    const [entry] = entries(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      start: 2026-09-01T00:00:00+02:00
      end: 2027-01-31T23:59:59+01:00
      llm:
        provider: Azure Foundry
        model: gpt-5
`),
    );

    expect(entry?.validFrom).toBe("2026-09-01T00:00:00+02:00");
    expect(entry?.validUntil).toBe("2027-01-31T23:59:59+01:00");
    expect(entry?.llm).toEqual({ provider: "Azure Foundry", model: "gpt-5" });
  });

  it("carries the override's optional reasoning level, and omits it when absent", () => {
    const [withLevel] = entries(
      parseRegistry(`
activities:
  tutors:
    t:
      url: https://example.com/t.yaml
      llm:
        provider: Azure Foundry
        model: gpt-5.6-terra
        reasoning: high
`),
    );
    expect(withLevel?.llm).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5.6-terra",
      reasoning: "high",
    });

    const [withoutLevel] = entries(
      parseRegistry(`
activities:
  tutors:
    t:
      url: https://example.com/t.yaml
      llm:
        provider: SCCH
        model: gemma-4
`),
    );
    // The key is ABSENT, not `undefined`: the entry is serialized straight into the mint
    // body, where an undefined-valued key would travel as `null`.
    expect(withoutLevel?.llm).toEqual({ provider: "SCCH", model: "gemma-4" });
    expect(withoutLevel?.llm && "reasoning" in withoutLevel.llm).toBe(false);
  });

  it("accepts unknown extra properties at root, group and entry level", () => {
    const result = parseRegistry(`
base-url: "${BASE}"
maintainer: "3AHIF"
activities:
  quizzes:
    section: "annotations are scalars, entries are mappings"
    tags: [also, a, sequence]
    welcome:
      file: welcome.yaml
      chapter: 0010
`);

    expect(entries(result).map((entry) => entry.key)).toEqual(["welcome"]);
  });

  it("trims a note the way the server trims it before storing", () => {
    const result = parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    welcome:
      file: welcome.yaml
      note: "  3A Monday  "
`);

    // An untrimmed note would never equal the stored one, so every later run
    // would report a spurious "note differs" finding.
    expect(entries(result)[0]?.note).toBe("3A Monday");
  });

  it("allows an empty group and a registry of absolute URLs without base-url", () => {
    const result = parseRegistry(`
activities:
  quizzes:
    hosted:
      url: https://novedu.at/api/files/sorting-quiz
  tutors: {}
`);

    expect(entries(result).map((entry) => entry.fileUrl)).toEqual([
      "https://novedu.at/api/files/sorting-quiz",
    ]);
  });

  it("normalizes resolved URLs the way the server stores them", () => {
    const [entry] = entries(
      parseRegistry(`
base-url: "https://example.com/course/chapters/"
activities:
  quizzes:
    up:
      file: ../shared/quiz.yaml
`),
    );

    expect(entry?.fileUrl).toBe("https://example.com/course/shared/quiz.yaml");
  });

  it("allows two keys to point at the same activity (different windows, same YAML)", () => {
    const result = parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    autumn:
      file: exam.yaml
      end: 2026-12-31T23:59:59Z
    spring:
      file: exam.yaml
      start: 2027-01-01T00:00:00Z
`);

    expect(entries(result)).toHaveLength(2);
  });
});

describe("parseRegistry — the Moodle switch", () => {
  it("accepts `moodle: true` under quizzes", () => {
    const [entry] = entries(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      moodle: true
`),
    );
    expect(entry?.moodle).toBe(true);
  });

  it("rejects it in any other group", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  tutors:
    helper:
      file: tutor.yaml
      moodle: true
`),
    );
    expect(issue).toMatchObject({
      path: "activities.tutors.helper.moodle",
      message: "is allowed under `quizzes` only",
    });
  });

  it("rejects a value that is not a boolean", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      moodle: "yes"
`),
    );
    expect(issue?.path).toBe("activities.quizzes.exam.moodle");
  });
});

describe("parseRegistry — rejections", () => {
  it("reports invalid YAML as a parse error", () => {
    expect(errors(parseRegistry("activities:\n  quizzes:\n   - [oops"))[0]?.code).toBe(
      "REGISTRY_PARSE_ERROR",
    );
  });

  it("rejects an unknown activity group instead of silently dropping its entries", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizes:
    typo:
      file: quiz.yaml
`),
    );

    expect(issue?.path).toBe("activities.quizes");
    expect(issue?.message).toContain("unknown activity group");
  });

  it("rejects a duplicate key across groups (the lock namespace is flat)", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    intro:
      file: quiz.yaml
  tutors:
    intro:
      file: tutor.yaml
`),
    );

    expect(issue?.path).toBe("activities.tutors.intro");
    expect(issue?.message).toContain("duplicate key");
  });

  it("rejects a key that is not lowercase-kebab", () => {
    expect(
      errors(
        parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    Number_Systems:
      file: quiz.yaml
`),
      )[0]?.message,
    ).toContain("invalid key");
  });

  it("rejects `file` without a base-url, naming the missing key", () => {
    const [issue] = errors(
      parseRegistry(`
activities:
  quizzes:
    welcome:
      file: welcome.yaml
`),
    );

    expect(issue?.path).toBe("activities.quizzes.welcome.file");
    expect(issue?.message).toContain("no `base-url`");
  });

  it("rejects a base-url without a trailing slash", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "https://example.com/course"
activities:
  quizzes:
    welcome:
      file: welcome.yaml
`),
    );

    expect(issue?.path).toBe("base-url");
    expect(issue?.message).toContain("must end with a slash");
  });

  it("rejects a naive datetime, mirroring the API's 400", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      start: "2026-09-01T00:00:00"
`),
    );

    expect(issue?.path).toBe("activities.quizzes.exam.start");
    expect(issue?.message).toContain("explicit offset");
  });

  it("rejects sub-second precision, which the server would truncate away", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      start: "2026-09-01T00:00:00.500Z"
`),
    );

    // The server floors to whole seconds, so a stored ".000Z" would never match
    // this entry again and every run would mint another code.
    expect(issue?.path).toBe("activities.quizzes.exam.start");
    expect(issue?.message).toContain("sub-second");
  });

  it("accepts a whole-second bound spelled with milliseconds", () => {
    const result = parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      start: "2026-09-01T00:00:00.000Z"
`);

    expect(entries(result)[0]?.validFrom).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rejects an entry with no fields — a mis-indent must never drop an activity", () => {
    const [issue] = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    welcome:
    file: welcome.yaml
`),
    );

    // YAML reads this as \`welcome: null\` plus a loose scalar sibling. Ignoring
    // it would drop a published quiz from the lock and still report success.
    expect(issue?.path).toBe("activities.quizzes.welcome");
    expect(issue?.message).toContain("indentation");
  });

  it("rejects an end that is not after the start", () => {
    expect(
      errors(
        parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    exam:
      file: exam.yaml
      start: 2026-09-01T10:00:00Z
      end: 2026-09-01T09:00:00Z
`),
      )[0]?.path,
    ).toBe("activities.quizzes.exam.end");
  });

  it("rejects both / neither of file and url", () => {
    const both = errors(
      parseRegistry(`
base-url: "${BASE}"
activities:
  quizzes:
    two:
      file: quiz.yaml
      url: https://example.com/quiz.yaml
`),
    );
    const neither = errors(
      parseRegistry(`
activities:
  quizzes:
    none:
      note: "nothing to mint"
`),
    );

    expect(both[0]?.message).toContain("exactly one");
    expect(neither[0]?.message).toContain("exactly one");
  });

  it("rejects a non-http url and an unknown llm provider", () => {
    expect(
      errors(
        parseRegistry(`
activities:
  quizzes:
    ftp:
      url: ftp://example.com/quiz.yaml
`),
      )[0]?.message,
    ).toContain("absolute http(s) URL");

    expect(
      errors(
        parseRegistry(`
activities:
  tutors:
    t:
      url: https://example.com/t.yaml
      llm:
        provider: azure-foundry
        model: gpt-5
`),
      )[0]?.path,
    ).toBe("activities.tutors.t.llm.provider");
  });

  it("rejects an unknown reasoning level", () => {
    const [issue] = errors(
      parseRegistry(`
activities:
  tutors:
    t:
      url: https://example.com/t.yaml
      llm:
        provider: SCCH
        model: gemma-4
        reasoning: turbo
`),
    );
    expect(issue?.path).toBe("activities.tutors.t.llm.reasoning");
    expect(issue?.message).toContain("minimal");
  });

  it("rejects an incomplete llm pair", () => {
    expect(
      errors(
        parseRegistry(`
activities:
  tutors:
    t:
      url: https://example.com/t.yaml
      llm:
        model: gpt-5
`),
      )[0]?.path,
    ).toBe("activities.tutors.t.llm.provider");
  });

  it("collects every problem in one run", () => {
    const found = errors(
      parseRegistry(`
base-url: "https://example.com/course"
activities:
  quizzes:
    ok:
      file: quiz.yaml
    BAD_KEY:
      file: other.yaml
`),
    );

    expect(found.map((issue) => issue.path)).toEqual([
      "base-url",
      "activities.quizzes.ok.file",
      "activities.quizzes.BAD_KEY",
    ]);
  });
});

describe("defaultLockPath", () => {
  it("replaces the YAML extension with .lock.yaml", () => {
    expect(defaultLockPath("ddp-activities.yaml")).toBe("ddp-activities.lock.yaml");
    expect(defaultLockPath("/tmp/course/registry.yml")).toBe("/tmp/course/registry.lock.yaml");
    expect(defaultLockPath("registry")).toBe("registry.lock.yaml");
  });
});
