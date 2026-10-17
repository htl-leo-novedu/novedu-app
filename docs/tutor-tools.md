# Built-in tutor tools

Opt-in, server-side LLM tools for tutor activities. A tutor YAML declares a
top-level `tools:` list of well-known names; the tutor agent then exposes
exactly those tools to the model for that activity. Off by default — a tutor
without `tools:` runs tool-less, byte-identical to before the feature.

```yaml
tools:
  - random_number
```

## Architecture: pure catalog vs Mastra binding

The implementation is deliberately split across the CLI-bundling boundary:

- **`lib/tutor-tools/` — the pure catalog.** `names.ts` holds the taxative
  name list + the zod enum (`tutorToolNameSchema`); `catalog.ts` holds, per
  tool, the model-facing description, zod input/output schemas, and the pure
  `execute` logic. Effects are injected (`TutorToolDeps` — currently just
  `randomInt`, crypto-backed in `defaultTutorToolDeps`) so tests are
  deterministic. `names.ts` is imported by `lib/tutors/schemas.ts` and thus
  sits inside the prompt-dump grep-guard's transitive closure
  (`lib/prompt-dump.unit.test.ts`): **nothing in `lib/tutor-tools/` may import
  `app/**`, the DB, or `lib/llm/model.ts`, or carry `"use server"`.** Node
  builtins are fine.
- **`app/mastra/tutor-tools.ts` — the only place catalog defs meet
  `createTool`.** Every Mastra `Tool` instance is created once at module load
  (tools are stateless, so instances are shared across requests);
  `selectTutorTools(names)` picks the subset for one tutor and throws on a
  name the catalog does not know (a wiring bug — the schema already rejects
  unknown names at load time).
- **`app/mastra/tutor-agent.ts`** adds a `tools:` resolver next to
  `instructions`/`model`; all three share the ONE request-scoped
  `loadAndBuildTutorPrompt` build (the `perRequestBuild` WeakMap).

Data flow: `tools:` in the YAML → `TutorSchema` (enum-validated, `.default([])`)
→ `BuildResult.tools` (`lib/prompt-fragments/errors.ts`) → the agent's `tools`
resolver → `selectTutorTools` → the model's tool list for that request.

## Invariants

- **The name enum is the validation seam.** An unknown tool name is a
  `TUTOR_SCHEMA_ERROR` everywhere the schema runs: the app's authoring gate,
  the share/validate pages, and `novedu-cli validate` (the CLI bundles
  `lib/tutors` by reference — no second list to update).
- **The platform never mentions tools in the prompt.** The "prompt is used
  verbatim — nothing appended" rule stays; authors reference enabled tools in
  `tutor_instructions` themselves. `novedu-cli prompts` shows the enabled tool
  list (`TutorPromptDump.tools`) so the dump remains a faithful picture of
  what the model receives.
- **Tool grants are independent of the LLM.** `tools:` is top-level, NOT part
  of `llm:` — a code's per-code LLM override replaces the `llm` pair wholesale
  and never touches the tool selection.
- **Metering is automatic, content-free.** Tool executions surface as
  `TOOL_CALL` spans, which `app/mastra/usage-exporter.ts` counts into both
  hourly buckets (`tool_calls`). Tool arguments/results must never reach
  telemetry or the usage tables.

## Adding a tool

1. Add the name to `TUTOR_TOOL_NAMES` (`lib/tutor-tools/names.ts`).
2. Add the catalog entry (`lib/tutor-tools/catalog.ts`): description written
   for the model, strict zod input/output schemas, pure `execute` taking
   injected deps. The `satisfies Record<TutorToolName, …>` clause makes a
   missing entry a type error.
3. Unit-test the executor exhaustively (`lib/tutor-tools/*.unit.test.ts`).
4. `npm run generate:schemas` — the enum lands in
   `activities/tutors/tutor-yaml.schema.json` (drift-guarded in CI).
5. Document it: the taxative tool tables in `activities/tutors/README.md` and
   the teacher-docs tutors chapter (via the `novedu-teacher-docs` skill), and
   this file if the architecture shifts.

Nothing else changes: the Mastra binding iterates `TUTOR_TOOL_NAMES`, the
CopilotKit route and the code-module descriptor are tool-agnostic, and metering
picks the calls up on its own.

## Testing

- `lib/tutor-tools/catalog.unit.test.ts` — catalog completeness (every name
  has an entry), executor logic with injected RNG, schema rejections.
- `lib/tutors/load.unit.test.ts` — `tools` normalization + unknown-name
  rejection through the real loader.
- `app/mastra/tutor-agent.unit.test.ts` — per-request tool resolution: empty
  map by default, the opted-in subset otherwise, shared request-scoped build.
- `cli/src/commands/{validate,prompts}.unit.test.ts` over the on-disk fixtures
  `test-fixtures/activities/tutors/{tools-tutor,broken-tools-tutor}.yaml` —
  the CLI accepts/rejects and dumps the tool list.
