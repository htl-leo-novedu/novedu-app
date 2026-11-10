// The taxative list of tool names a tutor YAML may opt into via its top-level
// `tools:` list. Deliberately a SEPARATE module from the catalog: this file is
// imported by `lib/tutors/schemas.ts` and therefore sits inside the CLI
// prompt-dump grep-guard's transitive closure (lib/prompt-dump.unit.test.ts) —
// it must stay import-free so the schema pulls in names only, never executors.
//
// Adding a tool = add its name here + its catalog entry in `catalog.ts` +
// document it (activities/tutors/README.md, teacher docs, docs/tutor-tools.md).

import { z } from "zod";

export const TUTOR_TOOL_NAMES = ["random_number", "board"] as const;

export type TutorToolName = (typeof TUTOR_TOOL_NAMES)[number];

export const tutorToolNameSchema = z.enum(TUTOR_TOOL_NAMES).meta({
  id: "tutorToolName",
  description: "Name of a built-in tutor tool.",
});
