// Public surface of the tutor-tool catalog. `names.ts` stays separately
// importable so `lib/tutors/schemas.ts` can pull in the name enum without
// dragging executors into the CLI bundle's transitive closure.

export {
  type AnyTutorToolDef,
  boardTool,
  defaultTutorToolDeps,
  NO_PRIOR_CALLS,
  RANDOM_NUMBER_BOUND,
  type RandomIntFn,
  randomNumberTool,
  resolveTutorTools,
  type TutorToolCallContext,
  type TutorToolDef,
  type TutorToolDeps,
  tutorToolCatalog,
} from "./catalog";
export { TUTOR_TOOL_NAMES, type TutorToolName, tutorToolNameSchema } from "./names";
