import { ClozeDetail } from "@/app/[code]/_cloze/cloze-detail";
import type { CodeModuleDef } from "./registry";

// The cloze module ("Fill the gaps", docs/cloze.md): students complete the gaps of one
// text and get a verdict per gap plus consolidated feedback. Like coding it has NO
// CopilotKit runtime — there is no chat; grading and feedback run through the
// `gradeCloze` / `explainCloze` server actions (lib/cloze-actions.ts), which call the
// internal `clozeEvaluator` agent. It is always anonymous (the code row freezes `true`,
// `readAnonymousFlag` answers `true`). The teacher detail shows the code's facts, the
// answer key with the per-gap verdict counts of first submissions, and the per-gap
// table (lib/cloze-counts-store.ts).
//
// SERVER-ONLY. Calls the ClozeDetail server component as a plain function so no JSX
// lives in this registry .ts file.
export const clozeModule: CodeModuleDef = {
  fileKind: "cloze",
  // No `runtime`: the CopilotKit route rejects any module without one.
  renderDetail: (entry) => ClozeDetail({ entry }),
};
