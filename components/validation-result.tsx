import {
  type FragmentCheckResult,
  formatZodIssues,
  type ValidationError,
  type ValidationWarning,
} from "@/lib/prompt-fragments";

// Pure presentational views for a validation result's errors, warnings, and (for
// a fragment library) its successful summary. Shared by the tutor-code form and
// the YAML Files create/edit forms — kept in components/ (not a route folder)
// since several features depend on it. Rendered and tested in isolation with
// plain props (no fetch, no state).

// Local recipes shared by the error/warning/fragment items below.
const LIST = "flex flex-col gap-2";
const ITEM = "flex flex-wrap items-baseline gap-2 rounded-lg px-3 py-2 text-sm";
const HEADING = "mb-2 font-semibold";
const CODE_CHIP =
  "shrink-0 rounded-sm bg-foreground/10 px-1 py-px font-mono font-semibold text-xs tracking-wide";
const WHERE = "shrink-0 font-mono text-foreground/55 text-xs";

/** The success shape of a standalone fragment-FILE check. */
type OkFragment = Extract<FragmentCheckResult, { ok: true }>;

export function locationOf(item: {
  fileAlias?: string;
  fragmentId?: string;
  questionId?: string;
  variable?: string;
}): string | null {
  const parts = [item.fileAlias, item.fragmentId, item.questionId].filter(Boolean).join(" / ");
  if (!parts && !item.variable) return null;
  return item.variable ? `${parts}${parts ? " · " : ""}${item.variable}` : parts;
}

export function ErrorList({ errors }: { errors: ValidationError[] }) {
  return (
    <section>
      <h2 className={HEADING}>Validation failed ({errors.length})</h2>
      <ul className={LIST}>
        {errors.map((err) => {
          const where = locationOf(err);
          const issues = err.zodIssues ? formatZodIssues(err.zodIssues) : [];
          return (
            <li
              key={`${err.code}-${err.fragmentId ?? ""}-${err.questionId ?? ""}-${err.variable ?? ""}-${err.message}`}
              className={`${ITEM} border border-red-200 bg-red-50`}
            >
              <span className={CODE_CHIP}>{err.code}</span>
              <span className="flex-1">{err.message}</span>
              {where ? <span className={WHERE}>{where}</span> : null}
              {issues.length > 0 ? (
                // Field-level detail under a schema error (the flattened Zod
                // issues). Takes a full row of the flex item so each issue sits
                // on its own line.
                <ul className="mt-0.5 flex basis-full list-disc flex-col gap-0.5 pl-4">
                  {issues.map((issue) => (
                    <li key={issue} className="font-mono text-xs">
                      {issue}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function FragmentSummary({ result }: { result: OkFragment }) {
  const count = result.fragmentIds.length;
  return (
    <section>
      <h2 className={HEADING}>
        Valid fragment library: <code>{result.fragmentFileId}</code>
      </h2>
      <p className="text-foreground/60">
        {count} fragment{count === 1 ? "" : "s"} — every template renders against its declared
        inputs.
      </p>
      <ul className={LIST}>
        {result.fragmentIds.map((id) => (
          <li
            key={id}
            className="flex items-baseline gap-2 rounded-md bg-foreground/5 px-2 py-1 text-sm"
          >
            <span className={CODE_CHIP}>{id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WarningList({ warnings }: { warnings: ValidationWarning[] }) {
  return (
    <section>
      <h2 className={HEADING}>Warnings ({warnings.length})</h2>
      <ul className={LIST}>
        {warnings.map((warn) => {
          const where = locationOf(warn);
          return (
            <li
              key={`${warn.code}-${warn.fragmentId ?? ""}-${warn.variable ?? ""}-${warn.message}`}
              className={`${ITEM} border border-amber-200 bg-amber-50`}
            >
              <span className={CODE_CHIP}>{warn.code}</span>
              <span className="flex-1">{warn.message}</span>
              {where ? <span className={WHERE}>{where}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The validator's one-line content summary shown after a successful validate or
 * save (a cloze exercise's gap inventory, e.g. `10 gaps · 1 "is going to" · …`).
 */
export function ContentSummary({ summary }: { summary: string }) {
  return <p className="text-foreground/70 text-sm">{summary}</p>;
}
