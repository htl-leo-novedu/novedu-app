import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../auth";
import { cliVersion } from "../version";
import { expandSources, registerEval, runEvalCommand } from "./eval";

// The eval command end to end in-process: the eval files and the quiz they target are
// REAL fixtures (so the grading prompts are the app's own), auth and fetch are mocked
// like in the reports/codes command tests. Covers the request body, the retry path,
// --json/--out, the exit codes, the LLM override rule, the FEEDBACK JUDGE's flags and
// request shape, batch mode incl. globbing, and the advisory CLI/server version check.

vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return { ...actual, getAccessToken: vi.fn() };
});

const evalsDir = fileURLToPath(
  new URL("../../../test-fixtures/activities/evals/", import.meta.url),
);
const okEval = join(evalsDir, "test-eval.yaml");
const mismatchEval = join(evalsDir, "mismatch-eval.yaml");
const brokenEval = join(evalsDir, "broken-eval.yaml");
/** Verdicts all match; one answer plants a `[judge:…]` marker the fake judge flags. */
const judgeEval = join(evalsDir, "judge-eval.yaml");
/** A TUTOR eval whose `[respond:…]` markers make the fake generator answer predictably. */
const tutorEval = join(evalsDir, "tutor-eval.yaml");
/** The same, with one case's generated response carrying a `[judge:…]` marker. */
const tutorJudgeEval = join(evalsDir, "tutor-judge-eval.yaml");

const fetchMock = vi.fn();

function run(...args: string[]): Promise<Command> {
  const program = new Command();
  registerEval(program);
  return program.parseAsync(["eval", ...args], { from: "user" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The last request's parsed JSON body. */
function lastBody(): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls.at(-1) as [URL, RequestInit])[1].body as string);
}

/** The fake grader: `correct` unless the answer carries a `[grade:…]` marker. */
function grader(): Response {
  const marker = /\[grade:(correct|partial|incorrect)\]/.exec(String(lastBody().answer));
  return jsonResponse({ result: marker?.[1] ?? "correct", feedback: "ok" });
}

/** The fake judge: clean unless the subject carries `[judge:<criterion>]` markers. */
function judge(): Response {
  const issues = [...String(lastBody().subject).matchAll(/\[judge:([a-z_]+)\]/g)].map((match) => ({
    criterion: match[1],
    note: `flagged ${match[1]}`,
  }));
  return jsonResponse({ issues });
}

/** The run also probes GET /api/version once — never a grading or judge call. */
function isVersionProbe(input: unknown): boolean {
  return String(input).endsWith("/api/version");
}

function isJudgeCall(input: unknown): boolean {
  return String(input).endsWith("/api/eval/judge");
}

function isRespondCall(input: unknown): boolean {
  return String(input).endsWith("/api/eval/respond");
}

/**
 * The fake tutor: the generated turn is the `[respond:<text>]` payload of the LAST
 * message (greedy to the final bracket, so a nested `[judge:…]` marker survives), else a
 * canned echo — the same convention as the fixtures server.
 */
function responder(): Response {
  const messages = lastBody().messages as { text: string }[];
  const last = String(messages.at(-1)?.text ?? "");
  const marker = /\[respond:([\s\S]*)\]/.exec(last);
  return jsonResponse({ text: marker ? marker[1] : `fake tutor answers: ${last}` });
}

/** Routes one request to the right fake, so a test never has to branch by hand. */
function serve(input: unknown, versionAnswer = jsonResponse({ cliVersion: cliVersion() })) {
  if (isVersionProbe(input)) return versionAnswer;
  if (isJudgeCall(input)) return judge();
  return isRespondCall(input) ? responder() : grader();
}

/** Only the GRADING requests, so counts stay about grading and not about probes/judging. */
function gradeCalls(): Array<[URL, RequestInit]> {
  return fetchMock.mock.calls.filter(
    (call) =>
      !isVersionProbe((call as unknown[])[0]) &&
      !isJudgeCall((call as unknown[])[0]) &&
      !isRespondCall((call as unknown[])[0]),
  ) as Array<[URL, RequestInit]>;
}

