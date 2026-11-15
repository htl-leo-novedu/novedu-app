import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixturesServer } from "../../test-fixtures/serve.mjs";

// `codes sync` end to end through the REAL built CLI binary (`node dist/main.js`)
// against the fixtures server's fake `/api/codes` — fully offline, no sign-in
// (the CLI reads NOVEDU_TOKEN, see cli/src/auth.ts). This is the only place the
// whole chain runs together: registry file → matching → minting → lock file.
//
// The registry is written into a temp dir at test time because its `base-url`
// must carry the server's ephemeral port; the invalid-registry case uses the
// committed fixture under test-fixtures/activities/registry/.
//
// Run via `npm run test:cli` — it builds the CLI first, so `dist/main.js` exists.

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const brokenRegistry = fileURLToPath(
  new URL("../../test-fixtures/activities/registry/broken-activities.yaml", import.meta.url),
);

let fixtures:
  | { server: Server; baseUrl: string; codes: Array<Record<string, unknown>> }
  | undefined;
let dir: string;

beforeAll(async () => {
  fixtures = await startFixturesServer(0);
  dir = mkdtempSync(join(tmpdir(), "novedu-sync-integration-"));
});

afterAll(async () => {
  const server = fixtures?.server;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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

describe("novedu-cli codes sync", () => {
  it("mints on the first run, reuses on the second, and leaves the lock byte-identical", async () => {
    const registry = join(dir, "activities.yaml");
    const lock = join(dir, "activities.lock.yaml");
    writeFileSync(
      registry,
      `base-url: "${baseUrl()}/"
activities:
  quizzes:
    welcome:
      file: quizzes/test-quiz.yaml
      note: "integration fixture"
  tutors:
    sorting:
      file: tutors/test-tutor.yaml
      start: 2026-09-01T00:00:00+02:00
`,
      "utf8",
    );

    const first = await runCli(["codes", "sync", registry, "--server", baseUrl()]);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain("0 reused, 2 minted, 0 failed");
    const lockAfterFirst = readFileSync(lock, "utf8");
    expect(lockAfterFirst).toContain("activity-codes:");
    expect(lockAfterFirst).toMatch(/sorting: synced\d{4}/);
    expect(lockAfterFirst).toMatch(/welcome: synced\d{4}/);

    // The second run must find both codes again — including the one whose window
    // the registry spells `+02:00` and the server stores as `Z`.
    const second = await runCli(["codes", "sync", registry, "--server", baseUrl()]);

    expect(second.code).toBe(0);
    expect(second.stdout).toContain("2 reused, 0 minted, 0 failed");
    expect(readFileSync(lock, "utf8")).toBe(lockAfterFirst);
  });

  it("mints with the Moodle switch and reports a later difference without minting again", async () => {
    const registry = join(dir, "moodle-run.yaml");
    const write = (moodle: boolean) =>
      writeFileSync(
        registry,
        `base-url: "${baseUrl()}/"
activities:
  quizzes:
    moodle-quiz:
      file: quizzes/test-quiz.yaml
      note: "moodle fixture"
      start: 2026-10-01T00:00:00Z
      moodle: ${moodle}
`,
        "utf8",
      );
    const sync = async () =>
      JSON.parse(
        (await runCli(["codes", "sync", registry, "--json", "--server", baseUrl()])).stdout,
      );

    write(true);
    const first = await sync();
    expect(first.entries[0].action).toBe("minted");

    write(false);
    const second = await sync();
    expect(second.entries[0].action).toBe("reused");
    expect(second.entries[0].code).toBe(first.entries[0].code);
    expect(second.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "moodle", key: "moodle-quiz" })]),
    );
  });

  it("emits the machine-readable report with --json", async () => {
    const registry = join(dir, "json-run.yaml");
    writeFileSync(
      registry,
      `base-url: "${baseUrl()}/"
activities:
  quizzes:
    json-welcome:
      file: quizzes/fragments-quiz.yaml
`,
      "utf8",
    );

    const { code, stdout } = await runCli([
      "codes",
      "sync",
      registry,
      "--json",
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].key).toBe("json-welcome");
    expect(payload.entries[0].action).toBe("minted");
    expect(payload.entries[0].code).toMatch(/^synced\d{4}$/);
  });

  it("exits 1 on an invalid registry, reporting every issue on stderr and writing no lock", async () => {
    const lock = brokenRegistry.replace(/\.yaml$/, ".lock.yaml");
    const { code, stderr, stdout } = await runCli([
      "codes",
      "sync",
      brokenRegistry,
      "--server",
      baseUrl(),
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    const payload = JSON.parse(stderr);
    expect(payload.errors.map((issue: { path: string }) => issue.path)).toEqual([
      "activities.quizes",
      "activities.quizzes.Welcome_Quiz",
      "activities.quizzes.relative.file",
    ]);
    expect(() => readFileSync(lock, "utf8")).toThrow();
  });
});
