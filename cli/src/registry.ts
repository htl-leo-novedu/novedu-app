import { readFile } from "node:fs/promises";
import { parse as parseYamlText } from "yaml";
import { z } from "zod";
import type { CodeModule } from "@/lib/code-modules/types";
import type { LlmProvider, ReasoningLevel } from "@/lib/llm/provider";
import {
  GROUP_MODULES,
  GROUP_NAMES,
  KEY_PATTERN,
  MAX_KEY_LENGTH,
  RegistryEntrySchema,
} from "@/lib/registry-schema";

// The ACTIVITY REGISTRY: a hand-written YAML file in a publication's own repo
// that lists every novedu activity it embeds under a stable key — the BibTeX of
// activity codes (docs/registry.md). `codes sync` reconciles it against the
// server and writes the key → code lock file the publication renders from.
//
// This module is PURE (except `loadRegistry`, which only adds the file read):
// parse, validate, resolve every entry's file URL into exactly the parameters
// `POST /api/codes` takes. Nothing here talks to the network.

/** One registry entry, resolved into the mint parameters of `POST /api/codes`. */
export interface RegistryEntry {
  /** The registry key — the name the lock file (and the publication) uses. */
  key: string;
  module: CodeModule;
  /** Normalized (`URL.href`) activity YAML URL — the form the server stores. */
  fileUrl: string;
  /** Window bounds exactly as authored (ISO 8601 with an explicit offset), or null. */
  validFrom: string | null;
  validUntil: string | null;
  note: string | null;
  /**
   * The per-code LLM override, whole or absent. `reasoning` is its optional third
   * member: it rides ALONG with the pair (the server rejects it on its own) and a
   * differing level makes an existing code stop matching, so `codes sync` mints a new
   * one rather than silently serving the old effort.
   */
  llm: { provider: LlmProvider; model: string; reasoning?: ReasoningLevel } | null;
  /**
   * The Moodle hand-in switch (quizzes only). Mint-only like `note`: sent when a code
   * is minted, never part of the match.
   */
  moodle: boolean;
}

export interface RegistryIssue {
  code: "REGISTRY_PARSE_ERROR" | "REGISTRY_SCHEMA_ERROR" | "REGISTRY_READ_ERROR";
  /** Dotted path into the YAML document, e.g. `activities.quizzes.welcome.file`. */
  path: string;
  message: string;
}

export type RegistryResult =
  | { ok: true; entries: RegistryEntry[] }
  | { ok: false; errors: RegistryIssue[] };

// The FORMAT — group names, key rules, entry fields — lives in `@/lib/registry-schema`,
// which `lib/schema-gen` also generates the editor JSON Schema from. What stays here is
// the parsing STRATEGY: `activities` is deliberately opaque to zod so the walk below can
// name the exact YAML path in every message and tolerate author annotations.
const rootSchema = z.looseObject({
  "base-url": z.string().optional(),
  activities: z.record(z.string(), z.unknown(), {
    error: "activities must be a mapping of activity groups",
  }),
});

function issue(code: RegistryIssue["code"], path: string, message: string): RegistryIssue {
  return { code, path, message };
}

/** Turns zod's issue list into registry issues rooted at `basePath`. */
function schemaIssues(error: z.ZodError, basePath: string): RegistryIssue[] {
  return error.issues.map((item) =>
    issue(
      "REGISTRY_SCHEMA_ERROR",
      [basePath, ...item.path.map(String)].filter(Boolean).join("."),
      item.message,
    ),
  );
}

/** A plain YAML mapping — the shape both a group and an entry must have. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and validates a registry document, resolving every entry's file URL.
 * Returns ALL issues found rather than the first — a registry is edited by hand,
 * so one run should surface every problem.
 */
