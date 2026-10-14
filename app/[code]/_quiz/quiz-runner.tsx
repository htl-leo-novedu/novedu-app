"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ContentImage } from "@/components/content-image";
import { ImageErrorNotice } from "@/components/image-error-notice";
import { ReportButton } from "@/components/report-button";
import { Button } from "@/components/ui/button";
import { cardVariants } from "@/components/ui/card";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FieldError } from "@/components/ui/field";
import { MAX_IMAGES_PER_ANSWER } from "@/lib/answer-images";
import {
  IMAGE_ACCEPT_WITH_EXTENSIONS,
  type ImageDiagnostics,
  normalizeStudentImage,
} from "@/lib/image-normalize";
import { onModEnter, SUBMIT_KEYSHORTCUTS, useShortcutHint } from "@/lib/keyboard-shortcuts";
import { startDiscussion, submitAnswer } from "@/lib/quiz-actions";
import {
  type AttemptState,
  canSkip,
  completeCurrent,
  currentSlot,
  progressPosition,
  skipCurrent,
  skippedUnanswered,
  skippedWaiting,
  startAttempt,
} from "@/lib/quiz-attempt";
import { buildQuestionSequence } from "@/lib/quiz-sequence";
import {
  type QuizVerdict,
  type ResolvedQuiz,
  type ResolvedQuizQuestion,
  verdictLabel,
} from "@/lib/quiz-types";
import { buildRuntimeHeaders } from "@/lib/runtime-headers";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "../../markdown-renderer";
import { PrecheckIndicator } from "./precheck-indicator";
import { QuizDiscussion } from "./quiz-discussion";
import { SaveResult } from "./save-result";
import { useAnswerPrecheck } from "./use-answer-precheck";

// The quiz page column: centered and capped inside the PageBody canvas (which
// owns the horizontal gutter).
const RUNNER = "mx-auto flex w-full max-w-4xl flex-col gap-4";
const PROGRESS = "text-foreground/55 text-sm";
const CARD = cardVariants({ pad: "compact" });
const LABEL = "mb-1.5 block font-semibold text-sm";
const ACTIONS = "flex flex-wrap items-center gap-2";

// Verdict accent: the card/tile sets a local --verdict var per result;
// descendants (left border, heading, summary number, tile top border) consume
// it, so each verdict color lives in one place. (Named --verdict, not --accent:
// the global shadcn token block defines --accent.)
const VERDICT_VARS: Record<QuizVerdict, string> = {
  correct: "[--verdict:var(--color-success)]",
  partial: "[--verdict:var(--color-warning)]",
  incorrect: "[--verdict:var(--color-destructive)]",
};

// The student-facing quiz runner. Walks the attempt's question sequence one at a
// time: render the markdown question, take a free-text answer, grade it via
// the `submitAnswer` action (LLM verdict + feedback), then offer Next / Finish /
// an inline discussion. Before a verdict the student may Skip: the question moves
// to the back of the line and returns later with its draft answer restored. The
// sequence semantics (shuffle passes, `question_count` truncation/repeats) live in
// the pure `buildQuestionSequence` (lib/quiz-sequence.ts), the walk and skip rules
// in the pure lib/quiz-attempt.ts; the runner only calls them. The quiz CODE
// travels with every action so the server re-verifies it each time. Nothing is
// stored about the run while it lasts — skips never reach the server and a
// reload restarts the quiz. Only on the summary may the student save the
// attempt's COUNTS to their own statistics (`SaveResult`, docs/home.md), under
// the attempt's uuid minted here when the attempt starts.

type VerdictCounts = Record<QuizVerdict, number>;
type AnswerImage = { name: string; dataUrl: string };
/** An unsent answer, parked while its question waits after a skip. */
type Draft = { answer: string; images: AnswerImage[] };

