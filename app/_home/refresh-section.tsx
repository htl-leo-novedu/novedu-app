import Link from "next/link";
import { DataUnavailable } from "@/components/dashboard-ui";
import { AwardIcon, StarIcon } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import type { Medal } from "@/lib/achievements/quiz";
import { dayDistance, type LocalDate } from "@/lib/achievements/time";
import { getStudentHome, type QuizNudge } from "@/lib/home-data";
import { cn } from "@/lib/utils";
import {
  HOME_CAPTION,
  HOME_CARD,
  HOME_CARD_PAD,
  HOME_MUTED,
  HOME_SECTION_HEAD,
  HOME_SECTION_TITLE,
  plural,
} from "./home-ui";

// "Time to refresh": the saved quizzes and cloze exercises worth retaking (at most three, oldest
// last attempt first) and the medal count, from the student's OWN saved
// results — never shown to anyone else. Needs only the quiz fact group.

const MEDAL_DISC: Record<Medal | "none", string> = {
  gold: "bg-gold text-gold-ink",
  silver: "bg-silver text-silver-ink",
  bronze: "bg-bronze text-bronze-ink",
  none: "bg-card text-foreground/55 ring-1 ring-foreground/25 ring-inset",
};

const MEDAL_DOT: Record<Medal, string> = {
  gold: "bg-gold",
  silver: "bg-silver",
  bronze: "bg-bronze",
};

export async function RefreshSection({ userId }: { userId: string }) {
  const { quiz, today } = await getStudentHome(userId);
  let body: React.ReactNode;
  if (!quiz) {
    body = <DataUnavailable />;
  } else if (quiz.quizzes === 0) {
    body = (
      <p className={HOME_MUTED}>
        Save a result on a quiz's summary page or an exercise's results, and your medals and retake
        reminders show up here.
      </p>
    );
  } else {
    body = (
      <>
        {quiz.nudges.length === 0 ? (
          <p className={HOME_MUTED}>Nothing to refresh right now.</p>
        ) : (
          <ul>
            {quiz.nudges.map((nudge, i) => (
              <NudgeRow key={nudge.code} nudge={nudge} today={today} first={i === 0} />
            ))}
          </ul>
        )}
        <p
          className={cn(
            HOME_MUTED,
            "mt-3 flex flex-wrap gap-x-3.5 gap-y-1 border-foreground/10 border-t pt-3",
          )}
        >
          {(["gold", "silver", "bronze"] as const).map((medal) => (
            <span key={medal} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn("inline-block size-3 rounded-full", MEDAL_DOT[medal])}
              />
              {quiz.medals[medal]} {medal}
            </span>
          ))}
        </p>
      </>
    );
  }
  return (
    <section aria-labelledby="home-refresh" className={cn(HOME_CARD, HOME_CARD_PAD)}>
      <div className={cn(HOME_SECTION_HEAD, "mb-1")}>
        <h2 id="home-refresh" className={HOME_SECTION_TITLE}>
          Time to refresh
        </h2>
        <span className={HOME_MUTED}>from your saved quizzes and exercises</span>
      </div>
      <p className={cn(HOME_CAPTION, "mb-2.5")}>
        Your practice results, not grades. Gold = every answer fully correct.
      </p>
      {body}
    </section>
  );
}

function ago(date: LocalDate, today: LocalDate): string {
  const days = dayDistance(date, today);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${plural(days, "day", "days")} ago`;
}

function NudgeRow({ nudge, today, first }: { nudge: QuizNudge; today: LocalDate; first: boolean }) {
  const Glyph = nudge.medal === "gold" ? StarIcon : AwardIcon;
  return (
    <li
      className={cn(
        "grid grid-cols-[2.5rem_1fr_auto] items-center gap-3 py-2.5",
        !first && "border-foreground/10 border-t",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-10 place-items-center rounded-full [&_svg]:size-5",
          MEDAL_DISC[nudge.medal ?? "none"],
        )}
      >
        <Glyph />
      </span>
      <div className="min-w-0">
        <div className="truncate font-medium leading-snug">{nudge.label}</div>
        <div className={HOME_CAPTION}>
          <span className="sr-only">
            {nudge.medal ? `${nudge.medal} medal. ` : "No medal yet. "}
          </span>
          Last {nudge.lastPercent} %, {ago(nudge.lastOn, today)} · best {nudge.bestPercent} %
        </div>
      </div>
      <Link
        href={`/${nudge.code}`}
        aria-label={`Retake ${nudge.label}`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Retake
      </Link>
    </li>
  );
}

export function RefreshSkeleton() {
  return <div className={cn(HOME_CARD, "h-40")} aria-hidden="true" />;
}