export function parseRegistry(text: string): RegistryResult {
  let document: unknown;
  try {
    document = parseYamlText(text);
  } catch (error) {
    return {
      ok: false,
      errors: [
        issue(
          "REGISTRY_PARSE_ERROR",
          "",
          `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }

  const root = rootSchema.safeParse(document ?? {});
  if (!root.success) return { ok: false, errors: schemaIssues(root.error, "") };

  const errors: RegistryIssue[] = [];
  const entries: RegistryEntry[] = [];
  const seenKeys = new Map<string, string>();

  // `base-url` is only required once an entry actually uses a relative `file`,
  // so a registry of absolute URLs needs none. Validated up front all the same:
  // the trailing slash decides what `new URL(file, base)` resolves to, and a
  // missing one silently drops the base's last path segment.
  const baseUrlText = root.data["base-url"];
  let baseUrl: string | undefined;
  if (baseUrlText !== undefined) {
    const parsed = safeHttpUrl(baseUrlText);
    if (!parsed) {
      errors.push(issue("REGISTRY_SCHEMA_ERROR", "base-url", "must be an http(s) URL"));
    } else if (!parsed.endsWith("/")) {
      errors.push(
        issue(
          "REGISTRY_SCHEMA_ERROR",
          "base-url",
          "must end with a slash — it is resolved against, not concatenated with, each entry's `file`",
        ),
      );
    } else {
      baseUrl = parsed;
    }
  }

  for (const [groupName, groupValue] of Object.entries(root.data.activities)) {
    const groupPath = `activities.${groupName}`;
    if (!(groupName in GROUP_MODULES)) {
      errors.push(
        issue(
          "REGISTRY_SCHEMA_ERROR",
          groupPath,
          `unknown activity group — use one of ${GROUP_NAMES.join(", ")}`,
        ),
      );
      continue;
    }
    if (groupValue === null || groupValue === undefined) continue; // an empty group is fine
    if (!isMapping(groupValue)) {
      errors.push(issue("REGISTRY_SCHEMA_ERROR", groupPath, "must be a mapping of key → entry"));
      continue;
    }
    const module = GROUP_MODULES[groupName as keyof typeof GROUP_MODULES];

    for (const [key, value] of Object.entries(groupValue)) {
      // A group holds entries; a property whose value is not mapping-shaped (a
      // scalar, a sequence) is treated as an author's annotation and ignored.
      // Anything mapping-shaped MUST be a valid entry — silently dropping
      // something that looks like one is the failure mode this whole format
      // exists to prevent.
      if (value !== null && !isMapping(value)) continue;
      const entryPath = `${groupPath}.${key}`;

      // An EMPTY value is the one shape that cannot be an annotation: it carries
      // nothing to annotate with. It is what a mis-indented entry looks like —
      // `welcome:` followed by its fields one level out — and ignoring it would
      // drop a published activity from the lock while the run still reported
      // success, which is precisely the failure this format exists to prevent.
      if (value === null) {
        errors.push(
          issue(
            "REGISTRY_SCHEMA_ERROR",
            entryPath,
            "entry has no fields — check the indentation of the lines below it",
          ),
        );
        continue;
      }

      if (!KEY_PATTERN.test(key) || key.length > MAX_KEY_LENGTH) {
        errors.push(
          issue(
            "REGISTRY_SCHEMA_ERROR",
            entryPath,
            `invalid key — use lowercase letters, digits and hyphens (max ${MAX_KEY_LENGTH} characters)`,
          ),
        );
        continue;
      }
      const previousGroup = seenKeys.get(key);
      if (previousGroup) {
        errors.push(
          issue(
            "REGISTRY_SCHEMA_ERROR",
            entryPath,
            `duplicate key — already defined under activities.${previousGroup}; keys are unique across all groups`,
          ),
        );
        continue;
      }
      seenKeys.set(key, groupName);

      const parsed = RegistryEntrySchema.safeParse(value);
      if (!parsed.success) {
        errors.push(...schemaIssues(parsed.error, entryPath));
        continue;
      }
      const entry = parsed.data;

      if (entry.moodle === true && module !== "quiz") {
        errors.push(
          issue("REGISTRY_SCHEMA_ERROR", `${entryPath}.moodle`, "is allowed under `quizzes` only"),
        );
        continue;
      }

      if (entry.start && entry.end && Date.parse(entry.end) <= Date.parse(entry.start)) {
        errors.push(issue("REGISTRY_SCHEMA_ERROR", `${entryPath}.end`, "must be after `start`"));
        continue;
      }

      let fileUrl: string | undefined;
      if (entry.url !== undefined) {
        fileUrl = safeHttpUrl(entry.url);
        if (!fileUrl) {
          errors.push(
            issue("REGISTRY_SCHEMA_ERROR", `${entryPath}.url`, "must be an absolute http(s) URL"),
          );
          continue;
        }
      } else if (baseUrl === undefined) {
        errors.push(
          issue(
            "REGISTRY_SCHEMA_ERROR",
            `${entryPath}.file`,
            baseUrlText === undefined
              ? "`file` is relative, but the registry has no `base-url`"
              : "`file` cannot be resolved — fix `base-url`",
          ),
        );
        continue;
      } else {
        fileUrl = safeHttpUrl(entry.file ?? "", baseUrl);
        if (!fileUrl) {
          errors.push(
            issue(
              "REGISTRY_SCHEMA_ERROR",
              `${entryPath}.file`,
              "does not resolve to an http(s) URL against `base-url`",
            ),
          );
          continue;
        }
      }

      entries.push({
        key,
        module,
        fileUrl,
        validFrom: entry.start ?? null,
        validUntil: entry.end ?? null,
        note: entry.note ?? null,
        llm: entry.llm
          ? {
              provider: entry.llm.provider,
              model: entry.llm.model,
              // Omitted, never `undefined`-valued: the entry is serialized straight into
              // the mint body, and a `reasoning: undefined` key would appear as `null`.
              ...(entry.llm.reasoning ? { reasoning: entry.llm.reasoning } : {}),
            }
          : null,
        moodle: entry.moodle === true,
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

/**
 * Normalizes a (possibly relative) URL the way `validateCodeRequest` does —
 * `URL.href` — so a resolved entry compares byte-identical to the `file_url` the
 * server stored. Returns undefined for anything that is not http(s).
 */
function safeHttpUrl(value: string, base?: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim(), base);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

/** Reads and validates a registry file; a read failure is reported like a schema issue. */
export async function loadRegistry(path: string): Promise<RegistryResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      errors: [
        issue(
          "REGISTRY_READ_ERROR",
          "",
          `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  return parseRegistry(text);
}

/** The lock file that belongs to a registry: `<name>.yaml` → `<name>.lock.yaml`. */
export function defaultLockPath(registryPath: string): string {
  return `${registryPath.replace(/\.ya?ml$/i, "")}.lock.yaml`;
}
