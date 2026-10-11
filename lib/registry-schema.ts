import { z } from "zod";
import type { CodeModule } from "@/lib/code-modules/types";
import { LLM_PROVIDERS, REASONING_LEVELS } from "@/lib/llm/provider";

// The zod source of truth for the ACTIVITY REGISTRY format (docs/registry.md): the
// hand-written YAML file in a publication's own repo that lists every novedu activity
// it embeds under a stable key, reconciled with the server by `novedu codes sync`.
//
// It lives in `lib/` rather than next to the CLI for one reason: `lib/schema-gen`
// generates the editor JSON Schema from `RegistryYamlSchema` below, and cli files must
// never enter the app's tsc program (see the header of `cli/tsconfig.json`). The CLI
// inlines this module through the `@` alias like any other bundled validator.
//
// PURE and client-safe — zod only, no I/O. The parsing STRATEGY (which shapes are
// walked by hand to produce good error paths) stays in `cli/src/registry.ts`.

/** The fixed group names and the code module each one mints for. */
export const GROUP_MODULES = {
  quizzes: "quiz",
  tutors: "tutor",
  writing: "writing",
  coding: "coding",
  cloze: "cloze",
} as const satisfies Record<string, CodeModule>;

export type RegistryGroup = keyof typeof GROUP_MODULES;

export const GROUP_NAMES = Object.keys(GROUP_MODULES) as RegistryGroup[];

/** Registry keys share the lock file's flat namespace, so they stay URL/YAML-plain. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_KEY_LENGTH = 64;

// Mirrors the server's limits (`lib/code-store.ts`), which is server-only (it pulls in
// the database) and therefore not importable from the CLI. The server re-checks both —
// these copies only turn a guaranteed rejection into an offline error.
export const MAX_NOTE_LENGTH = 200;
export const MAX_LLM_MODEL_LENGTH = 256;

// Same rule as `POST /api/codes`: a naive datetime would silently be read in the
// server's timezone, so a bound must carry `Z` or ±hh[:]mm.
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

// No `.meta({ id })` here: `start` and `end` are two distinct schema instances, and two
// instances sharing one id make `z.toJSONSchema` throw. Each call site brings its own
// description instead.
function timestampField(field: "start" | "end") {
  return z
    .string()
    .refine(
      (value) => EXPLICIT_OFFSET.test(value) && !Number.isNaN(Date.parse(value)),
      `${field} must be an ISO 8601 datetime with an explicit offset or Z, e.g. 2026-09-01T08:00:00+02:00`,
    )
    .refine(
      // The server stores window bounds as WHOLE unix seconds (`isoToUnixSeconds`
      // in `app/api/codes/route.ts` floors), so a bound with milliseconds would
      // come back truncated and never match the entry that minted it — every sync
      // would mint yet another code. Rejecting is the only stable answer: silently
      // truncating would make the registry lie about the window it asks for.
      (value) => {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) || parsed % 1000 === 0;
      },
      `${field} must not carry sub-second precision — the server stores whole seconds`,
    );
}

// An unknown provider would produce an entry that can never match a stored code and then
// fails at mint time. An enum (not the shared `providerSchema`, which carries a DEFAULT)
// keeps the both-or-nothing llm rule intact and emits the literals for editors.
const providerField = z.enum(LLM_PROVIDERS, {
  error: 'must be "SCCH", "Azure Foundry" or "OpenRouter"',
});

// The override's optional third member. An enum (not the shared `reasoningLevelSchema`,
// which is already `.optional()` and carries the activity YAML's prose) for the same
// reason `providerField` exists: an unknown level would produce an entry that can never
// match a stored code and then fails at mint time. No default — absent means the level is
// simply not sent, exactly as everywhere else.
const reasoningField = z.enum(REASONING_LEVELS, {
  error: `must be one of ${REASONING_LEVELS.join(", ")}`,
});

/**
 * One registry entry. Unknown extra properties are ACCEPTED and ignored so authors can
 * annotate freely and a newer registry keeps working with an older CLI — which is why
 * this is a `looseObject` and the generated JSON Schema does NOT flag a misspelled field.
 */
