import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { confirmMoodleLink, declineMoodleLink } from "@/lib/moodle-actions";
import { checkArrival } from "@/lib/moodle-arrival";
import { ARRIVAL_COOKIE } from "@/lib/moodle-launch";
import { getSession } from "@/lib/session";
import { LtiCard } from "../lti-card";

// The one-time confirmation that the Novedu and the Moodle account are both the
// student's (docs/moodle.md). Shown only while the signed arrival cookie says
// "confirm"; any other state goes back through `/lti/arrive`, which clears the
// cookie and shows the matching message (a page cannot delete a cookie). The
// two buttons are server actions that read the cookie AGAIN, never a form field.
export const dynamic = "force-dynamic";

export default async function LinkPage() {
  const session = await getSession();
  const user = session?.user;
  if (!user?.id) redirect("/sign-in?callbackURL=%2Flti%2Farrive");

  const check = await checkArrival(user.id, (await cookies()).get(ARRIVAL_COOKIE)?.value);
  if (check.decision !== "confirm") redirect("/lti/arrive");
  const { arrival } = check;

  return (
    <LtiCard heading="Link your Moodle account?">
      <p>
        You opened this quiz from Moodle. To hand in results to Moodle, Novedu needs to know that
        these two accounts are both yours.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-semibold">Novedu:</dt>
        <dd data-testid="link-novedu">
          {user.name} · {user.email}
        </dd>
        <dt className="font-semibold">Moodle:</dt>
        <dd data-testid="link-moodle">
          {arrival.name}
          {arrival.username ? ` (${arrival.username})` : ""}
        </dd>
      </dl>
      <p className="text-foreground/70 text-sm">
        {arrival.course ? (
          <>You came from the Moodle course &ldquo;{arrival.course}&rdquo;. </>
        ) : null}
        If you link them, Novedu stores your Moodle user id (not your name) and where in Moodle a
        result of this quiz goes. Your teacher still sees nothing in Novedu; a result reaches Moodle
        only when you click &ldquo;Hand in to Moodle&rdquo;. You can undo the link in Settings.
      </p>
      <div className="mt-1 flex flex-wrap gap-3">
        <form action={confirmMoodleLink}>
          <Button type="submit">Yes, these are both me</Button>
        </form>
        <form action={declineMoodleLink}>
          <Button type="submit" variant="outline">
            That&apos;s not me
          </Button>
        </form>
      </div>
    </LtiCard>
  );
}