export function QuizRunner({
  quiz,
  code,
  autoSave = false,
}: {
  quiz: ResolvedQuiz;
  code: string;
  /** The user's "save my quiz results" setting at page render (the server re-reads it). */
  autoSave?: boolean;
}) {
  // Build the sequence on the CLIENT after mount: server and first client render
  // both use the authored order (no hydration mismatch), then the effect applies
  // the real sequence once. `ready` gates the questions so the first visible
  // question never flickers.
  const [order, setOrder] = useState<ResolvedQuizQuestion[]>(quiz.questions);
  const [attempt, setAttempt] = useState<AttemptState>(() => startAttempt(quiz.questions.length));
  const [ready, setReady] = useState(false);
  // The attempt's identity for a saved result: a repeated save of it is a no-op.
  const [attemptId, setAttemptId] = useState("");
  useEffect(() => {
    const sequence = buildQuestionSequence(quiz.questions, {
      shuffle: quiz.shuffle,
      count: quiz.questionCount,
    });
    setOrder(sequence);
    setAttempt(startAttempt(sequence.length));
    setAttemptId(crypto.randomUUID());
    setReady(true);
  }, [quiz]);

  // Drafts of skipped questions, keyed by SLOT (drill mode repeats a question in
  // several slots). Memory only — a reload drops them with the rest of the run.
  const drafts = useRef(new Map<number, Draft>());
  const [answer, setAnswer] = useState("");
  // Photo answers (only offered when the current question's `imageInput` is
  // true): normalized client-side by the shared helper — decoded, straightened,
  // resized, re-encoded (lib/image-normalize.ts) — sent as data URLs, and
  // re-validated server-side. `imageError` is the dismissible upload notice; it
  // carries the per-file diagnostics so a student can hand a teacher something
  // more useful than "it did not work".
  const [images, setImages] = useState<AnswerImage[]>([]);
  const [imageError, setImageError] = useState<{
    messages: string[];
    diagnostics: ImageDiagnostics[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Keyboard flow (docs/styling.md, "Keyboard shortcuts"): Ctrl/⌘+Enter submits,
  // the verdict focuses Next/Finish, and Next/Skip focuses the next answer box —
  // never on first load, so a phone keyboard doesn't pop up uninvited.
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const focusAnswer = useRef(false);
  const submitHint = useShortcutHint("submit");
  const [grading, setGrading] = useState(false);
  const [verdict, setVerdict] = useState<{ result: QuizVerdict; feedback: string } | null>(null);

  useEffect(() => {
    if (verdict) nextRef.current?.focus();
  }, [verdict]);
  // Set by `moveTo`; runs after the render that shows the next question.
  useEffect(() => {
    if (!focusAnswer.current) return;
    focusAnswer.current = false;
    answerRef.current?.focus();
  });
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<VerdictCounts>({ correct: 0, partial: 0, incorrect: 0 });
  const [answered, setAnswered] = useState(0);
  const [finished, setFinished] = useState(false);
  const [discussion, setDiscussion] = useState<{
    threadId: string;
    threadToken: string;
    feedback: string;
  } | null>(null);
  const [openingDiscussion, setOpeningDiscussion] = useState(false);
  // The discussion lives in a modal DialogShell overlaying the page; closing
  // keeps the thread so the student can reopen it ("Continue discussion")
  // until they move on.
  const [discussionOpen, setDiscussionOpen] = useState(false);

  const total = order.length;
  const slot = currentSlot(attempt);
  const current = slot === undefined ? undefined : order[slot];

  // The live pre-check hint while typing. A HOOK, so it mounts above every early
  // return below — before `ready` the answer box is empty and the hook stays
  // inert anyway. Suspended once the answer is on its way to the grader and while
  // its verdict is on screen: the hint is never shown beside a verdict, so asking
  // for one there would only spend a call.
  const precheck = useAnswerPrecheck({
    enabled: quiz.immediateFeedback,
    code,
    questionId: current?.id ?? "",
    slot: slot ?? -1,
    text: answer,
    suspended: grading || verdict !== null,
  });

  if (!ready) {
    return (
      <div className={RUNNER}>
        <p className={PROGRESS}>Preparing quiz…</p>
      </div>
    );
  }

  if (finished || slot === undefined || !current) {
    return (
      <Summary
        counts={counts}
        answered={answered}
        total={total}
        skipped={skippedUnanswered(attempt)}
        save={
          answered > 0 ? (
            <SaveResult
              code={code}
              attemptId={attemptId}
              counts={{ ...counts, unanswered: total - answered }}
              total={total}
              autoSave={autoSave}
            />
          ) : null
        }
      />
    );
  }

  const isLast = !canSkip(attempt);
  const waiting = skippedWaiting(attempt);
  const keyOf = (s: number) => order[s]?.id;

  // Validate + read the picked files (camera or gallery). Accepted photos become
  // thumbnails; every rejected file's reason lands in one dismissible notice.
  async function handleAddImages(files: FileList | null) {
    if (!files || files.length === 0) return;
    const errors: string[] = [];
    const diagnostics: ImageDiagnostics[] = [];
    const accepted: AnswerImage[] = [];
    let count = images.length;
    for (const file of Array.from(files)) {
      if (count >= MAX_IMAGES_PER_ANSWER) {
        errors.push(`${file.name}: at most ${MAX_IMAGES_PER_ANSWER} photos per answer.`);
        continue;
      }
      const read = await normalizeStudentImage(file);
      diagnostics.push(read.diagnostics);
      if (read.ok) {
        accepted.push({ name: file.name, dataUrl: read.dataUrl });
        count += 1;
      } else {
        errors.push(`${file.name}: ${read.message}`);
      }
    }
    if (accepted.length > 0) setImages((prev) => [...prev, ...accepted]);
    // Diagnostics for every picked file, not just the rejected ones: when a photo
    // is accepted but the model still misreads it, what it was normalized TO is
    // the interesting half.
    setImageError(errors.length > 0 ? { messages: errors, diagnostics } : null);
  }

  async function handleSubmit(question: ResolvedQuizQuestion) {
    const trimmed = answer.trim();
    if ((!trimmed && images.length === 0) || grading) return;
    setGrading(true);
    setError(null);
    const res = await submitAnswer({
      code,
      questionId: question.id,
      answer: trimmed,
      images: images.map((image) => image.dataUrl),
    });
    setGrading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setVerdict({ result: res.result, feedback: res.feedback });
    setCounts((c) => ({ ...c, [res.result]: c[res.result] + 1 }));
    setAnswered((n) => n + 1);
  }

  async function handleOpenDiscussion(question: ResolvedQuizQuestion) {
    if (!verdict || openingDiscussion || discussion) return;
    setOpeningDiscussion(true);
    setError(null);
    const res = await startDiscussion({
      code,
      questionId: question.id,
      answer: answer.trim(),
      result: verdict.result,
      feedback: verdict.feedback,
      // The same photos the answer was graded with — seeded into the thread so
      // the discussion agent (and the teacher's transcript) sees them.
      images: images.map((image) => image.dataUrl),
    });
    setOpeningDiscussion(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDiscussion({
      threadId: res.threadId,
      threadToken: res.threadToken,
      feedback: verdict.feedback,
    });
    setDiscussionOpen(true);
  }

  function reset() {
    // Drop the thread for this question (DialogShell closes itself on unmount).
    setDiscussionOpen(false);
    setDiscussion(null);
    setVerdict(null);
    setAnswer("");
    setImages([]);
    setImageError(null);
    setError(null);
  }

  // Show the new current slot, restoring its parked draft if it was skipped.
  function moveTo(next: AttemptState) {
    reset();
    setAttempt(next);
    focusAnswer.current = true;
    const nextSlot = currentSlot(next);
    const draft = nextSlot === undefined ? undefined : drafts.current.get(nextSlot);
    if (draft) {
      setAnswer(draft.answer);
      setImages(draft.images);
    }
  }

  function goNext() {
    if (slot === undefined) return;
    drafts.current.delete(slot);
    const next = completeCurrent(attempt, keyOf);
    moveTo(next);
    if (currentSlot(next) === undefined) setFinished(true);
  }

  function handleSkip() {
    if (slot === undefined || grading || !canSkip(attempt)) return;
    if (answer !== "" || images.length > 0) drafts.current.set(slot, { answer, images });
    else drafts.current.delete(slot);
    moveTo(skipCurrent(attempt, keyOf));
  }

  return (
    <div className={RUNNER}>
      {quiz.title || quiz.description ? (
        <header>
          {quiz.title ? <h1 className="font-bold text-2xl">{quiz.title}</h1> : null}
          {quiz.description ? <MarkdownRenderer content={quiz.description} /> : null}
        </header>
      ) : null}

      <p className={PROGRESS}>
        Question {progressPosition(attempt, total)} of {total}
        {attempt.skipped.has(slot) ? " · skipped earlier" : null}
        {waiting > 0 ? ` · ${waiting} skipped for later` : null}
      </p>

      <section className={CARD}>
        {current.title ? <h2 className="mb-2 font-semibold text-lg">{current.title}</h2> : null}
        {current.image ? <ContentImage image={current.image} /> : null}
        <MarkdownRenderer content={current.question} />
      </section>

      {!verdict ? (
        <section className={CARD}>
          {/* The hint sits BESIDE the label, never inside it: the textarea's
              accessible name must stay exactly "Your answer". The row is as tall
              as the hint pill from the start, so its appearing shifts nothing. */}
          <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
            <label className={cn(LABEL, "mb-0")} htmlFor="quiz-answer">
              Your answer
            </label>
            <PrecheckIndicator state={precheck} />
          </div>
          <textarea
            id="quiz-answer"
            ref={answerRef}
            className="mb-3 min-h-28 w-full resize-y rounded-lg border border-foreground/25 bg-background px-3 py-2.5 text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={onModEnter(() => handleSubmit(current))}
            aria-keyshortcuts={SUBMIT_KEYSHORTCUTS}
            disabled={grading}
            placeholder="Type your answer…"
          />
          {imageError ? (
            <ImageErrorNotice
              className="mb-3"
              diagnostics={imageError.diagnostics}
              messages={imageError.messages}
              onDismiss={() => setImageError(null)}
              origin="quiz photo answer"
            />
          ) : null}
          {images.length > 0 ? (
            <AnswerThumbnails
              images={images}
              disabled={grading}
              onRemove={(i) => setImages((prev) => prev.filter((_, j) => j !== i))}
            />
          ) : null}
          <div className={ACTIONS}>
            <Button
              onClick={() => handleSubmit(current)}
              title={`Submit answer (${submitHint})`}
              disabled={grading || (answer.trim() === "" && images.length === 0)}
            >
              {grading ? "Checking…" : "Submit answer"}
            </Button>
            {current.imageInput ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={grading || images.length >= MAX_IMAGES_PER_ANSWER}
                >
                  Add photo
                </Button>
                {/* Hidden picker: `accept` offers the camera directly on phones. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={IMAGE_ACCEPT_WITH_EXTENSIONS}
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleAddImages(event.target.files);
                    // Allow re-picking the same file after a remove.
                    event.target.value = "";
                  }}
                />
              </>
            ) : null}
            {canSkip(attempt) ? (
              <Button variant="outline" onClick={handleSkip} disabled={grading}>
                Skip for now
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setFinished(true)} disabled={grading}>
              Finish
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section className={CARD}>
            <span className={LABEL}>Your answer</span>
            {answer.trim() !== "" ? (
              <p className="whitespace-pre-wrap leading-relaxed">{answer}</p>
            ) : null}
            {images.length > 0 ? <AnswerThumbnails images={images} /> : null}
          </section>
          <section
            className={cn(CARD, "border-l-(--verdict) border-l-4", VERDICT_VARS[verdict.result])}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="font-bold text-(--verdict) text-base capitalize">
                {verdictLabel(verdict.result)}
              </h3>
              {/* Report this graded answer. The quiz grade persists nothing, so
                  the report carries its own snapshot: the answer/verdict/feedback
                  just graded (still held in state until Next). The server re-loads
                  the authoritative question text (see lib/report-actions.ts). */}
              <ReportButton
                target={{
                  kind: "quiz-answer",
                  code,
                  questionId: current.id,
                  answer,
                  result: verdict.result,
                  feedback: verdict.feedback,
                  hadImages: images.length > 0,
                }}
              />
            </div>
            <MarkdownRenderer content={verdict.feedback} />
          </section>
          <div className={ACTIONS}>
            {!discussion ? (
              <Button
                variant="outline"
                onClick={() => handleOpenDiscussion(current)}
                disabled={openingDiscussion}
              >
                {openingDiscussion ? "Opening…" : "Chat about this"}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setDiscussionOpen(true)}>
                Continue discussion
              </Button>
            )}
            <Button ref={nextRef} onClick={goNext}>
              {isLast ? "Finish" : "Next question"}
            </Button>
            {!isLast ? (
              <Button variant="outline" onClick={() => setFinished(true)}>
                Finish now
              </Button>
            ) : null}
          </div>
        </>
      )}

      {error ? <FieldError>{error}</FieldError> : null}

      {discussion ? (
        <DialogShell
          open={discussionOpen}
          onClose={() => setDiscussionOpen(false)}
          title="Discuss this question"
        >
          <QuizDiscussion
            threadId={discussion.threadId}
            headers={buildRuntimeHeaders(code, discussion.threadToken)}
            feedback={discussion.feedback}
          />
        </DialogShell>
      ) : null}
    </div>
  );
}

// The picked photos as small thumbnails. With `onRemove` (the editing card) each
// thumbnail gets an overlaid remove button; without it (the answered card) the
// photos are display-only.
function AnswerThumbnails({
  images,
  onRemove,
  disabled = false,
}: {
  images: AnswerImage[];
  onRemove?: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {images.map((image, i) => (
        <div key={image.dataUrl} className="relative">
          {/* biome-ignore lint/performance/noImgElement: the src is an in-memory data URL — next/image's optimizer/loader doesn't apply. */}
          <img
            src={image.dataUrl}
            alt={image.name}
            className="h-20 w-20 rounded-lg border border-foreground/15 object-cover"
          />
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove photo ${image.name}`}
              className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-foreground/25 bg-background text-foreground/70 text-xs leading-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              onClick={() => onRemove(i)}
              disabled={disabled}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Summary({
  counts,
  answered,
  total,
  skipped,
  save,
}: {
  counts: VerdictCounts;
  answered: number;
  total: number;
  skipped: number;
  /** The save-to-statistics step; absent when nothing was answered. */
  save: ReactNode;
}) {
  return (
    <div className={RUNNER}>
      <div className="flex flex-col gap-3">
        <h1 className="font-bold text-2xl">Quiz summary</h1>
        <p className={PROGRESS}>
          You answered {answered} of {total} question{total === 1 ? "" : "s"}.
          {skipped > 0
            ? ` ${skipped} skipped question${skipped === 1 ? " was" : "s were"} not answered.`
            : null}
        </p>
        <div className="flex flex-wrap gap-4">
          <SummaryStat verdict="correct" count={counts.correct} label="correct" />
          <SummaryStat verdict="partial" count={counts.partial} label="partly correct" />
          <SummaryStat verdict="incorrect" count={counts.incorrect} label="wrong" />
        </div>
        {save}
        <p className={PROGRESS}>
          Reload the page to take the quiz again. Your answers are not stored.
        </p>
      </div>
    </div>
  );
}

function SummaryStat({
  verdict,
  count,
  label,
}: {
  verdict: QuizVerdict;
  count: number;
  label: string;
}) {
  return (
    <div
      className={cn(
        "grow basis-32 rounded-xl border border-foreground/15 border-t-(--verdict) border-t-[3px] p-4 text-center",
        VERDICT_VARS[verdict],
      )}
    >
      <span className="block font-bold text-(--verdict) text-3xl">{count}</span>
      <span className="text-foreground/55 text-sm">{label}</span>
    </div>
  );
}
