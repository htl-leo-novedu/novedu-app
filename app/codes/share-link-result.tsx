import { CopyableLinkRow } from "./copyable-link-row";

// The shared create/edit-screen result for every module: the shareable `/<code>`
// link with a copy button. A coding code is a regular activity URL like the other
// three modules, so it gets the identical result body — the student visits it,
// signs in, and mints their personal API key (app/[code]/render-coding.tsx).
// Called directly by the create/edit page as a plain function, so no JSX lives in
// the server-only registry. `inventory` is a cloze exercise's gap inventory
// (docs/cloze.md), shown under the link so the teacher can check the gaps once more.
export function ShareLinkResult({ shareUrl, inventory }: { shareUrl: string; inventory?: string }) {
  return (
    <section className="flex flex-col gap-2 self-stretch rounded-xl border border-foreground/15 bg-foreground/5 px-4 py-3.5">
      <h2 className="font-bold">Share link</h2>
      <p className="text-foreground/60 text-sm">
        Send this link to your students — the last part of the URL is the code, which they can also
        type on the start page. It only works within the chosen time window.
      </p>
      <CopyableLinkRow link={shareUrl} label="Share link" />
      {inventory ? (
        <p className="text-foreground/60 text-sm" data-testid="cloze-gap-inventory">
          Gaps: {inventory}
        </p>
      ) : null}
    </section>
  );
}
