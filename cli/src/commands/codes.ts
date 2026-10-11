import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Command } from "commander";
import { REASONING_LEVELS } from "@/lib/llm/provider";
import { failJson, performApiRequest, printJson, runApiRequest } from "../api";
import { runConversationExport } from "../conversation-export";
import { defaultLockPath, loadRegistry } from "../registry";
import {
  buildLockCodes,
  collectWarnings,
  formatSyncReport,
  mintBody,
  parseLock,
  parseServerCodes,
  type ServerCode,
  type SyncEntryResult,
  selectMatches,
  serializeLock,
} from "../sync";

// Teacher code management over the bearer API (docs/api.md): mint a code with
// the same validation pipeline as the web form, and list codes with the /codes
// page's filters. JSON in/out — see cli/src/api.ts for the output contract.
//
// Two subcommands are exceptions to the JSON-only rule (`eval` is the third,
// docs/api.md). `codes sync` reconciles a whole activity REGISTRY
// (docs/registry.md) in one run, so it prints a per-entry report by default and
// keeps the JSON contract behind --json. `codes export` streams a code's
// conversations as JSONL on stdout (or into --out, with a JSON summary on
// stdout) — cli/src/conversation-export.ts. Hard failures (bad registry, no
// token, unreachable server, unwritable lock/file) stay JSON on stderr with exit
// 1 like every other command.

const SERVER_OPTION = [
  "--server <url>",
  "Novedu server base URL (defaults to the NOVEDU_SERVER env var, then production)",
] as const;

interface CreateOptions {
  server?: string;
  module: string;
  file: string;
  start?: string;
  end?: string;
  note?: string;
  llmProvider?: string;
  llmModel?: string;
  llmReasoning?: string;
}

interface ListOptions {
  server?: string;
  search?: string;
  module?: string;
  all?: boolean;
}

interface ExportCommandOptions {
  server?: string;
  out?: string;
}

interface SyncOptions {
  server?: string;
  lock?: string;
  dryRun?: boolean;
  json?: boolean;
}

/**
 * Reconciles a registry file with the server and rewrites its lock file: match
 * every entry against the caller's existing codes (URL + module + window + LLM
 * override), mint what has no match, and report the rest. Existing codes are
 * never modified or deleted — changed parameters produce a NEW code and the old
 * one is reported as superseded (docs/registry.md).
 */
async function runSync(registryFile: string, options: SyncOptions): Promise<void> {
  // Step 1 — the registry must be sound before ANY server call: a typo must not
  // leave half a class's codes minted.
  const registry = await loadRegistry(registryFile);
  if (!registry.ok) {
    failJson({
      message: `${registryFile} is not a usable activity registry.`,
      errors: registry.errors,
    });
    return;
  }

  const lockPath = options.lock ?? defaultLockPath(registryFile);
  const previousLock = await readLock(lockPath);

  // Step 2 — one listing serves every entry (own codes only, the API default).
  const listed = await performApiRequest({ server: options.server, path: "/api/codes" });
  if (!listed.ok) return; // already reported as JSON on stderr, exit 1
  const serverCodes = parseServerCodes(listed.payload);

  // Step 3 — per entry: reuse a match, else mint. A mint failure is recorded and
  // the run continues, so one broken activity cannot block the other entries.
  const results: SyncEntryResult[] = [];
  const selected = selectMatches(registry.entries, serverCodes, previousLock);
  for (const entry of registry.entries) {
    const match = selected.get(entry.key);
    if (match) {
      results.push({ entry, action: "reused", code: match.code, url: match.url ?? undefined });
      continue;
    }
    if (options.dryRun) {
      results.push({ entry, action: "minted" });
      continue;
    }
    const created = await performApiRequest({
      server: options.server,
      path: "/api/codes",
      method: "POST",
      body: mintBody(entry),
      quiet: true,
    });
    if (!created.ok) {
      results.push({ entry, action: "failed", error: created.error });
      continue;
    }
    // A 2xx without a usable code is a failure, not a mint: counting it as one
    // would report success while the lock silently kept this key's PREVIOUS code,
    // which no longer describes the entry.
    const minted = created.payload as Partial<ServerCode> | null;
    if (typeof minted?.code !== "string" || minted.code === "") {
      results.push({
        entry,
        action: "failed",
        error: { message: "the server accepted the request but returned no code" },
      });
      continue;
    }
    results.push({
      entry,
      action: "minted",
      code: minted.code,
      url: typeof minted.url === "string" ? minted.url : undefined,
    });
  }

  const warnings = collectWarnings(results, serverCodes, previousLock);
  const failed = results.filter((result) => result.action === "failed").length;

  // Step 4/5 — report, then rewrite the lock (a failed entry keeps its previous
  // code so a transient error never breaks the consumer's build).
  if (options.json) {
    printJson({
      ...(options.dryRun ? { dryRun: true } : {}),
      entries: results.map((result) => ({
        key: result.entry.key,
        module: result.entry.module,
        fileUrl: result.entry.fileUrl,
        action: result.action,
        ...(result.code ? { code: result.code } : {}),
        ...(result.url ? { url: result.url } : {}),
        ...(result.action === "failed" ? { error: result.error } : {}),
      })),
      warnings,
    });
  } else {
    for (const line of formatSyncReport(results, warnings, {
      registryFileName: basename(registryFile),
      dryRun: Boolean(options.dryRun),
    })) {
      console.log(line);
    }
  }

  if (!options.dryRun) {
    const lock = serializeLock(buildLockCodes(results, previousLock), basename(registryFile));
    try {
      await writeFile(lockPath, lock, "utf8");
    } catch (error) {
      failJson({
        message: `Could not write the lock file ${lockPath}: ${error instanceof Error ? error.message : error}`,
      });
      return;
    }
    if (!options.json) console.log(`Lock file: ${lockPath}`);
  }

  // Step 6 — every entry resolved is exit 0; any failure is exit 1 (the lock was
  // still written above).
  if (failed > 0) process.exitCode = 1;
}