/** Only the tutor GENERATION requests. */
function respondCalls(): Array<[URL, RequestInit]> {
  return fetchMock.mock.calls.filter((call) => isRespondCall((call as unknown[])[0])) as Array<
    [URL, RequestInit]
  >;
}

/** Only the JUDGE requests. */
function judgeCalls(): Array<[URL, RequestInit]> {
  return fetchMock.mock.calls.filter((call) => isJudgeCall((call as unknown[])[0])) as Array<
    [URL, RequestInit]
  >;
}

/** Everything the run wrote to stderr (warnings + progress), joined. */
function stderrText(): string {
  return stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");
}

let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let dir: string;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.mocked(getAccessToken).mockResolvedValue("token-123");
  // The default server is in sync with this CLI, so the version check stays silent.
  fetchMock.mockImplementation(async (input: unknown) => serve(input));
  dir = mkdtempSync(join(tmpdir(), "novedu-eval-unit-"));
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  stderr.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("eval — the request", () => {
  it("POSTs one grading call per golden answer with the quiz's llm and the real prompt", async () => {
    await run(okEval, "--server", "http://localhost:1234");

    expect(gradeCalls()).toHaveLength(2);
    const [url, init] = gradeCalls()[0] as [URL, RequestInit];
    expect(url.href).toBe("http://localhost:1234/api/eval/grade");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");

    const body = JSON.parse(init.body as string);
    expect(body.llm).toEqual({ provider: "SCCH", model: "test-model" });
    // The system prompt is the app's own grading prompt for q1, not a copy.
    expect(body.system).toContain("The answer is 4.");
    expect(body.answer).toContain("two plus two");
    expect(process.exitCode).toBe(0);
  });

  it("prints the single-count scope line when judging is off", async () => {
    await run(okEval, "--no-judge-feedback", "--server", "http://x");

    expect(stderrText()).toContain("2 case(s) × 1 repeat(s) = 2 grading call(s)");
    expect(stderrText()).not.toContain("judge call(s)");
  });

  it("expands --repeats into observations of the same case", async () => {
    await run(okEval, "--repeats", "3", "--server", "http://x");

    expect(gradeCalls()).toHaveLength(6);
    expect(process.exitCode).toBe(0);
  });
});

describe("eval — failures and retries", () => {
  it("retries a 504 and succeeds on the next attempt", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (input: unknown) => {
      if (isVersionProbe(input) || isJudgeCall(input)) return serve(input);
      calls += 1;
      return calls === 1 ? jsonResponse({ message: "Gateway timeout" }, 504) : grader();
    });

    // Called through the core so the 5 s production backoff can be shrunk.
    await runEvalCommand([okEval], { server: "http://x" }, { retry: { baseDelayMs: 0 } });

    expect(gradeCalls()).toHaveLength(3); // 1 failed + 1 retry + 1
    expect(process.exitCode).toBe(0);
  });

  it("exits 1 on a mismatch and lists it in the report", async () => {
    await run(mismatchEval, "--server", "http://x");

    expect(process.exitCode).toBe(1);
    const report = log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(report).toContain("q1#1");
    expect(report).toContain("expected correct");
  });

  it("reports an unusable eval file as JSON on stderr, exit 1, without grading", async () => {
    await run(brokenEval, "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(payload.errors.length).toBeGreaterThan(0);
    expect(payload.errors[0].code).toBe("EVAL_SCHEMA");
  });
});

describe("eval — output", () => {
  it("prints the batch shape with --json, even for a single file", async () => {
    await run(okEval, "--json", "--server", "http://x");

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].status).toBe("ok");
    expect(payload.files[0].result.id).toBe("test-eval");
    expect(payload.totals).toMatchObject({ files: 1, cases: 2, passed: 2, failed: 0 });
  });

  it("writes the same JSON to --out", async () => {
    const out = join(dir, "report.json");

    await run(okEval, "--out", out, "--server", "http://x");

    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.totals.cases).toBe(2);
  });

  it("carries the CI verdict as `passed`, per batch and per file", async () => {
    await run(okEval, "--json", "--server", "http://x");

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.passed).toBe(true);
    expect(payload.files[0].passed).toBe(true);
  });

  it("writes the Markdown report to --report without touching stdout", async () => {
    const report = join(dir, "report.md");

    await run(okEval, "--json", "--report", report, "--server", "http://x");

    // stdout is still exactly the JSON payload.
    expect(() => JSON.parse(String(log.mock.calls[0]?.[0]))).not.toThrow();
    const md = readFileSync(report, "utf8");
    expect(md).toContain("# Eval report — ✅ passed");
    expect(md).toContain("test-eval");
  });

  it("reports an unwritable --report path as JSON on stderr", async () => {
    await run(okEval, "--report", join(dir, "missing-dir", "report.md"), "--server", "http://x");

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(error.mock.calls[0]?.[0]));
    expect(payload.message).toContain("Could not write");
  });
});

