import type { ReactNode } from "react";
import { CENTERED_CARD, CENTERED_CARD_HEADING, CENTERED_CARD_WRAPPER } from "@/components/notice";
import { Main } from "@/components/page-main";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

// The centred card of the /lti pages: they render without the app chrome
// (components/app-chrome.tsx), so the card carries the product name itself,
// like the sign-in page.
export function LtiCard({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Main>
      <section className={cn(CENTERED_CARD_WRAPPER, "items-center")}>
        <div className={CENTERED_CARD}>
          <p className="mb-1 font-semibold text-foreground/55 text-sm">{BRAND}</p>
          <h2 className={CENTERED_CARD_HEADING}>{heading}</h2>
          <div className="flex flex-col gap-3">{children}</div>
        </div>
      </section>
    </Main>
  );
}