/** The lock file's previous content; a missing or unreadable lock is simply empty. */
async function readLock(lockPath: string): Promise<Record<string, string>> {
  try {
    return parseLock(await readFile(lockPath, "utf8"));
  } catch {
    return {};
  }
}

export function registerCodes(program: Command): void {
  const codes = program.command("codes").description("Manage activity codes on the Novedu server");

  codes
    .command("create")
    .description("Create a code for an activity YAML (validated server-side before storing)")
    .requiredOption("--module <module>", "activity module: tutor, quiz, writing, coding or cloze")
    .requiredOption("--file <url>", "public http(s) URL of the activity YAML")
    .option(
      "--start <iso>",
      "window start, ISO 8601 with explicit offset (e.g. 2026-07-07T08:00:00Z)",
    )
    .option("--end <iso>", "window end, ISO 8601 with explicit offset")
    .option("--note <text>", "note shown in the codes list")
    .option(
      "--llm-provider <provider>",
      'LLM override provider ("SCCH", "Azure Foundry" or "OpenRouter"; needs --llm-model)',
    )
    .option("--llm-model <model>", "LLM override model id (needs --llm-provider)")
    .option(
      "--llm-reasoning <level>",
      `LLM override reasoning effort (${REASONING_LEVELS.join(", ")}; needs the provider/model pair)`,
    )
    .option(...SERVER_OPTION)
    .action(async (options: CreateOptions) => {
      // --start/--end pass through verbatim; the API enforces the explicit-offset
      // rule. The llm pair's both-or-nothing rule — and the reasoning level's "only
      // with a pair" rule, and the level's own spelling — are all the server's call:
      // a lone flag still produces an `llm` object, so the rejection comes back as the
      // server's own message instead of a second, drifting copy of it here.
      const llmGiven =
        options.llmProvider !== undefined ||
        options.llmModel !== undefined ||
        options.llmReasoning !== undefined;
      await runApiRequest({
        server: options.server,
        path: "/api/codes",
        method: "POST",
        body: {
          module: options.module,
          fileUrl: options.file,
          ...(options.start === undefined ? {} : { validFrom: options.start }),
          ...(options.end === undefined ? {} : { validUntil: options.end }),
          ...(options.note === undefined ? {} : { note: options.note }),
          ...(llmGiven
            ? {
                llm: {
                  provider: options.llmProvider ?? "",
                  model: options.llmModel ?? "",
                  ...(options.llmReasoning === undefined
                    ? {}
                    : { reasoning: options.llmReasoning }),
                },
              }
            : {}),
        },
      });
    });

  codes
    .command("list")
    .description("List codes (defaults to only your own, like the web list)")
    .option("--search <q>", "contains-filter over note/code")
    .option("--module <module>", "only codes for one activity module")
    .option("--all", "include codes created by other teachers")
    .option(...SERVER_OPTION)
    .action(async (options: ListOptions) => {
      const params = new URLSearchParams();
      if (options.search) params.set("q", options.search);
      if (options.module) params.set("module", options.module);
      if (options.all) params.set("mine", "0");
      const query = params.toString();
      await runApiRequest({
        server: options.server,
        path: `/api/codes${query ? `?${query}` : ""}`,
      });
    });

  codes
    .command("export")
    .description(
      "Export every conversation of one of YOUR codes as JSONL (no student identity, photos as placeholders)",
    )
    .argument("<code>", "the code whose conversations to export (you must be its creator)")
    .option("--out <file>", "write the JSONL to this file and print a JSON summary instead")
    .option(...SERVER_OPTION)
    .action(async (code: string, options: ExportCommandOptions) => {
      await runConversationExport(code, options);
    });

  codes
    .command("sync")
    .description("Reconcile an activity registry file with the server and write its lock file")
    .argument("<registry-file>", "path to the hand-written activity registry YAML")
    .option("--lock <path>", "lock file path (default: the registry path with .lock.yaml)")
    .option("--dry-run", "report what would happen; mint nothing and write no lock file")
    .option("--json", "machine-readable report on stdout instead of the per-entry lines")
    .option(...SERVER_OPTION)
    .action(async (registryFile: string, options: SyncOptions) => {
      await runSync(registryFile, options);
    });
}
