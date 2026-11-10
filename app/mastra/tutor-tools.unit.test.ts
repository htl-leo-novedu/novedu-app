import { describe, expect, it, vi } from "vitest";

// The binding imports the store, which imports the DB pool; the tests inject
// the store seam instead, so the module is never touched.
vi.mock("@/lib/tutor-board-store", () => ({ loadThreadBoardCalls: vi.fn() }));

const { priorCallsFor, selectTutorTools } = await import("./tutor-tools");

const call = (id: string, title: string, ok = true, state = "result") => ({
  type: "tool-invocation",
  toolInvocation: {
    state,
    toolCallId: id,
    toolName: "board",
    args: { steps: [{ op: "board", id: title, title }] },
    result: ok ? { ok: true, board: "" } : { ok: false, errors: ["x"] },
  },
});
const assistant = (...parts: unknown[]) => ({ role: "assistant", content: { format: 2, parts } });
const input = (title: string) => ({ steps: [{ op: "board", id: title, title }] });

describe("priorCallsFor", () => {
  it("returns no prior calls without an agent context", async () => {
    expect(await priorCallsFor(undefined)).toEqual({ priorCalls: [] });
    expect(await priorCallsFor({})).toEqual({ priorCalls: [] });
  });

  it("reads the stored thread first, then this run's calls, deduplicated by id", async () => {
    const loadThreadCalls = vi.fn(async () => [
      { id: "c1", input: input("a") },
      { id: "c2", input: input("b") },
    ]);
    const prior = await priorCallsFor(
      {
        agent: {
          toolCallId: "now",
          threadId: "thread-1",
          resourceId: "code1",
          // the memory window repeats c2 and holds this run's c3 and the current call
          getMessages: () => [
            assistant(call("c2", "b")),
            assistant(call("c3", "c"), call("bad", "x", false), call("now", "n", true, "call")),
          ],
        },
      },
      { loadThreadCalls },
    );
    expect(loadThreadCalls).toHaveBeenCalledWith("code1", "thread-1");
    expect(prior.priorCalls).toEqual([input("a"), input("b"), input("c")]);
  });

  it("uses only this run's calls without a thread (the eval tutor)", async () => {
    const loadThreadCalls = vi.fn(async () => []);
    const prior = await priorCallsFor(
      { agent: { toolCallId: "now", getMessages: () => [assistant(call("c1", "a"))] } },
      { loadThreadCalls },
    );
    expect(loadThreadCalls).not.toHaveBeenCalled();
    expect(prior.priorCalls).toEqual([input("a")]);
  });

  it("fails the call on a database error instead of drawing on a board it cannot see", async () => {
    await expect(
      priorCallsFor(
        { agent: { toolCallId: "now", threadId: "t", resourceId: "c" } },
        {
          loadThreadCalls: async () => {
            throw new Error("db down");
          },
        },
      ),
    ).rejects.toThrow("db down");
  });

  it("never counts the call being executed", async () => {
    const prior = await priorCallsFor(
      { agent: { toolCallId: "c1", threadId: "t", resourceId: "c" } },
      { loadThreadCalls: async () => [{ id: "c1", input: input("a") }] },
    );
    expect(prior.priorCalls).toEqual([]);
  });
});

describe("selectTutorTools", () => {
  it("binds the board tool by name", () => {
    expect(Object.keys(selectTutorTools(["board", "random_number"]))).toEqual([
      "board",
      "random_number",
    ]);
  });
});