describe("eval — the LLM override", () => {
  it("rejects half a pair before any request", async () => {
    await run(okEval, "--llm-provider", "SCCH", "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("--llm-provider and --llm-model together");
  });

  it("rejects an unknown provider", async () => {
    await run(okEval, "--llm-provider", "OpenAI", "--llm-model", "gpt", "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sends the override on every request and marks the run as overridden", async () => {
    await run(
      okEval,
      "--llm-provider",
      "Azure Foundry",
      "--llm-model",
      "gpt-5-mini",
      "--json",
      "--server",
      "http://x",
    );

    for (const call of gradeCalls()) {
      const body = JSON.parse(call[1].body as string);
      expect(body.llm).toEqual({ provider: "Azure Foundry", model: "gpt-5-mini" });
    }
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm).toMatchObject({
      provider: "Azure Foundry",
      model: "gpt-5-mini",
      overrides: { provider: "SCCH", model: "test-model" },
    });
  });

  // The quiz fixture declares no `llm.reasoning`, so a run without the flag must send a
  // body with NO `reasoning` key at all — that is what keeps this CLI working against a
  // server whose eval routes never heard of the field.
  it("omits reasoning from every body when nothing asks for a level", async () => {
    await run(okEval, "--json", "--server", "http://x");

    for (const call of [...gradeCalls(), ...judgeCalls()]) {
      const body = JSON.parse(call[1].body as string);
      expect("reasoning" in body.llm).toBe(false);
    }
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm.reasoning).toBeUndefined();
    // Nothing was overridden, so the report must not claim a comparison run.
    expect(payload.files[0].result.llm.overrides).toBeUndefined();
  });

  it("--llm-reasoning alone keeps the activity's pair and overrides only the effort", async () => {
    await run(okEval, "--llm-reasoning", "high", "--json", "--server", "http://x");

    for (const call of gradeCalls()) {
      expect(JSON.parse(call[1].body as string).llm).toEqual({
        provider: "SCCH",
        model: "test-model",
        reasoning: "high",
      });
    }
    // The judge follows the EFFECTIVE grading spec, level included.
    for (const call of judgeCalls()) {
      expect(JSON.parse(call[1].body as string).llm).toEqual({
        provider: "SCCH",
        model: "test-model",
        reasoning: "high",
      });
    }
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm).toMatchObject({
      provider: "SCCH",
      model: "test-model",
      reasoning: "high",
      // The run did NOT grade what the file asked for, so it is recorded as an override.
      overrides: { provider: "SCCH", model: "test-model" },
    });
  });

  it("rejects an unknown reasoning level before any request", async () => {
    await run(okEval, "--llm-reasoning", "turbo", "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0])).message).toContain(
      'Unknown --llm-reasoning "turbo"',
    );
  });
});

