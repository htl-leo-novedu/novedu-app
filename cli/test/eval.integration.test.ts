import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixturesServer } from "../../test-fixtures/serve.mjs";

// `novedu-cli eval` end to end through the REAL built CLI binary (`node dist/main.js`)
// against the fixtures server's fake `/api/eval/grade` — fully offline, no sign-in (the
// CLI reads NOVEDU_TOKEN, see cli/src/auth.ts). The eval files and the quiz they target
// are the committed fixtures, so the grading prompts are the app's own.
//
// Run via `npm run test:cli` — it builds the CLI first, so `dist/main.js` exists.

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const evalsDir = fileURLToPath(new URL("../../test-fixtures/activities/evals/", import.meta.url));
const okEval = join(evalsDir, "test-eval.yaml");
const mismatchEval = join(evalsDir, "mismatch-eval.yaml");
const brokenEval = join(evalsDir, "broken-eval.yaml");
/** Every verdict matches; one answer plants a `[judge:…]` marker the fake judge flags. */
const judgeEval = join(evalsDir, "judge-eval.yaml");
/** A TUTOR eval: the fake generator echoes each case's `[respond:…]` payload. */
const tutorEval = join(evalsDir, "tutor-eval.yaml");
/** The same, with one generated response carrying a `[judge:…]` marker. */
const tutorJudgeEval = join(evalsDir, "tutor-judge-eval.yaml");
/** A tutor eval whose conversation ends on a `tutor:` turn — schema-invalid. */
const brokenTutorEval = join(evalsDir, "broken-tutor-eval.yaml");
/** Three `required_tools` cases: the tool ran, it did not, and it ran plus an extra. */
const tutorToolsEval = join(evalsDir, "tutor-tools-eval.yaml");
/** A `required_tools` case answered in the shape of a server too old to report tool calls. */
const tutorOldServerEval = join(evalsDir, "tutor-old-server-eval.yaml");

let fixtures:
  | {
      server: Server;
      baseUrl: string;
      evalRequests: Array<Record<string, unknown>>;
      respondRequests: Array<Record<string, unknown>>;
      judgeRequests: Array<Record<string, unknown>>;
    }
  | undefined;
let retryFixtures: { server: Server; baseUrl: string } | undefined;
let staleFixtures: { server: Server; baseUrl: string } | undefined;
let dir: string;

beforeAll(async () => {
  fixtures = await startFixturesServer(0);
  // A second server whose first two grading calls answer 504, for the retry path.
  retryFixtures = await startFixturesServer(0, { evalFailures: 2 });
  // A third one built from a DIFFERENT CLI release, for the version warning.
  staleFixtures = await startFixturesServer(0, { cliVersion: "99.0.0" });
  dir = mkdtempSync(join(tmpdir(), "novedu-eval-integration-"));
});

