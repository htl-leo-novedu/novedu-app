import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixturesServer } from "../../test-fixtures/serve.mjs";

// Integration tests that invoke the REAL built CLI binary the way a user would
// (`node dist/main.js …`), asserting stdout + exit code. Local-file cases read the
// synthetic fixtures under `test-fixtures/activities/`; the served-URL cases fetch
// them from a local fixtures server (no network). Runs in CI via `npm run test:cli`
// (qa.yml).
//
// Run via `npm run test:cli` — it builds the CLI first, so `dist/main.js` exists.

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const tutorsDir = fileURLToPath(new URL("../../test-fixtures/activities/tutors/", import.meta.url));
const quizzesDir = fileURLToPath(
  new URL("../../test-fixtures/activities/quizzes/", import.meta.url),
);
const writingsDir = fileURLToPath(
  new URL("../../test-fixtures/activities/writings/", import.meta.url),
);
const codingDir = fileURLToPath(new URL("../../test-fixtures/activities/coding/", import.meta.url));
const clozeDir = fileURLToPath(new URL("../../test-fixtures/activities/cloze/", import.meta.url));

// The served-URL cases point the CLI at a local fixtures server, reachable by
// the spawned child on 127.0.0.1 — fully offline.
let fixtures: { server: Server; baseUrl: string } | undefined;
beforeAll(async () => {
  fixtures = await startFixturesServer(0);
});
afterAll(async () => {
  // `fixtures` stays undefined when beforeAll fails — guard so the teardown
  // doesn't bury the root cause under a TypeError.
  const server = fixtures?.server;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixturesBaseUrl(): string {
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
    const child = spawn(process.execPath, [cli, ...args], { env: process.env });
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

describe("novedu-cli validate — local files", () => {
  it("exits 0 for a valid tutor", async () => {
    const { code, stdout } = await runCli(["validate", `${tutorsDir}test-tutor.yaml`]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid tutor");
  });

  it("exits 1 for a broken tutor", async () => {
    const { code, stdout } = await runCli(["validate", `${tutorsDir}broken-tutor.yaml`]);

    expect(code).toBe(1);
    expect(stdout).toContain("Invalid tutor");
  });

  it("emits raw JSON with --json", async () => {
    const { code, stdout } = await runCli(["validate", `${tutorsDir}test-tutor.yaml`, "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it("exits 0 for a valid fragment library with --kind fragment", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${tutorsDir}test-fragments-a.yaml`,
      "--kind",
      "fragment",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid fragment file");
  });

  it("exits 1 with FRAGMENT_TEMPLATE_ERROR for a broken fragment template", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${tutorsDir}broken-template-fragments.yaml`,
      "--kind",
      "fragment",
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("FRAGMENT_TEMPLATE_ERROR");
  });

  it("exits 0 for a valid quiz with --kind quiz", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${quizzesDir}test-quiz.yaml`,
      "--kind",
      "quiz",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid quiz");
  });

  it("exits 1 with QUIZ_SCHEMA_ERROR for the committed broken quiz", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${quizzesDir}broken-quiz.yaml`,
      "--kind",
      "quiz",
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("QUIZ_SCHEMA_ERROR");
  });

  it("exits 0 for a valid writing activity with --kind writing", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${writingsDir}test-writing.yaml`,
      "--kind",
      "writing",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid writing activity");
  });

  it("exits 1 with WRITING_SCHEMA_ERROR for the committed broken writing activity", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${writingsDir}broken-writing.yaml`,
      "--kind",
      "writing",
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("WRITING_SCHEMA_ERROR");
  });

  it("exits 0 for a valid coding activity with --kind coding", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${codingDir}test-coding.yaml`,
      "--kind",
      "coding",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid coding activity");
  });

  it("exits 1 with CODING_SCHEMA_ERROR for the committed broken coding activity", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${codingDir}broken-coding.yaml`,
      "--kind",
      "coding",
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("CODING_SCHEMA_ERROR");
  });

  it("exits 0 and prints the gap inventory for a valid cloze exercise (--kind cloze)", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${clozeDir}test-cloze.yaml`,
      "--kind",
      "cloze",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid cloze exercise");
    expect(stdout).toContain("gaps: 3");
    expect(stdout).toMatch(/2 {2}"starts".*\(start\)/);
  });

  it("exits 1 with located gap errors for the committed broken cloze exercise", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${clozeDir}broken-cloze.yaml`,
      "--kind",
      "cloze",
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("CLOZE_GAP_POSITION");
    expect(stdout).toContain("Text line 1, column 6");
  });

  // Document-level prompt fragments over a `file:` scheme with a RELATIVE ref, proving
  // the shared orchestrator + LoadOptions flow through each --kind on disk.
  it("exits 0 for a quiz with a local fragment block (--kind quiz)", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${quizzesDir}fragments-quiz.yaml`,
      "--kind",
      "quiz",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid quiz");
  });

  it("exits 0 for a writing activity with a local fragment block (--kind writing)", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${writingsDir}fragments-writing.yaml`,
      "--kind",
      "writing",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid writing activity");
  });

  it("exits 0 for a coding activity with a local fragment block (--kind coding)", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${codingDir}fragments-coding.yaml`,
      "--kind",
      "coding",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid coding activity");
  });

  it("rejects an invalid --kind", async () => {
    const { code, stderr } = await runCli([
      "validate",
      `${tutorsDir}test-tutor.yaml`,
      "--kind",
      "bogus",
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid --kind");
  });
});

describe("novedu-cli validate — served URLs", () => {
  it("exits 0 for a fixture tutor served over HTTP", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${fixturesBaseUrl()}/tutors/test-tutor.yaml`,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Valid tutor");
  });

  it("exits 1 for a broken fixture tutor served over HTTP", async () => {
    const { code, stdout } = await runCli([
      "validate",
      `${fixturesBaseUrl()}/tutors/broken-tutor.yaml`,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain("Invalid tutor");
  });
});
