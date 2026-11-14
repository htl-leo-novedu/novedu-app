import { parse as parseYamlText, stringify as stringifyYaml } from "yaml";
import type { RegistryEntry } from "./registry";

// The sync ENGINE: matching registry entries against the codes the server
// already holds, and turning a run's outcome into the lock file and the report
// (docs/registry.md). Everything here is PURE — the command wiring in
// `commands/codes.ts` does the reading, the requesting and the writing — so the
// matcher's edge cases (timezone spellings, absent window bounds, several
// matches) are unit-testable without a server.

/** One code as `GET /api/codes` returns it, narrowed to what matching needs. */
export interface ServerCode {
  code: string;
  url: string | null;
  module: string;
  fileUrl: string;
  note: string | null;
  validFrom: string | null;
  validUntil: string | null;
  llm: { provider: string; model: string; reasoning: string | null } | null;
  /** The Moodle hand-in switch; `false` when the server does not send it. */
  moodle: boolean;
  createdAt: string | null;
}

export type SyncAction = "reused" | "minted" | "failed";

export interface SyncEntryResult {
  entry: RegistryEntry;
  action: SyncAction;
  /** The reused or minted code; absent for a failed entry and for a dry-run mint. */
  code?: string;
  url?: string;
  /** The server's failure payload, verbatim, for a failed entry. */
  error?: unknown;
}

export interface SyncWarning {
  type: "duplicate" | "superseded" | "orphaned" | "note" | "moodle";
  message: string;
  key?: string;
  codes?: string[];
}

/**
 * Narrows the `GET /api/codes` payload to the fields matching needs, dropping
 * anything unrecognizable. The CLI never fails on an unexpected extra field —
 * the server may grow the shape at any time.
 */
export function parseServerCodes(payload: unknown): ServerCode[] {
  if (!Array.isArray(payload)) return [];
  const codes: ServerCode[] = [];
  for (const row of payload) {
    if (typeof row !== "object" || row === null) continue;
    const value = row as Record<string, unknown>;
    if (typeof value.code !== "string" || typeof value.fileUrl !== "string") continue;
    if (typeof value.module !== "string") continue;
    const llm = value.llm;
    codes.push({
      code: value.code,
      url: typeof value.url === "string" ? value.url : null,
      module: value.module,
      fileUrl: value.fileUrl,
      note: typeof value.note === "string" ? value.note : null,
      validFrom: typeof value.validFrom === "string" ? value.validFrom : null,
      validUntil: typeof value.validUntil === "string" ? value.validUntil : null,
      llm:
        typeof llm === "object" && llm !== null
          ? {
              provider: String((llm as Record<string, unknown>).provider ?? ""),
              model: String((llm as Record<string, unknown>).model ?? ""),
              // A server predating the reasoning level simply omits the field; read
              // defensively so "no level" and "some other shape" both compare as null.
              reasoning:
                typeof (llm as Record<string, unknown>).reasoning === "string"
                  ? ((llm as Record<string, unknown>).reasoning as string)
                  : null,
            }
          : null,
      moodle: value.moodle === true,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    });
  }
  return codes;
}

/**
 * Window bounds compare as INSTANTS, not as strings: the registry may spell a
 * moment `+02:00` while the server always answers in `Z`. An absent bound (null)
 * only matches an absent one.
 */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && left === right;
}

/**
 * The override compares WHOLE, reasoning level included: a code minted at a different
 * effort serves different behavior, so it must not be reused. A differing level therefore
 * fails the match and the entry mints a NEW code — sync never modifies an existing one
 * (docs/registry.md). An absent level on either side compares as null, so an entry
 * without `reasoning` keeps matching the codes minted before the field existed.
 */
function sameLlm(a: RegistryEntry["llm"], b: ServerCode["llm"]): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.reasoning ?? null) === (b.reasoning ?? null)
  );
}

/**
 * The codes that ARE this entry: same activity URL, module and availability
 * window, same LLM override. `note` is deliberately excluded — it is a label for
 * the teacher, not part of the code's behavior, so editing it must not fork a
 * new code. Newest first, so the caller reuses the most recent one.
 */
export function matchEntry(entry: RegistryEntry, codes: readonly ServerCode[]): ServerCode[] {
  return codes
    .filter(
      (code) =>
        code.fileUrl === entry.fileUrl &&
        code.module === entry.module &&
        sameInstant(code.validFrom, entry.validFrom) &&
        sameInstant(code.validUntil, entry.validUntil) &&
        sameLlm(entry.llm, code.llm),
    )
    .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || 0);
}

