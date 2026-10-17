// Public surface of the shared prompt-fragment core: the ONE home of Handlebars
// handling (fragment-content rendering, the isolated host-template engine, placement
// checking) and the load/validate infrastructure every activity kind (tutor, quiz,
// writing, coding) consumes. No consumer imports `handlebars` or re-implements any of
// it; they all go through `assembleFragmentPrompt(s)`.

export { COMPILE_OPTIONS, renderFragmentContent } from "./assemble";
export { EMPTY_FRAGMENT_BLOCK } from "./block";
export {
  checkPlacements,
  type PlacementCheckResult,
  type ResolveResult,
  resolveAndMerge,
  splitFragmentRef,
} from "./consistency";
export type {
  BuildResult,
  ErrorCode,
  FragmentCheckResult,
  ValidationError,
  ValidationWarning,
  WarningCode,
} from "./errors";
export { error, formatZodIssues, warning } from "./errors";
export { defaultFetcher, type Fetcher, type FetchResponse } from "./fetcher";
export {
  checkFragmentFileValue,
  checkFragmentTemplates,
  findDuplicateFragmentIds,
} from "./fragment";
export {
  type FileResolver,
  type FragmentResolver,
  type ParseHostResult,
  type Placement,
  parseHostPlacements,
  renderHostTemplate,
} from "./host-template";
export {
  type AssembleManyResult,
  type AssembleResult,
  assembleFragmentPrompt,
  assembleFragmentPrompts,
  DEFAULT_ALLOWED_SCHEMES,
  type LoadOptions,
  loadAndCheckFragmentFile,
  loadYaml,
  resolveFragmentUrl,
  schemeAllowed,
} from "./load";
export { parseYaml, validate } from "./parse";
export {
  type Fragment,
  type FragmentBlock,
  type FragmentFile,
  type FragmentFileRef,
  FragmentFileRefSchema,
  FragmentFileSchema,
  FragmentSchema,
  InputSchema,
  type TextFileRef,
  TextFileRefSchema,
  type VariableValue,
  VariableValueSchema,
} from "./schemas";
export { countLines, sliceLines } from "./text-files";
