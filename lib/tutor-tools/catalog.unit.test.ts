import { describe, expect, it } from "vitest";
import {
  boardTool,
  defaultTutorToolDeps,
  NO_PRIOR_CALLS,
  RANDOM_NUMBER_BOUND,
  randomNumberTool,
  resolveTutorTools,
  type TutorToolDeps,
  tutorToolCatalog,
} from "./catalog";
import { TUTOR_TOOL_NAMES, tutorToolNameSchema } from "./names";

/** Deps whose randomInt records its calls and returns a fixed value. */
const fixedDeps = (value: number): TutorToolDeps & { calls: [number, number][] } => {
  const calls: [number, number][] = [];
  return {
    calls,
    randomInt: (min, max) => {
      calls.push([min, max]);
      return value;
    },
  };
};

describe("catalog completeness", () => {
  it("has a catalog entry for every declared tool name, and no extras", () => {
    expect(Object.keys(tutorToolCatalog).sort()).toEqual([...TUTOR_TOOL_NAMES].sort());
  });

  it("every entry carries name, description, schemas and an executor", () => {
    for (const name of TUTOR_TOOL_NAMES) {
      const tool = tutorToolCatalog[name];
      expect(tool.name).toBe(name);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("the name zod enum accepts every catalog name and rejects unknowns", () => {
    for (const name of TUTOR_TOOL_NAMES) {
      expect(tutorToolNameSchema.safeParse(name).success).toBe(true);
    }
    expect(tutorToolNameSchema.safeParse("radix_conversion").success).toBe(false);
    expect(tutorToolNameSchema.safeParse("").success).toBe(false);
  });

  it("resolveTutorTools returns entries in selection order", () => {
    expect(resolveTutorTools(["random_number"])).toEqual([tutorToolCatalog.random_number]);
    expect(resolveTutorTools(["board", "random_number"])).toEqual([
      tutorToolCatalog.board,
      tutorToolCatalog.random_number,
    ]);
    expect(resolveTutorTools([])).toEqual([]);
  });
});

describe("random_number", () => {
  it("delegates to the injected RNG with the inclusive bounds and wraps the value", () => {
    const deps = fixedDeps(42);
    expect(randomNumberTool.execute({ min: 1, max: 100 }, deps, NO_PRIOR_CALLS)).toEqual({
      value: 42,
    });
    expect(deps.calls).toEqual([[1, 100]]);
  });

  it("accepts min === max (a single-value range)", () => {
    const parsed = randomNumberTool.inputSchema.safeParse({ min: 7, max: 7 });
    expect(parsed.success).toBe(true);
    expect(
      randomNumberTool.execute({ min: 7, max: 7 }, defaultTutorToolDeps, NO_PRIOR_CALLS),
    ).toEqual({
      value: 7,
    });
  });

  it("rejects min > max", () => {
    const parsed = randomNumberTool.inputSchema.safeParse({ min: 5, max: 4 });
    expect(parsed.success).toBe(false);
  });

  it("rejects non-integers, out-of-bound values and unknown keys", () => {
    expect(randomNumberTool.inputSchema.safeParse({ min: 0.5, max: 2 }).success).toBe(false);
    expect(
      randomNumberTool.inputSchema.safeParse({ min: 0, max: RANDOM_NUMBER_BOUND + 1 }).success,
    ).toBe(false);
    expect(
      randomNumberTool.inputSchema.safeParse({ min: -RANDOM_NUMBER_BOUND - 1, max: 0 }).success,
    ).toBe(false);
    expect(randomNumberTool.inputSchema.safeParse({ min: 1, max: 2, seed: 3 }).success).toBe(false);
    expect(randomNumberTool.inputSchema.safeParse({ min: 1 }).success).toBe(false);
  });

  it("default deps produce in-range integers across the whole range (inclusive ends)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const { value } = randomNumberTool.execute(
        { min: 1, max: 6 },
        defaultTutorToolDeps,
        NO_PRIOR_CALLS,
      );
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      seen.add(value);
    }
    // 200 rolls of a six-sided die miss a face with probability ~6·(5/6)^200 ≈ 10^-15.
    expect(seen.size).toBe(6);
  });

  it("default deps handle negative ranges and the extreme bounds", () => {
    const { value } = randomNumberTool.execute(
      { min: -20, max: -10 },
      defaultTutorToolDeps,
      NO_PRIOR_CALLS,
    );
    expect(value).toBeGreaterThanOrEqual(-20);
    expect(value).toBeLessThanOrEqual(-10);
    const extreme = randomNumberTool.execute(
      { min: -RANDOM_NUMBER_BOUND, max: RANDOM_NUMBER_BOUND },
      defaultTutorToolDeps,
      NO_PRIOR_CALLS,
    );
    expect(Number.isInteger(extreme.value)).toBe(true);
    expect(Math.abs(extreme.value)).toBeLessThanOrEqual(RANDOM_NUMBER_BOUND);
  });

  it("output matches the declared output schema", () => {
    const out = randomNumberTool.execute({ min: 1, max: 3 }, fixedDeps(2), NO_PRIOR_CALLS);
    expect(randomNumberTool.outputSchema.safeParse(out).success).toBe(true);
  });
});

describe("board", () => {
  const draw = {
    steps: [
      { op: "board", id: "dhcp", title: "DHCP", kind: "sequence" },
      { op: "box", id: "laptop", text: "Laptop" },
      { op: "box", id: "server", text: "DHCP server" },
      { op: "arrow", id: "discover", from: "laptop", to: "server", text: "Discover" },
    ],
  };

  it("draws on an empty board and returns the summary", () => {
    expect(boardTool.execute(draw, defaultTutorToolDeps, NO_PRIOR_CALLS)).toEqual({
      ok: true,
      board: "board dhcp (sequence): laptop, server\n  arrows: discover",
    });
  });

  it("applies on top of the thread's prior calls", () => {
    const out = boardTool.execute(
      { steps: [{ op: "highlight", ids: ["discover", "ghost"] }] },
      defaultTutorToolDeps,
      { priorCalls: [draw] },
    );
    expect(out).toEqual({
      ok: true,
      board: "board dhcp (sequence): laptop, server\n  arrows: discover",
      warnings: ['steps[0] (highlight): ignored "ghost"; not on the board'],
    });
  });

  it("rejects a call with errors and names them", () => {
    const out = boardTool.execute(
      { steps: [{ op: "box", id: "laptop", text: "Again" }] },
      defaultTutorToolDeps,
      { priorCalls: [draw] },
    );
    expect(out).toEqual({
      ok: false,
      errors: [
        'steps[0] (box "laptop"): id "laptop" is already used; ids are never reused, pick a new one',
      ],
    });
  });

  it("is stateful, and its outputs match the declared output schema", () => {
    expect(boardTool.stateful).toBe(true);
    expect(tutorToolCatalog.random_number.stateful).toBeUndefined();
    const good = boardTool.execute(draw, defaultTutorToolDeps, NO_PRIOR_CALLS);
    const bad = boardTool.execute({ steps: [] }, defaultTutorToolDeps, NO_PRIOR_CALLS);
    expect(boardTool.outputSchema.safeParse(good).success).toBe(true);
    expect(boardTool.outputSchema.safeParse(bad).success).toBe(true);
  });

  it("keeps the input schema loose: the board's checks explain mistakes", () => {
    expect(boardTool.inputSchema.safeParse({ steps: [{ op: "anything", x: 1 }] }).success).toBe(
      true,
    );
    expect(boardTool.inputSchema.safeParse({}).success).toBe(false);
  });
});