/**
 * Picks ONE code per registry key out of the pool, so a key's code never moves
 * while a matching code exists.
 *
 * Two entries may legitimately describe the same activity with the same window —
 * one quiz linked from two chapters, each wanting its own statistics — and both
 * then match both of the codes that minted for them. Taking "the newest match"
 * per entry independently would hand BOTH keys the same code, strand the other,
 * and flip the assignment whenever a newer code appeared: a key's published code
 * would move under the students already using it, and two consecutive runs of an
 * unchanged registry would write different lock files. Selection therefore
 * claims: every key that still matches the code it already has keeps it (all of
 * them, before any key takes a free one), then each remaining key takes the
 * newest code nobody has claimed.
 */
export function selectMatches(
  entries: readonly RegistryEntry[],
  codes: readonly ServerCode[],
  previousLock: Readonly<Record<string, string>>,
): Map<string, ServerCode> {
  const candidates = new Map<string, ServerCode[]>();
  for (const entry of entries) candidates.set(entry.key, matchEntry(entry, codes));

  const selected = new Map<string, ServerCode>();
  const claimed = new Set<string>();

  for (const entry of entries) {
    const previous = previousLock[entry.key];
    if (!previous || claimed.has(previous)) continue;
    const kept = candidates.get(entry.key)?.find((code) => code.code === previous);
    if (!kept) continue;
    selected.set(entry.key, kept);
    claimed.add(kept.code);
  }

  for (const entry of entries) {
    if (selected.has(entry.key)) continue;
    const free = candidates.get(entry.key)?.find((code) => !claimed.has(code.code));
    if (!free) continue;
    selected.set(entry.key, free);
    claimed.add(free.code);
  }

  return selected;
}

/** The mint body for an entry — exactly what `POST /api/codes` accepts. */
export function mintBody(entry: RegistryEntry): Record<string, unknown> {
  return {
    module: entry.module,
    fileUrl: entry.fileUrl,
    ...(entry.validFrom === null ? {} : { validFrom: entry.validFrom }),
    ...(entry.validUntil === null ? {} : { validUntil: entry.validUntil }),
    ...(entry.note === null ? {} : { note: entry.note }),
    ...(entry.llm === null ? {} : { llm: entry.llm }),
    ...(entry.moodle ? { moodle: true } : {}),
  };
}

/**
 * Advisory findings for one run: codes the registry no longer describes but that
 * still exist for one of its activities (a parameter change mints a NEW code —
 * the old one is never touched), several codes matching one entry, and lock keys
 * that have left the registry. Nothing here is an error; superseded codes stay
 * live until a teacher deletes them in the web app.
 */
export function collectWarnings(
  results: readonly SyncEntryResult[],
  serverCodes: readonly ServerCode[],
  previousLock: Readonly<Record<string, string>>,
): SyncWarning[] {
  const warnings: SyncWarning[] = [];
  const claimed = new Set<string>();
  // The codes this run actually handed out: a match that another key is using is
  // not a spare copy, so it must not be reported as one.
  const inUse = new Set(
    results.filter((result) => result.action === "reused").map((result) => result.code),
  );

  for (const result of results) {
    if (result.action !== "reused") continue;
    const matches = matchEntry(result.entry, serverCodes);
    for (const match of matches) claimed.add(match.code);
    const spare = matches.filter((match) => match.code !== result.code && !inUse.has(match.code));
    if (spare.length > 0) {
      warnings.push({
        type: "duplicate",
        key: result.entry.key,
        codes: matches.map((match) => match.code),
        message: `${result.entry.key}: ${matches.length} codes match this entry — using ${result.code}; unused: ${spare.map((match) => match.code).join(", ")}`,
      });
    }
    const matched = matches.find((match) => match.code === result.code);
    if (matched && (matched.note ?? "") !== (result.entry.note ?? "")) {
      warnings.push({
        type: "note",
        key: result.entry.key,
        codes: [matched.code],
        message: `${result.entry.key}: the existing code's note differs from the registry's — a note is never re-applied to a minted code`,
      });
    }
    // Like the note, the Moodle switch is mint-only: never part of the match, and
    // sync never changes a code, so a difference is reported for the teacher.
    if (matched && matched.moodle !== result.entry.moodle) {
      warnings.push({
        type: "moodle",
        key: result.entry.key,
        codes: [matched.code],
        message: `${result.entry.key}: moodle differs — change it on the code's edit page`,
      });
    }
  }

  // A stored code for one of the registry's activities that no entry matches:
  // the parameters changed, so this run minted a NEW code and left this one
  // alone. Codes that DO match an entry never appear here — several matches for
  // one entry are the `duplicate` finding above.
  const activities = new Set(
    results.map((result) => `${result.entry.module} ${result.entry.fileUrl}`),
  );
  const superseded = serverCodes.filter(
    (code) => !claimed.has(code.code) && activities.has(`${code.module} ${code.fileUrl}`),
  );
  for (const code of superseded) {
    warnings.push({
      type: "superseded",
      codes: [code.code],
      message: `${code.code}: an older code for ${code.fileUrl} no longer matches any registry entry — it still works; delete it in the web app when the class has moved on`,
    });
  }

  const keys = new Set(results.map((result) => result.entry.key));
  for (const key of Object.keys(previousLock)) {
    if (keys.has(key)) continue;
    warnings.push({
      type: "orphaned",
      key,
      codes: [previousLock[key] ?? ""],
      message: `${key}: in the lock file but no longer in the registry — dropped from the lock; the code ${previousLock[key]} still exists`,
    });
  }

  return warnings;
}