describe("eval — the feedback judge", () => {
  it("judges every graded answer by default, on the grading pair, with the platform prompt", async () => {
    await run(okEval, "--server", "http://localhost:1234");

    expect(judgeCalls()).toHaveLength(2);
    const [url, init] = judgeCalls()[0] as [URL, RequestInit];
    expect(url.href).toBe("http://localhost:1234/api/eval/judge");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token-123");

    const body = JSON.parse(init.body as string);
    // No judge pair given ⇒ the effective GRADING pair, not a hardcoded model.
    expect(body.llm).toEqual({ provider: "SCCH", model: "test-model" });
    expect(body.system).toContain("You are auditing the FEEDBACK");
    expect(body.criteria).toEqual([
      "contradicts_verdict",
      "misstates_facts",
      "ignores_instructions",
      "leaks_rubric",
    ]);
    // The subject carries the grading prompt, the golden answer, the verdict and the
    // feedback — everything the judge needs to measure the text against its own standard.
    expect(body.subject).toContain("The answer is 4.");
    expect(body.subject).toContain("two plus two");
    expect(body.subject).toContain("=== The grader's verdict ===\ncorrect");
    expect(body.subject).toContain("=== The grader's feedback (JUDGE THIS) ===\nok");
  });

  it("sends NO judge request at all with --no-judge-feedback", async () => {
    await run(okEval, "--no-judge-feedback", "--json", "--server", "http://x");

    expect(gradeCalls()).toHaveLength(2);
    expect(judgeCalls()).toHaveLength(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.judging).toBe("off");
    // A run that judged nothing must not advertise a judge model.
    expect(payload.files[0].result.llm.judge).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("uses the --judge-llm-* pair when given and records it as an override", async () => {
    await run(
      okEval,
      "--judge-llm-provider",
      "Azure Foundry",
      "--judge-llm-model",
      "gpt-5.6-terra",
      "--json",
      "--server",
      "http://x",
    );

    for (const call of judgeCalls()) {
      const body = JSON.parse(call[1].body as string);
      expect(body.llm).toEqual({ provider: "Azure Foundry", model: "gpt-5.6-terra" });
    }
    // The grading half is untouched by the judge pair.
    for (const call of gradeCalls()) {
      expect(JSON.parse(call[1].body as string).llm).toEqual({
        provider: "SCCH",
        model: "test-model",
      });
    }
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm.judge).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5.6-terra",
      overridden: true,
    });
  });

  it("falls back to the --llm-* override, not the quiz's pair, when only grading is overridden", async () => {
    await run(
      okEval,
      "--llm-provider",
      "Azure Foundry",
      "--llm-model",
      "gpt-5-mini",
      "--json",
      "--server",
      "http://x",
    );

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm.judge).toEqual({
      provider: "Azure Foundry",
      model: "gpt-5-mini",
      overridden: false,
    });
  });

  it("rejects half a judge pair before any request", async () => {
    await run(okEval, "--judge-llm-model", "gpt-5.6-terra", "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "--judge-llm-provider and --judge-llm-model together",
    );
  });

  it("rejects an unknown judge provider", async () => {
    await run(
      okEval,
      "--judge-llm-provider",
      "OpenAI",
      "--judge-llm-model",
      "gpt",
      "--server",
      "http://x",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0])).message).toContain(
      'Unknown --judge-llm-provider "OpenAI"',
    );
  });

  it("--judge-llm-reasoning overrides only the judge's effort, leaving grading alone", async () => {
    await run(okEval, "--judge-llm-reasoning", "high", "--json", "--server", "http://x");

    for (const call of judgeCalls()) {
      expect(JSON.parse(call[1].body as string).llm).toEqual({
        provider: "SCCH",
        model: "test-model",
        reasoning: "high",
      });
    }
    // Overriding the judge never changes who grades — nor at what effort.
    for (const call of gradeCalls()) {
      const body = JSON.parse(call[1].body as string);
      expect(body.llm).toEqual({ provider: "SCCH", model: "test-model" });
    }
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files[0].result.llm.judge).toEqual({
      provider: "SCCH",
      model: "test-model",
      reasoning: "high",
      overridden: true,
    });
  });

  it("rejects an unknown judge reasoning level before any request", async () => {
    await run(okEval, "--judge-llm-reasoning", "turbo", "--server", "http://x");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0])).message).toContain(
      'Unknown --judge-llm-reasoning "turbo"',
    );
  });

  it("rejects --judge-llm-reasoning combined with --no-judge-feedback", async () => {
    await run(
      okEval,
      "--no-judge-feedback",
      "--judge-llm-reasoning",
      "high",
      "--server",
      "http://x",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "cannot be combined with --no-judge-feedback",
    );
  });

  it("rejects a judge pair combined with --no-judge-feedback as contradictory", async () => {
    await run(
      okEval,
      "--no-judge-feedback",
      "--judge-llm-provider",
      "SCCH",
      "--judge-llm-model",
      "m",
      "--server",
      "http://x",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "cannot be combined with --no-judge-feedback",
    );
  });

  it("reports a flagged feedback without failing the run", async () => {
    await run(judgeEval, "--json", "--server", "http://x");

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    const result = payload.files[0].result;
    expect(result.judging).toBe("on");
    expect(result.totals.feedbackFlagged).toBe(1);
    expect(result.cases[0].repeats[0].judge.issues[0].criterion).toBe("ignores_instructions");
    // REPORT-ONLY: every verdict matched, so the run is green all the way to exit 0.
    expect(payload.passed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("degrades instead of aborting when the judge keeps failing", async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      isJudgeCall(input) ? jsonResponse({ message: "Gateway timeout" }, 504) : serve(input),
    );

    // 2 cases × 2 repeats = 4 judge calls, run serially so the 3-in-a-row breaker
    // trips deterministically on the third.
    await runEvalCommand(
      [okEval],
      { server: "http://x", json: true, repeats: "2", concurrency: "1" },
      { retry: { attempts: 1, baseDelayMs: 0 } },
    );

    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    // Every answer was still GRADED — a down judge must not cost a rubric run.
    expect(gradeCalls()).toHaveLength(4);
    expect(judgeCalls()).toHaveLength(3); // the 4th was skipped, not attempted
    expect(payload.files[0].result.judging).toBe("degraded");
    expect(payload.passed).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(stderrText()).toContain("feedback judging was stopped");
  });
});