export const RegistryEntrySchema = z
  .looseObject({
    file: z.string().trim().min(1).optional().meta({
      description:
        "Path to the activity YAML, resolved against `base-url`. Give exactly one of `file` or `url`.",
    }),
    url: z.string().trim().min(1).optional().meta({
      description:
        "Absolute http(s) URL of the activity YAML. Give exactly one of `file` or `url`.",
    }),
    start: timestampField("start").optional().meta({
      description:
        "Start of the code's validity window, ISO 8601 with an explicit offset or Z (e.g. 2026-09-01T08:00:00+02:00), whole seconds.",
    }),
    end: timestampField("end").optional().meta({
      description:
        "End of the code's validity window, same format as `start`, and must be after it.",
    }),
    // Trimmed like the server trims it (`lib/code-store.ts`), so a stray trailing
    // space cannot make a stored note look different from the registry's forever.
    note: z
      .string()
      .trim()
      .max(MAX_NOTE_LENGTH, `note must be at most ${MAX_NOTE_LENGTH} characters`)
      .optional()
      .meta({
        description: `Note shown in the codes list, at most ${MAX_NOTE_LENGTH} characters. No effect on behaviour.`,
      }),
    llm: z
      .looseObject({
        provider: providerField.meta({
          description: "LLM provider override for this code. Required when `llm` is present.",
        }),
        model: z.string().trim().min(1).max(MAX_LLM_MODEL_LENGTH).meta({
          description:
            "Model id (for Azure Foundry, the deployment name). Required when `llm` is present.",
        }),
        reasoning: reasoningField.optional().meta({
          description:
            "Optional reasoning effort for reasoning models, applied on top of the provider/model pair. Omit to let the model decide.",
        }),
      })
      .optional()
      .meta({
        description:
          "Per-code LLM override replacing the activity YAML's own `llm:`. Provider and model must be given together; `reasoning` is optional on top of them.",
      }),
  })
  .refine(
    (entry) => (entry.file === undefined) !== (entry.url === undefined),
    "give exactly one of `file` (relative to base-url) or `url` (absolute)",
  )
  .meta({
    id: "registryEntry",
    description: "One activity: where its YAML lives, plus the parameters its code is minted with.",
  });

/** A group holds `key: entry` pairs; an empty group (`quizzes:` with nothing under it) is fine. */
function groupOf(group: RegistryGroup) {
  return z
    .record(z.string().regex(KEY_PATTERN).max(MAX_KEY_LENGTH), RegistryEntrySchema)
    .nullable()
    .optional()
    .meta({
      // `.meta()` must come AFTER `.nullable()` — before it, the description would land
      // inside the emitted `anyOf` branch instead of on the property itself.
      description: `Activities minted as \`${GROUP_MODULES[group]}\` codes, keyed by the name your material references.`,
    });
}

/**
 * The whole registry document, used ONLY to generate the editor JSON Schema
 * (`activities/registry/registry-yaml.schema.json` via `npm run generate:schemas`).
 *
 * `cli/src/registry.ts` does NOT parse with this: it walks groups and entries by hand so
 * every message can name the exact YAML path, and so a non-mapping value inside a group
 * is ignored as an author's annotation. The group names come from `GROUP_MODULES`, so
 * this cannot drift from the CLI on the one thing that would matter.
 */
export const RegistryYamlSchema = z.looseObject({
  "base-url": z.string().optional().meta({
    description:
      "Base URL each entry's `file` is resolved against. Must end with a slash. Only needed when an entry uses `file`.",
  }),
  activities: z
    .strictObject(
      Object.fromEntries(GROUP_NAMES.map((group) => [group, groupOf(group)])) as {
        [G in RegistryGroup]: ReturnType<typeof groupOf>;
      },
    )
    .meta({
      description: "The activities, grouped by the kind of code each one is minted as.",
    }),
});