/**
 * The lock content for a run. An entry that FAILED this run keeps the code the
 * previous lock had for it: a transient server error must never break the
 * consumer's build. A failed entry with no previous code is simply absent.
 */
export function buildLockCodes(
  results: readonly SyncEntryResult[],
  previousLock: Readonly<Record<string, string>>,
): Record<string, string> {
  const codes: Record<string, string> = {};
  for (const result of results) {
    const code = result.code ?? previousLock[result.entry.key];
    if (code) codes[result.entry.key] = code;
  }
  return codes;
}

/** The single top-level key of a lock file — namespaced so it can be merged into other metadata. */
export const LOCK_ROOT_KEY = "activity-codes";

/** Serializes the lock file: keys sorted, so a re-run produces a byte-identical file. */
export function serializeLock(
  codes: Readonly<Record<string, string>>,
  registryFileName: string,
): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(codes).sort()) sorted[key] = codes[key] as string;
  return [
    "# Generated by @novedu/cli — do not edit.",
    `# Regenerate with: novedu-cli codes sync ${registryFileName}`,
    stringifyYaml({ [LOCK_ROOT_KEY]: sorted }),
  ].join("\n");
}

/** Reads a lock file's `activity-codes` map; anything unusable yields an empty map. */
export function parseLock(text: string): Record<string, string> {
  let document: unknown;
  try {
    document = parseYamlText(text);
  } catch {
    return {};
  }
  if (typeof document !== "object" || document === null) return {};
  const map = (document as Record<string, unknown>)[LOCK_ROOT_KEY];
  if (typeof map !== "object" || map === null) return {};
  const codes: Record<string, string> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value === "string" && value) codes[key] = value;
  }
  return codes;
}

/**
 * The human-readable report: one line per entry (action, key, code, share URL or
 * the server's complaint), then the advisory findings, then a summary. Returned
 * as lines so the command decides where they go.
 */
export function formatSyncReport(
  results: readonly SyncEntryResult[],
  warnings: readonly SyncWarning[],
  options: { registryFileName: string; dryRun: boolean },
): string[] {
  const width = Math.max(0, ...results.map((result) => result.entry.key.length));
  const label = (action: SyncAction) =>
    (options.dryRun && action === "minted" ? "would mint" : action).padEnd(9);

  const lines = [
    `${options.registryFileName}: ${results.length} ${results.length === 1 ? "entry" : "entries"}`,
  ];
  for (const result of results) {
    const detail =
      result.action === "failed"
        ? describeError(result.error)
        : (result.url ?? result.code ?? "(not minted — dry run)");
    lines.push(
      `  ${label(result.action)} ${result.entry.key.padEnd(width)}  ${result.code ? `${result.code}  ` : ""}${detail}`,
    );
  }

  if (warnings.length > 0) {
    lines.push("", "Notes:");
    for (const warning of warnings) lines.push(`  - ${warning.message}`);
  }

  const counts = { reused: 0, minted: 0, failed: 0 };
  for (const result of results) counts[result.action] += 1;
  lines.push(
    "",
    `${counts.reused} reused, ${counts.minted} ${options.dryRun ? "to mint" : "minted"}, ${counts.failed} failed`,
  );
  return lines;
}

/** A one-line rendering of the server's failure payload for the report. */
export function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error ?? "unknown error");
  const value = error as { message?: unknown; errors?: unknown };
  if (typeof value.message === "string") return value.message;
  if (Array.isArray(value.errors)) {
    return value.errors
      .map((item) => {
        if (typeof item !== "object" || item === null) return String(item);
        const detail = item as { code?: unknown; message?: unknown };
        return [detail.code, detail.message].filter(Boolean).join(": ");
      })
      .join("; ");
  }
  return JSON.stringify(error);
}
