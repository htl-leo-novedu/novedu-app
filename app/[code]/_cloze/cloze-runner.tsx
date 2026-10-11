"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ArrowRightIcon, CheckIcon, ShieldCheckIcon, TextGapIcon } from "@/components/icons";
import { Spinner } from "@/components/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { explainCloze, gradeCloze, saveClozeResult } from "@/lib/cloze-actions";
import { type ClozePublic, MAX_CLOZE_ANSWER_LENGTH } from "@/lib/cloze-types";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "../../markdown-renderer";
import { SaveResult } from "../_quiz/save-result";
import { ClozeResults, type Feedback, type Graded } from "./cloze-results";
import { ClozeText } from "./cloze-text";

// The student-facing cloze runner ("Fill the gaps", docs/cloze.md). ONE text with
// numbered gaps: the student fills them in any order (Tab follows reading order) and
// submits the whole exercise. Submit is two server steps — `gradeCloze` returns a
// verdict and "a possible answer" per gap plus a result token, which `explainCloze`
// needs for the consolidated feedback (patterns + per-gap notes); the verdict chips
// show as soon as step 1 returns, the feedback fills in after step 2 (skipped when
// every gap is correct). Try again clears the gaps for a PRACTICE round (`round:
// "retry"`, never counted). After a FIRST round with at least one answer, the results
// screen offers the quiz's "save to your personal statistics" choice (`SaveResult` with
// `saveClozeResult`, docs/home.md) — never for a practice round. The code travels with
// every action so the server re-verifies it; answers live in page state only — a reload
// starts over.

const RUNNER = "mx-auto flex w-full max-w-5xl flex-col gap-4";
const MUTED = "text-foreground/60 text-sm";

type Round = "first" | "retry";

/** A graded round's slot counts for the saved result — an empty wrong gap is "unanswered". */
function resultCounts({ verdicts, answers }: Graded) {
  const counts = { correct: 0, partial: 0, incorrect: 0, unanswered: 0 };
  verdicts.forEach((verdict, i) => {
    if (verdict === "incorrect" && (answers[i] ?? "").trim() === "") counts.unanswered += 1;
    else counts[verdict] += 1;
  });
  return counts;
}