afterAll(async () => {
  for (const handle of [fixtures?.server, retryFixtures?.server, staleFixtures?.server]) {
    if (handle) await new Promise<void>((resolve) => handle.close(() => resolve()));
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function baseUrl(): string {
  if (!fixtures) throw new Error("fixtures server not started");
  return fixtures.baseUrl;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, NOVEDU_TOKEN: "integration-test-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe("novedu-cli eval", () => {
  it("grades a local eval file and exits 0 when every case matches", async () => {
    const { code, stdout, stderr } = await runCli(["eval", okEval, "--server", baseUrl()]);

    expect(code).toBe(0);
    expect(stderr).toContain("2 case(s) × 1 repeat(s) = 2 grading + 2 judge call(s)");
    expect(stdout).toContain("Eval passed");
    expect(stdout).toContain("passed: 2");
    // The server really saw the app's grading prompt for q1.
    const seen = fixtures?.evalRequests.at(-1) as { system?: string } | undefined;
    expect(seen?.system).toContain("The answer is 4.");
    // …and the judge really received that same prompt as the standard to measure against.
    const judged = fixtures?.judgeRequests.at(-1) as
      | { system?: string; subject?: string; criteria?: string[] }
      | undefined;
    expect(judged?.system).toContain("You are auditing the FEEDBACK");
    expect(judged?.subject).toContain("The answer is 4.");
    expect(judged?.criteria).toContain("ignores_instructions");
  });

  it("grades an eval served over http and writes the batch JSON with --out", async () => {
    const out = join(dir, "report.json");

    const { code, stdout } = await runCli([
      "eval",
      `${baseUrl()}/evals/test-eval.yaml`,
      "--json",
      "--out",
      out,
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].result.id).toBe("test-eval");
    expect(payload.files[0].passed).toBe(true);
    expect(payload.passed).toBe(true);
    expect(payload.totals).toMatchObject({ files: 1, cases: 2, passed: 2, failed: 0 });
    // Both fakes report usage, so the aggregation really ran end to end — and grading
    // and judge tokens land in ONE bucket (2 gradings × 256 + 2 judgings × 128).
    expect(payload.totals.usage.input).toBeGreaterThan(0);
    expect(payload.totals.usage.output).toBeGreaterThan(0);
    expect(payload.totals.usage.cachedInput).toBe(2 * 256 + 2 * 128);
    expect(payload.files[0].result.cases[0].repeats[0].usage.input).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(payload);
  });

  it("writes a readable Markdown report with --report, alongside --json", async () => {
    const out = join(dir, "report.json");
    const report = join(dir, "report.md");

    const { code, stdout } = await runCli([
      "eval",
      mismatchEval,
      "--json",
      "--out",
      out,
      "--report",
      report,
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(1);
    // stdout stays the JSON — `--report` is a side channel.
    expect(JSON.parse(stdout).passed).toBe(false);
    const md = readFileSync(report, "utf8");
    expect(md).toContain("# Eval report — ❌ failed");
    expect(md).toContain("| File | Eval | Cases |");
    expect(md).toContain("### `q1` #1");
    expect(md).toContain("fixtures grader says");
    expect(md).toMatch(/- \*\*Tokens\*\* [\d,]+ in/);
  });

  it("exits 1 on a mismatch and names the case", async () => {
    const { code, stdout } = await runCli(["eval", mismatchEval, "--server", baseUrl()]);

    expect(code).toBe(1);
    expect(stdout).toContain("q1#1");
    expect(stdout).toContain("Eval failed");
  });

  it("retries a 504 and still finishes green", async () => {
    if (!retryFixtures) throw new Error("retry fixtures server not started");

    const { code, stdout } = await runCli([
      "eval",
      okEval,
      "--concurrency",
      "1",
      "--server",
      retryFixtures.baseUrl,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("passed: 2");
  }, 60_000);

  it("warns on stderr when the server was built with another CLI, but still grades", async () => {
    if (!staleFixtures) throw new Error("stale fixtures server not started");

    const { code, stdout, stderr } = await runCli([
      "eval",
      okEval,
      "--server",
      staleFixtures.baseUrl,
    ]);

    expect(stderr).toContain("the server was built with CLI 99.0.0");
    expect(stderr).toContain("npm i -g @novedu/cli");
    // Advisory only: the run is unaffected and stdout stays report-clean.
    expect(code).toBe(0);
    expect(stdout).toContain("passed: 2");
    expect(stdout).not.toContain("Warning:");
  });

  it("does not warn when the server ships this CLI version", async () => {
    const { code, stderr } = await runCli(["eval", okEval, "--server", baseUrl()]);

    expect(code).toBe(0);
    expect(stderr).not.toContain("Warning:");
  });

  it("flags the grader's feedback without failing the run", async () => {
    const report = join(dir, "judge-report.md");

    const { code, stdout } = await runCli([
      "eval",
      judgeEval,
      "--json",
      "--report",
      report,
      "--server",
      baseUrl(),
    ]);

    const payload = JSON.parse(stdout);
    const result = payload.files[0].result;
    expect(result.judging).toBe("on");
    expect(result.totals.feedbackFlagged).toBe(1);
    expect(result.cases[0].repeats[0].judge.issues[0].criterion).toBe("ignores_instructions");
    // REPORT-ONLY: every verdict matched, so the run is green all the way to exit 0.
    expect(payload.passed).toBe(true);
    expect(code).toBe(0);
    // Judge tokens land in the SAME bucket as the gradings.
    expect(payload.totals.usage.cachedInput).toBe(2 * 256 + 2 * 128);

    const md = readFileSync(report, "utf8");
    expect(md).toContain("# Eval report — ✅ passed");
    expect(md).toContain("### Flagged feedback");
    expect(md).toContain("- `ignores_instructions` — fixtures judge flagged");
  });

  it("sends ZERO judge requests with --no-judge-feedback", async () => {
    const before = fixtures?.judgeRequests.length ?? 0;

    const { code, stdout, stderr } = await runCli([
      "eval",
      judgeEval,
      "--no-judge-feedback",
      "--json",
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(0);
    expect(fixtures?.judgeRequests.length).toBe(before);
    expect(stderr).toContain("2 case(s) × 1 repeat(s) = 2 grading call(s)");
    const result = JSON.parse(stdout).files[0].result;
    expect(result.judging).toBe("off");
    expect(result.totals.feedbackFlagged).toBe(0);
  });

  // The judge's degrade breaker is deliberately NOT exercised here: through the built
  // binary it would mean exhausting real retry backoffs (minutes of sleeping) or a
  // test-only env seam in the shipped CLI. `cli/src/eval-run.unit.test.ts` covers it.

  it("reports an unusable eval file as JSON on stderr, exit 1", async () => {
    const { code, stdout, stderr } = await runCli(["eval", brokenEval, "--server", baseUrl()]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    const payload = JSON.parse(stderr);
    expect(payload.errors[0].code).toBe("EVAL_SCHEMA");
  });

  it("runs a multi-file batch, isolating the invalid file and exiting 1", async () => {
    const { code, stdout } = await runCli(["eval", okEval, brokenEval, "--server", baseUrl()]);

    expect(code).toBe(1);
    expect(stdout).toContain("Evaluated 2 file(s)");
    expect(stdout).toContain("test-eval.yaml");
    expect(stdout).toContain("invalid");
    expect(stdout).toContain("TOTAL: 2 case(s), 2 passed, 0 failed, 0 errored");
  });

  // The spawned binary has no TTY, so this is the real non-interactive condition: the
  // `\r` spinner is suppressed and each finished file must still announce itself, or a
  // long redirected run looks indistinguishable from a hang (see references/eval.md).
  it("prints a per-file completion line on stderr when stderr is not a TTY", async () => {
    const { stderr } = await runCli(["eval", okEval, "--server", baseUrl()]);

    expect(stderr).toContain("2 case(s), 2 passed, 0 failed, 0 errored");
    // Progress lines are newline-terminated, never carriage-return spinner noise.
    expect(stderr).not.toContain("\r");
  });

  it("labels each file in a batch's completion lines", async () => {
    const { stderr } = await runCli(["eval", okEval, brokenEval, "--server", baseUrl()]);

    expect(stderr).toContain("(1/2)");
  });
});

describe("novedu-cli validate --kind eval", () => {
  it("validates an eval offline", async () => {
    const { code, stdout } = await runCli(["validate", okEval, "--kind", "eval"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid eval");
    expect(stdout).toContain("cases: 2");
  });

  it("exits 1 on a broken eval", async () => {
    const { code, stdout } = await runCli(["validate", brokenEval, "--kind", "eval"]);

    expect(code).toBe(1);
    expect(stdout).toContain("Invalid eval");
  });
});

describe("novedu-cli eval — the tutor kind", () => {
  it("generates and judges every conversation, exiting 0", async () => {
    const { code, stdout, stderr } = await runCli(["eval", tutorEval, "--server", baseUrl()]);

    expect(code).toBe(0);
    expect(stderr).toContain("2 conversation(s) × 1 repeat(s) = 2 generation + 2 judge call(s)");
    expect(stdout).toContain("Eval passed");
    expect(stdout).toContain("ok: 2");

    // The server really saw the app's assembled tutor prompt and the wire-shaped turns.
    const seen = fixtures?.respondRequests.at(-1) as
      | { system?: string; tools?: string[]; messages?: { role: string; text: string }[] }
      | undefined;
    expect(seen?.system).toContain("NEVER-SOLVE-MARKER");
    expect(seen?.tools).toEqual([]);
    expect(seen?.messages?.at(-1)?.role).toBe("user");
    // …and the judge received that same prompt plus the GENERATED response.
    const judged = fixtures?.judgeRequests.at(-1) as
      | { system?: string; subject?: string; criteria?: string[] }
      | undefined;
    expect(judged?.system).toContain("You are auditing ONE response an AI TUTOR gave");
    expect(judged?.subject).toContain("NEVER-SOLVE-MARKER");
    expect(judged?.subject).toContain("Try writing the loop condition first.");
    // The second case states no expectations, so that criterion is not even offered.
    expect(judged?.criteria).not.toContain("fails_expectations");
  });

  it("reports a flagged response in the JSON and the Markdown, still exiting 0", async () => {
    const report = join(dir, "tutor-report.md");

    const { code, stdout } = await runCli([
      "eval",
      tutorJudgeEval,
      "--json",
      "--report",
      report,
      "--server",
      baseUrl(),
    ]);

    const payload = JSON.parse(stdout);
    const result = payload.files[0].result;
    expect(payload.files[0].kind).toBe("tutor");
    expect(result.judging).toBe("on");
    expect(result.totals.feedbackFlagged).toBe(1);
    expect(result.cases[0].repeats[0].judge.issues[0].criterion).toBe("ignores_instructions");
    expect(result.cases[0].repeats[0].text).toContain("Here is the whole loop");
    // REPORT-ONLY: the exit code reflects run health only.
    expect(payload.passed).toBe(true);
    expect(code).toBe(0);

    const md = readFileSync(report, "utf8");
    expect(md).toContain("# Eval report — ✅ passed");
    expect(md).toContain("### Flagged responses");
    expect(md).toContain("#### #1 hands-over-the-solution");
    expect(md).toContain("**Expectations for this case**");
    expect(md).toContain("**Generated response — repeat #1**");
    expect(md).toContain("- `ignores_instructions` — fixtures judge flagged");
  });

  it("retries a 504 from the respond endpoint and still finishes green", async () => {
    const retryTutor = await startFixturesServer(0, { respondFailures: 2 });
    try {
      const { code, stdout } = await runCli([
        "eval",
        tutorEval,
        "--concurrency",
        "1",
        "--server",
        retryTutor.baseUrl,
      ]);

      expect(code).toBe(0);
      expect(stdout).toContain("ok: 2");
    } finally {
      await new Promise<void>((resolve) => retryTutor.server.close(() => resolve()));
    }
  }, 60_000);

  it("reports a conversation that does not end with a student turn as unusable", async () => {
    const { code, stdout, stderr } = await runCli(["eval", brokenTutorEval, "--server", baseUrl()]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    const payload = JSON.parse(stderr);
    expect(payload.errors[0].code).toBe("EVAL_SCHEMA");
    expect(payload.errors[0].message).toContain("must end with a `student` turn");
  });

  it("checks required_tools end to end: satisfied, missing and extra calls", async () => {
    const report = join(dir, "tutor-tools-report.md");

    const { code, stdout } = await runCli([
      "eval",
      tutorToolsEval,
      "--json",
      "--report",
      report,
      "--server",
      baseUrl(),
    ]);

    const payload = JSON.parse(stdout);
    const result = payload.files[0].result;
    const [satisfied, missing, extra] = result.cases;

    expect(satisfied.requiredTools).toEqual(["random_number"]);
    expect(satisfied.repeats[0].toolCalls).toEqual(["random_number"]);
    expect(satisfied.repeats[0].missingTools).toEqual([]);
    expect(satisfied.toolsFlagged).toBe(false);

    expect(missing.repeats[0].toolCalls).toEqual([]);
    expect(missing.repeats[0].missingTools).toEqual(["random_number"]);
    expect(missing.toolsFlagged).toBe(true);

    // Extra calls are always fine — never a finding.
    expect(extra.repeats[0].toolCalls).toEqual(["random_number", "random_number"]);
    expect(extra.toolsFlagged).toBe(false);

    expect(result.totals.toolsFlagged).toBe(1);
    // REPORT-ONLY: the exit code reflects run health only, exactly like a judge flag.
    expect(payload.passed).toBe(true);
    expect(code).toBe(0);

    const md = readFileSync(report, "utf8");
    expect(md).toContain("- **Missing tool calls** 1 case(s)");
    expect(md).toContain("### Missing tool calls");
    expect(md).toContain("#### #2 forgets-the-tool");
    expect(md).toContain("- Repeat #1 — missing `random_number`; called (none)");

    // …and the judge saw what really ran, as evidence.
    const judged = fixtures?.judgeRequests.at(-1) as { subject?: string } | undefined;
    expect(judged?.subject).toContain("Tools the tutor called while answering");
  });

  it("fails LOUDLY when the server reports no tool calls for a required-tools case", async () => {
    const { code, stdout } = await runCli([
      "eval",
      tutorOldServerEval,
      "--json",
      "--server",
      baseUrl(),
    ]);

    // Never a silent "nothing missing": the case errors, so the run is unhealthy.
    const payload = JSON.parse(stdout);
    const errorMessage = payload.files[0].result.cases[0].repeats[0].error.message;
    expect(payload.files[0].result.cases[0].status).toBe("errored");
    expect(errorMessage).toContain("required_tools");
    expect(errorMessage).toContain("Update the Novedu server");
    expect(payload.passed).toBe(false);
    expect(code).toBe(1);
  });

  it("runs a MIXED quiz + tutor batch, one scope line per kind", async () => {
    const { code, stdout, stderr } = await runCli([
      "eval",
      okEval,
      tutorEval,
      "--json",
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(0);
    expect(stderr).toContain("2 case(s) × 1 repeat(s) = 2 grading + 2 judge call(s)");
    expect(stderr).toContain("2 conversation(s) × 1 repeat(s) = 2 generation + 2 judge call(s)");
    const payload = JSON.parse(stdout);
    expect(payload.files.map((file: { kind?: string }) => file.kind)).toEqual(["quiz", "tutor"]);
    expect(payload.totals).toMatchObject({ files: 2, cases: 4, invalid: 0 });
    expect(payload.passed).toBe(true);
  });
});

describe("novedu-cli validate --kind eval — the tutor kind", () => {
  it("validates a tutor eval offline", async () => {
    const { code, stdout } = await runCli(["validate", tutorEval, "--kind", "eval"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid eval");
    expect(stdout).toContain("kind: tutor");
    expect(stdout).toContain("conversations: 2");
  });

  it("exits 1 on a broken tutor eval", async () => {
    const { code, stdout } = await runCli(["validate", brokenTutorEval, "--kind", "eval"]);

    expect(code).toBe(1);
    expect(stdout).toContain("Invalid eval");
  });
});
