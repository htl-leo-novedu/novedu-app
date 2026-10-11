// Regenerates the eight authoring JSON Schemas from their zod sources of truth.
//
//   npm run generate:schemas
//
// This is the *fix* command: run it after editing any zod schema (or its `.meta()`
// prose), then commit the changed `activities/**/*-yaml.schema.json` alongside the
// zod change. The hermetic drift-guard unit test (`lib/schema-gen/generated-schemas.unit.test.ts`)
// fails CI if a committed schema is stale, so this is never wired into `build`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schemaRegistry, serializeActivityJsonSchema } from "@/lib/schema-gen";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const entry of schemaRegistry) {
  const outFile = resolve(repoRoot, entry.outPath);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, serializeActivityJsonSchema(entry));
  console.log(`✓ ${entry.outPath}`);
}

console.log(`\nGenerated ${schemaRegistry.length} authoring JSON Schemas.`);
