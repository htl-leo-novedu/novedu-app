import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { verifyMoodleToken } from "@/lib/moodle-launch";
import { LtiCard } from "../lti-card";
import { isPickError, PICK_ERRORS } from "./pick-errors";

// The code picker Moodle shows in its "Select content" dialog (docs/moodle.md).
// PUBLIC (excluded from the cookie gate): the teacher has no Novedu session
// inside Moodle's frame. The signed pick token rides along as a hidden field;
// `POST /api/lti/pick` checks the code and answers Moodle. Reveals nothing about
// any code — the error keys below are fixed messages.
export const dynamic = "force-dynamic";

export default async function PickPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.t === "string" ? params.t : undefined;
  if (!(await verifyMoodleToken("pick", token))) {
    return (
      <LtiCard heading="This page has expired">
        <p>This page has expired. Close it and click &lsquo;Inhalt auswählen&rsquo; again.</p>
      </LtiCard>
    );
  }
  const error = isPickError(params.error) ? PICK_ERRORS[params.error] : null;

  return (
    <LtiCard heading="Pick a Novedu quiz">
      <form method="post" action="/api/lti/pick" className="flex flex-col gap-3">
        <input type="hidden" name="t" value={token} />
        <Field>
          <FieldLabel htmlFor="lti-pick-code">
            Paste the Novedu code or link of your quiz
          </FieldLabel>
          <Input
            id="lti-pick-code"
            name="code"
            required
            autoComplete="off"
            className="font-mono"
            aria-invalid={error ? true : undefined}
          />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit">Use this quiz</Button>
        </div>
      </form>
    </LtiCard>
  );
}
