import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { CODE_PATTERN } from "@/lib/code-store";
import { type DoneState, isDoneState } from "@/lib/moodle-launch";
import { LtiCard } from "../lti-card";

// The end of an arrival from Moodle that did not open the quiz directly
// (docs/moodle.md): only shows the message for `state`. The address carries
// nothing personal — the state from a fixed list and, when known, the
// pattern-checked code for the "Open the quiz" link. Nothing is stored here.
export const dynamic = "force-dynamic";

const OPEN_QUIZ = "Open the quiz";
const OPEN_WITHOUT_HAND_IN = "Open the quiz without hand-in";

const MESSAGES: Record<DoneState, { heading: string; body: ReactNode; link: string }> = {
  expired: {
    heading: "This link from Moodle has expired",
    body: <p>This link from Moodle has expired. Open the activity from Moodle again.</p>,
    link: OPEN_WITHOUT_HAND_IN,
  },
  "mismatch-moodle": {
    heading: "This Moodle account can't be used here",
    body: (
      <>
        <p>
          The Moodle account you came from is already linked to a different Novedu account. Its
          owner can undo that in Novedu under Settings → Moodle account.
        </p>
        <p>You can still take the quiz, but you can&apos;t hand in to Moodle.</p>
      </>
    ),
    link: OPEN_QUIZ,
  },
  "mismatch-novedu": {
    heading: "This Moodle account can't be used here",
    body: (
      <>
        <p>
          Your Novedu account is linked to a different Moodle account. You can undo that under
          Settings → Moodle account.
        </p>
        <p>You can still take the quiz, but you can&apos;t hand in to Moodle.</p>
      </>
    ),
    link: OPEN_QUIZ,
  },
  "no-name": {
    heading: "Your accounts can't be linked",
    body: (
      <p>
        Your Moodle doesn&apos;t share your name with Novedu, so your accounts can&apos;t be linked
        and you can&apos;t hand in. Please tell your teacher.
      </p>
    ),
    link: OPEN_QUIZ,
  },
  declined: {
    heading: "Nothing was linked",
    body: (
      <p>
        Nothing was linked. Sign out of the account that isn&apos;t yours (Moodle or Novedu), then
        open the activity from Moodle again.
      </p>
    ),
    link: OPEN_WITHOUT_HAND_IN,
  },
  unavailable: {
    heading: "Moodle link not checked",
    body: (
      <p>
        Novedu could not check your Moodle link right now. Open the activity from Moodle again in a
        moment.
      </p>
    ),
    link: OPEN_WITHOUT_HAND_IN,
  },
};

export default async function DonePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string | string[]; code?: string | string[] }>;
}) {
  const params = await searchParams;
  const state = isDoneState(params.state) ? params.state : "expired";
  const code =
    typeof params.code === "string" && CODE_PATTERN.test(params.code) ? params.code : null;
  const message = MESSAGES[state];

  return (
    <LtiCard heading={message.heading}>
      <div className="flex flex-col gap-2" data-testid="lti-done-message">
        {message.body}
      </div>
      {code ? (
        <div className="mt-1">
          <Link href={`/${code}`} className={buttonVariants({ variant: "outline" })}>
            {message.link}
          </Link>
        </div>
      ) : null}
    </LtiCard>
  );
}
