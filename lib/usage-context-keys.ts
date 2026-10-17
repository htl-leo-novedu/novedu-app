// Shared RequestContext key names for usage attribution. CLIENT-SAFE: pure string
// constants with NO database or server-only imports, so the CopilotKit route, the quiz
// grader action, the eval routes and the observability exporter all reference the SAME
// keys without a shared server module.
//
// The three keys are set (`setUsageContext`) on the per-request RequestContext at each
// agent seam (the CopilotKit route's `built.context`; the quiz grader's RequestContext
// in lib/quiz-actions.ts; the eval routes) and registered in the Observability instance's
// `requestContextKeys` (app/mastra/index.ts), so Mastra snapshots them onto every
// span's `requestContext` for app/mastra/usage-exporter.ts to read.

/** The activity code the usage is attributed to (drives `usage_by_code`). */
export const USAGE_CODE = "usageCode";

/**
 * The student's session user id (`novedu_user.id`, drives `usage_by_user`). Absent ⇒ only `usage_by_code`
 * is metered. Set for ALL codes incl.
 * anonymous ones — it is only ever stored against an hour bucket, never linked to
 * the code, so the anonymity invariant is unchanged (docs/codes.md).
 */
export const USAGE_USER_ID = "usageUserId";

/**
 * The code's module (`tutor` | `quiz` | `writing` | `coding`), required for the
 * `usage_by_code` INSERT branch.
 */
export const USAGE_MODULE = "usageModule";

/** Attribute an agent run's token usage: the three keys above, set at every agent seam. */
export function setUsageContext(
  context: { set(key: string, value: unknown): void },
  usage: { code: string; userId: string; module: string },
): void {
  context.set(USAGE_CODE, usage.code);
  context.set(USAGE_USER_ID, usage.userId);
  context.set(USAGE_MODULE, usage.module);
}
