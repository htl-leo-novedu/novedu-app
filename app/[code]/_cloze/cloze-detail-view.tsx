import { type ListColumn, ListTable } from "@/components/data-list";
import { META_LABEL } from "@/components/ui/meta-label";
import { StatTile } from "@/components/ui/stat-tile";
import { VERDICT_VARS } from "@/components/ui/verdict";
import type { ClozeGap } from "@/lib/cloze-gaps";
import { type ClozeGapCount, gapTotal } from "@/lib/cloze-types";
import { cn } from "@/lib/utils";
import { LocalTime } from "../../local-time";
import { ClozeAnswerKey, type GapResult } from "./cloze-answer-key";

// The cloze module's teacher detail body (docs/cloze.md → Teacher view), pure
// presentation over what `ClozeDetail` loaded: the facts (file, window, model,
// "First submissions"), the answer key — the current text read-only, each gap with its
// reference, hint and a correct/partial/wrong bar — and the per-gap table. Only the
// rows matching the current (gap, reference) pairs are shown; when other rows exist, a
// note says that changed or renumbered gaps start from zero. If the exercise cannot
// be loaded, the stored counts are listed by gap number and reference instead.
// Nothing here is per student: counts only, never an answer.

export interface ClozeDetailData {
  fileUrl: string;
  validFrom: number | null;
  validUntil: number | null;
  llm?: { model: string; reasoning?: string };
  /** The current exercise (the public text with placeholders + the gaps), or why not. */
  exercise:
    | { ok: true; text: string; gaps: Omit<ClozeGap, "line" | "column">[] }
    | { ok: false; message: string };
  /** Every stored counts row of the code; `undefined` = the read failed. */
  counts: ClozeGapCount[] | undefined;
}

/** "First submissions": the largest per-gap total — the same number the /codes list shows. */
export function firstSubmissions(counts: readonly ClozeGapCount[]): number {
  return counts.reduce((max, row) => Math.max(max, gapTotal(row)), 0);
}

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

function countCell(verdict: "correct" | "partial" | "incorrect") {
  return (row: GapResult) => {
    const n = gapTotal(row);
    if (n === 0) return verdict === "correct" ? "No submissions yet" : null;
    return (
      <span className={cn("text-(--verdict)", VERDICT_VARS[verdict])}>
        {row[verdict]} <span className="text-foreground/60">· {percent(row[verdict], n)}</span>
      </span>
    );
  };
}

const COLUMNS: ListColumn<GapResult>[] = [
  { header: "Gap", kind: "numeric", render: (row) => row.gap },
  {
    header: "Reference",
    render: (row) => (
      <>
        {row.reference ? (
          <span className="font-semibold">{row.reference}</span>
        ) : (
          <em className="text-foreground/60">(empty)</em>
        )}
        {row.hint ? <span className="ml-1 text-foreground/60">({row.hint})</span> : null}
      </>
    ),
  },
  { header: "Correct", kind: "numeric", render: countCell("correct") },
  { header: "Partial", kind: "numeric", render: countCell("partial") },
  { header: "Wrong", kind: "numeric", render: countCell("incorrect") },
  { header: "n", kind: "numeric", render: (row) => gapTotal(row) },
];

function GapTable({ rows }: { rows: GapResult[] }) {
  return (
    <div data-testid="cloze-gap-table">
      <ListTable
        rows={rows}
        getRowKey={(row) => `${row.gap}\u0000${row.reference}`}
        columns={COLUMNS}
      />
    </div>
  );
}

const NOTE = "text-foreground/65 text-sm";

export function ClozeDetailView({ data }: { data: ClozeDetailData }) {
  const { exercise, counts } = data;

  // The rows of the CURRENT text, in gap order, zero-filled; everything else is stale.
  let rows: GapResult[] = [];
  let hiddenRows = 0;
  if (exercise.ok) {
    const byKey = new Map((counts ?? []).map((row) => [`${row.gap}\u0000${row.reference}`, row]));
    rows = exercise.gaps.map((gap) => {
      const row = byKey.get(`${gap.number}\u0000${gap.reference}`);
      return {
        gap: gap.number,
        reference: gap.reference,
        hint: gap.hint,
        correct: row?.correct ?? 0,
        partial: row?.partial ?? 0,
        incorrect: row?.incorrect ?? 0,
      };
    });
    hiddenRows = (counts ?? []).length - rows.filter((row) => gapTotal(row) > 0).length;
  }

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
        <dt className={META_LABEL}>File</dt>
        <dd className="wrap-anywhere">
          <a href={data.fileUrl} target="_blank" rel="noopener noreferrer">
            {data.fileUrl}
          </a>
        </dd>
        <dt className={META_LABEL}>Opens</dt>
        <dd>
          <LocalTime seconds={data.validFrom} fallback="No start" />
        </dd>
        <dt className={META_LABEL}>Closes</dt>
        <dd>
          <LocalTime seconds={data.validUntil} fallback="No end" />
        </dd>
        {data.llm ? (
          <>
            <dt className={META_LABEL}>Model</dt>
            <dd>
              <code>{data.llm.model}</code>
              {data.llm.reasoning ? (
                <>
                  {" · reasoning "}
                  <code>{data.llm.reasoning}</code>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      <div>
        <dl className="flex flex-wrap gap-4">
          <StatTile
            label="First submissions"
            value={counts === undefined ? "—" : firstSubmissions(counts)}
            data-testid="cloze-first-submissions"
          />
        </dl>
        <p className={cn("mt-2", NOTE)}>
          Counts each first submission, including teachers' test runs. Practice rounds aren't
          counted.
        </p>
        {counts === undefined ? (
          <p className={cn("mt-2", NOTE)} role="status">
            The statistics could not be loaded right now. Try again in a moment.
          </p>
        ) : null}
      </div>

      {exercise.ok ? (
        <>
          <section aria-labelledby="cloze-answer-key">
            <h2 id="cloze-answer-key" className="mb-2 font-semibold text-lg">
              Answer key with results
            </h2>
            <div className="rounded-lg border border-foreground/15 bg-card px-5 py-3">
              <ClozeAnswerKey text={exercise.text} gaps={rows} />
            </div>
          </section>
          <section aria-labelledby="cloze-gap-results">
            <h2 id="cloze-gap-results" className="mb-2 font-semibold text-lg">
              Results per gap
            </h2>
            <GapTable rows={rows} />
            {hiddenRows > 0 ? (
              <p className={cn("mt-2", NOTE)} data-testid="cloze-stale-note">
                Some gaps were changed or renumbered since students submitted. Their statistics
                start from zero; the earlier counts are not shown.
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <section aria-labelledby="cloze-gap-results" className="flex flex-col gap-3">
          <div
            role="alert"
            className="rounded-lg border border-foreground/15 bg-foreground/5 px-5 py-4"
          >
            <h2 className="font-semibold">This exercise could not be loaded</h2>
            <p className="mt-1">{exercise.message}</p>
          </div>
          <h2 id="cloze-gap-results" className="font-semibold text-lg">
            Stored results per gap
          </h2>
          {counts && counts.length > 0 ? (
            <GapTable rows={counts} />
          ) : (
            <p className={NOTE}>No submissions yet.</p>
          )}
        </section>
      )}
    </div>
  );
}