describe("eval — batch mode", () => {
  it("evaluates several files, reporting per file plus grand totals", async () => {
    await run(okEval, mismatchEval, "--server", "http://x");

    expect(gradeCalls()).toHaveLength(4);
    expect(process.exitCode).toBe(1);
    const report = log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(report).toContain("Evaluated 2 file(s)");
    expect(report).toContain("test-eval.yaml");
    expect(report).toContain("TOTAL: 4 case(s), 3 passed, 1 failed");
  });

  it("keeps going when ONE file among several is invalid, and still exits 1", async () => {
    await run(okEval, brokenEval, "--json", "--server", "http://x");

    expect(gradeCalls()).toHaveLength(2); // only the valid file was graded
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.files.map((f: { status: string }) => f.status)).toEqual(["ok", "invalid"]);
    expect(payload.totals.invalid).toBe(1);
  });

  it("dedupes a repeated source with a warning", async () => {
    await run(okEval, okEval, "--server", "http://x");

    expect(gradeCalls()).toHaveLength(2);
    expect(stderrText()).toContain("was given more than once");
  });
});

describe("eval — the CLI/server version check", () => {
  /** Answer the probe with `body`, or fail the fetch when `body` is an Error. */
  function probeAnswers(body: unknown, status = 200): void {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (!isVersionProbe(input)) return serve(input);
      if (body instanceof Error) throw body;
      return jsonResponse(body, status);
    });
  }

  it("probes GET /api/version once, unauthenticated, before the first grading call", async () => {
    await run(okEval, "--server", "http://localhost:1234");

    const probes = fetchMock.mock.calls.filter((call) => isVersionProbe((call as unknown[])[0]));
    expect(probes).toHaveLength(1);
    const [url, init] = probes[0] as [URL, RequestInit | undefined];
    expect(url.href).toBe("http://localhost:1234/api/version");
    expect(init?.method ?? "GET").toBe("GET");
    expect(init?.headers).toBeUndefined(); // no bearer token on a public probe
    // …and it really came first: no grading call was made before it.
    expect(isVersionProbe((fetchMock.mock.calls[0] as unknown[])[0])).toBe(true);
  });

  it("stays silent when the server was built with this CLI", async () => {
    await run(okEval, "--server", "http://x");

    expect(stderrText()).not.toContain("Warning:");
    expect(process.exitCode).toBe(0);
  });

  it("warns on stderr naming both versions when they differ, without changing the run", async () => {
    probeAnswers({ cliVersion: "9.9.9" });

    await run(okEval, "--json", "--server", "http://x");

    const warning = stderrText();
    expect(warning).toContain(`this CLI is ${cliVersion()}`);
    expect(warning).toContain("the server was built with CLI 9.9.9");
    expect(warning).toContain("npm i -g @novedu/cli");
    // Advisory only: every case still graded, JSON intact, exit code untouched.
    expect(gradeCalls()).toHaveLength(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).passed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("warns that it could not verify when the server reports no cliVersion", async () => {
    probeAnswers({ version: "0.1.0.7", gitSha: "abc", builtAt: "unknown" });

    await run(okEval, "--server", "http://x");

    expect(stderrText()).toContain("could not verify");
    expect(gradeCalls()).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it("warns that it could not verify on a non-2xx answer", async () => {
    probeAnswers({ message: "Not found" }, 404);

    await run(okEval, "--server", "http://x");

    expect(stderrText()).toContain("answered HTTP 404");
    expect(gradeCalls()).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it("warns that it could not verify when the answer is not JSON (a sign-in page)", async () => {
    fetchMock.mockImplementation(async (input: unknown) =>
      serve(
        input,
        new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
      ),
    );

    await run(okEval, "--server", "http://x");

    expect(stderrText()).toContain("could not verify");
    expect(gradeCalls()).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it("warns that it could not verify when the probe fails outright", async () => {
    probeAnswers(new Error("ECONNREFUSED"));

    await run(okEval, "--server", "http://x");

    const warning = stderrText();
    expect(warning).toContain("could not verify");
    expect(warning).toContain("ECONNREFUSED");
    expect(gradeCalls()).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it("never writes the warning to stdout", async () => {
    probeAnswers({ cliVersion: "9.9.9" });

    await run(okEval, "--json", "--server", "http://x");

    expect(() => JSON.parse(String(log.mock.calls[0]?.[0]))).not.toThrow();
    expect(log.mock.calls.map((call: unknown[]) => String(call[0])).join("")).not.toContain(
      "Warning:",
    );
  });
});

describe("expandSources", () => {
  it("passes URLs and plain paths through untouched", () => {
    const result = expandSources(["https://example.com/a.eval.yaml", okEval]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sources[0]).toBe("https://example.com/a.eval.yaml");
    expect(result.sources[1]).toMatch(/^file:\/\/.*test-eval\.yaml$/);
  });

  it("expands a glob deterministically", () => {
    const result = expandSources([join(evalsDir, "*.yaml")]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sources).toHaveLength(9);
    expect(result.sources.map((s) => s.split("/").pop())).toEqual([
      "broken-eval.yaml",
      "broken-tutor-eval.yaml",
      "judge-eval.yaml",
      "mismatch-eval.yaml",
      "test-eval.yaml",
      "tutor-eval.yaml",
      "tutor-judge-eval.yaml",
      "tutor-old-server-eval.yaml",
      "tutor-tools-eval.yaml",
    ]);
  });

  it("hard-fails a pattern that matches nothing", () => {
    const result = expandSources([join(evalsDir, "*.nope.yaml")]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("matched no files");
  });

  it("reports duplicates instead of evaluating them twice", () => {
    const result = expandSources([okEval, okEval]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sources).toHaveLength(1);
    expect(result.duplicates).toHaveLength(1);
  });
});

describe("eval — the tutor kind", () => {
  it("infers the kind from the file and POSTs one generation call per conversation", async () => {
    await run(tutorEval, "--server", "http://localhost:1234");

    expect(gradeCalls()).toHaveLength(0);
    const calls = respondCalls();
    expect(calls).toHaveLength(2);
    expect(String(calls[0]?.[0])).toBe("http://localhost:1234/api/eval/respond");

    const body = JSON.parse(calls[0]?.[1].body as string);
    // The tutor's own model, its real assembled system prompt and its `tools:` grant.
    expect(body.llm).toEqual({ provider: "SCCH", model: "test-model" });
    expect(body.system).toContain("NEVER-SOLVE-MARKER");
    expect(body.tools).toEqual([]);
    // Teacher-facing roles mapped to the wire ones, ending on the student turn.
    expect(body.messages.at(-1).role).toBe("user");
    expect(process.exitCode).toBe(0);
  });

  it("sends the multi-turn conversation verbatim, in order", async () => {
    await run(tutorEval, "--server", "http://localhost:1234");

    const body = JSON.parse(respondCalls()[1]?.[1].body as string);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[1].text).toBe("What have you tried so far?");
  });

  it("judges each generated response against the tutor prompt, with the case's criteria", async () => {
    await run(tutorEval, "--server", "http://localhost:1234");

    const judged = judgeCalls().map((call) => JSON.parse(call[1].body as string));
    expect(judged).toHaveLength(2);
    expect(judged[0].system).toContain("You are auditing ONE response an AI TUTOR gave");
    expect(judged[0].subject).toContain("NEVER-SOLVE-MARKER");
    expect(judged[0].subject).toContain("What does your condition evaluate to?");
    // The first case states expectations, the second does not.
    expect(judged[0].criteria).toContain("fails_expectations");
    expect(judged[1].criteria).not.toContain("fails_expectations");
  });

  it("reports a flagged response WITHOUT failing the run", async () => {
    await run(tutorJudgeEval, "--json", "--server", "http://localhost:1234");

    const payload = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    const result = payload.files[0].result;
    expect(payload.files[0].kind).toBe("tutor");
    expect(result.kind).toBe("tutor");
    expect(result.judging).toBe("on");
    expect(result.totals.feedbackFlagged).toBe(1);
    expect(result.cases[0].repeats[0].judge.issues[0].criterion).toBe("ignores_instructions");
    // The generated text rides along in the JSON for every repeat, flagged or not.
    expect(result.cases[0].repeats[0].text).toContain("Here is the whole loop");
    expect(result.cases[1].repeats[0].text).toBe("What does your condition evaluate to?");
    // REPORT-ONLY: the exit code reflects run health only.
    expect(payload.passed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("sends ZERO judge requests with --no-judge-feedback", async () => {
    await run(tutorEval, "--no-judge-feedback", "--json", "--server", "http://localhost:1234");

    expect(judgeCalls()).toHaveLength(0);
    expect(stderrText()).toContain("2 conversation(s) × 1 repeat(s) = 2 generation call(s)");
    const result = JSON.parse(log.mock.calls.at(-1)?.[0] as string).files[0].result;
    expect(result.judging).toBe("off");
  });

  it("reports a conversation that does not end with a student turn as invalid", async () => {
    await run(join(evalsDir, "broken-tutor-eval.yaml"), "--server", "http://localhost:1234");

    expect(respondCalls()).toHaveLength(0);
    const payload = JSON.parse(error.mock.calls.at(-1)?.[0] as string);
    expect(payload.errors[0].code).toBe("EVAL_SCHEMA");
    expect(process.exitCode).toBe(1);
  });

  it("runs a MIXED batch, one scope line per kind, one JSON shape", async () => {
    await run(okEval, tutorEval, "--json", "--server", "http://localhost:1234");

    // Each file went to its own endpoint.
    expect(gradeCalls()).toHaveLength(2);
    expect(respondCalls()).toHaveLength(2);
    // Two scope lines — "case" and "conversation" are different units.
    expect(stderrText()).toContain("2 case(s) × 1 repeat(s) = 2 grading + 2 judge call(s)");
    expect(stderrText()).toContain(
      "2 conversation(s) × 1 repeat(s) = 2 generation + 2 judge call(s)",
    );

    const payload = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    expect(payload.files.map((file: { kind?: string }) => file.kind)).toEqual(["quiz", "tutor"]);
    expect(payload.totals).toMatchObject({ files: 2, cases: 4, invalid: 0 });
    expect(payload.passed).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("applies the --llm override to the tutor under test", async () => {
    await run(
      tutorEval,
      "--llm-provider",
      "Azure Foundry",
      "--llm-model",
      "gpt-5-mini",
      "--server",
      "http://localhost:1234",
    );

    const body = JSON.parse(respondCalls()[0]?.[1].body as string);
    expect(body.llm).toEqual({ provider: "Azure Foundry", model: "gpt-5-mini" });
  });
});