export function ClozeRunner({
  code,
  cloze,
  autoSave,
}: {
  code: string;
  cloze: ClozePublic;
  /** The user's result-save setting at page render — a display hint; the server decides. */
  autoSave: boolean;
}) {
  const total = cloze.gaps.length;
  const [answers, setAnswers] = useState<string[]>(() => cloze.gaps.map(() => ""));
  // The attempt's identity, minted on page load and again on Try again.
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const [round, setRound] = useState<Round>("first");
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [graded, setGraded] = useState<Graded | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ status: "loading" });
  const textRef = useRef<HTMLDivElement>(null);
  const focusFirstGap = useRef(false);
  // The result token on screen — a late feedback for an earlier round is dropped.
  const shownToken = useRef<string | null>(null);
  const idPrefix = useId();

  // After Try again, put the caret in gap 1 once the inputs are back.
  useEffect(() => {
    if (focusFirstGap.current && !graded) {
      focusFirstGap.current = false;
      textRef.current?.querySelector("input")?.focus();
    }
  });

  const filled = answers.filter((answer) => answer.trim() !== "").length;
  const empty = total - filled;

  async function explain(result: Graded) {
    setFeedback({ status: "loading" });
    const res = await explainCloze({
      code,
      attemptId: result.attemptId,
      answers: result.answers,
      verdicts: result.verdicts,
      resultToken: result.resultToken,
    });
    // A Try again while this was in flight has moved on — drop the stale answer.
    if (shownToken.current !== result.resultToken) return;
    setFeedback(
      res.ok
        ? { status: "done", patterns: res.patterns, gapNotes: res.gapNotes }
        : { status: "failed", message: res.message },
    );
  }

  async function submit() {
    if (grading) return;
    setConfirmEmpty(false);
    setGradeError(null);
    setGrading(true);
    const submitted = [...answers];
    const res = await gradeCloze({ code, attemptId, round, answers: submitted });
    setGrading(false);
    if (!res.ok) {
      setGradeError(res.message);
      return;
    }
    const result: Graded = {
      attemptId,
      answers: submitted,
      verdicts: res.verdicts,
      references: res.references,
      resultToken: res.resultToken,
    };
    shownToken.current = result.resultToken;
    setGraded(result);
    if (res.verdicts.every((verdict) => verdict === "correct")) {
      setFeedback({ status: "all-correct" });
    } else {
      void explain(result);
    }
  }

  function handleSubmitClick() {
    if (empty > 0 && !confirmEmpty) setConfirmEmpty(true);
    else void submit();
  }

  function tryAgain() {
    setAnswers(cloze.gaps.map(() => ""));
    setAttemptId(crypto.randomUUID());
    setRound("retry");
    shownToken.current = null;
    setGraded(null);
    setFeedback({ status: "loading" });
    setGradeError(null);
    setConfirmEmpty(false);
    focusFirstGap.current = true;
  }

  function renderInput(number: number): ReactNode {
    const gap = cloze.gaps[number - 1];
    if (!gap) return null;
    const hintId = `${idPrefix}-hint-${number}`;
    return (
      <span className="whitespace-nowrap">
        <sup aria-hidden="true" className="mr-0.5 text-foreground/55">
          {number}
        </sup>
        <Input
          aria-label={`Gap ${number}`}
          aria-describedby={gap.hint ? hintId : undefined}
          data-testid={`cloze-gap-${number}`}
          className="field-sizing-content h-8 min-w-28 max-w-full align-baseline text-base"
          maxLength={MAX_CLOZE_ANSWER_LENGTH}
          autoComplete="off"
          spellCheck={false}
          value={answers[number - 1] ?? ""}
          disabled={grading}
          onChange={(event) => {
            const value = event.target.value;
            setAnswers((prev) => prev.map((answer, i) => (i === number - 1 ? value : answer)));
            setConfirmEmpty(false);
          }}
        />
        {gap.hint ? (
          <span id={hintId} className="ml-1 text-foreground/55 text-sm">
            ({gap.hint})
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className={RUNNER}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="font-bold text-2xl">{cloze.title ?? "Fill the gaps"}</h1>
        <div className={cn("flex items-center gap-2", MUTED)}>
          {round === "retry" ? <Badge>Practice round</Badge> : null}
          {graded ? (
            <span className="flex items-center gap-1.5">
              <CheckIcon className="size-4" />
              Submitted · {total} {total === 1 ? "gap" : "gaps"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <TextGapIcon className="size-4" />
              Complete the whole text
            </span>
          )}
        </div>
      </header>

      {cloze.description ? (
        <section className={cardVariants({ pad: "compact" })}>
          <MarkdownRenderer content={cloze.description} />
        </section>
      ) : null}

      {graded ? (
        <ClozeResults
          text={cloze.text}
          gaps={cloze.gaps}
          graded={graded}
          feedback={feedback}
          onRetryFeedback={() => void explain(graded)}
          onTryAgain={tryAgain}
          save={
            round === "first" && graded.answers.some((answer) => answer.trim() !== "") ? (
              <SaveResult
                code={code}
                attemptId={graded.attemptId}
                counts={resultCounts(graded)}
                total={total}
                autoSave={autoSave}
                save={saveClozeResult}
              />
            ) : null
          }
        />
      ) : (
        <section className={cardVariants({ pad: "section" })}>
          <div ref={textRef}>
            <ClozeText text={cloze.text} renderGap={renderInput} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-foreground/15 border-t pt-4">
            <p className={MUTED}>
              <strong className="text-foreground">
                {filled} / {total}
              </strong>{" "}
              gaps filled
            </p>
            {confirmEmpty ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm">
                  {empty} {empty === 1 ? "gap is" : "gaps are"} empty — submit anyway?
                </p>
                <Button variant="outline" onClick={() => setConfirmEmpty(false)}>
                  Keep editing
                </Button>
                <Button onClick={() => void submit()}>Submit anyway</Button>
              </div>
            ) : (
              <Button onClick={handleSubmitClick} disabled={grading} aria-busy={grading}>
                {grading ? (
                  <>
                    <Spinner /> Checking…
                  </>
                ) : (
                  <>
                    Submit exercise <ArrowRightIcon />
                  </>
                )}
              </Button>
            )}
          </div>
          {gradeError ? <FieldError className="mt-3 text-right">{gradeError}</FieldError> : null}
        </section>
      )}

      <footer className={cn("flex flex-wrap items-center justify-between gap-2", MUTED)}>
        <span className="flex items-center gap-1.5">
          <ShieldCheckIcon className="size-4" />
          Anonymous activity
        </span>
        {graded ? null : <span>Tab moves between gaps in reading order</span>}
      </footer>
    </div>
  );
}
