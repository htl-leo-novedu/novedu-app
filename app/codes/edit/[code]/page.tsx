import { Notice } from "@/components/notice";
import { Main } from "@/components/page-main";
import { requireTeacherPage } from "@/components/require-teacher-page";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { loadCloze } from "@/lib/cloze-fetch";
import { formatGapInventory } from "@/lib/cloze-gaps";
import { getCode } from "@/lib/code-store";
import { CodeForm } from "../../code-form";
import { ShareLinkResult } from "../../share-link-result";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

// Teacher-only: edit a code's note and availability window. The module + file URL
// are frozen (shown read-only). Any effective teacher may edit any code (RBAC
// planned) — the lookup is `getCode`, not the owner-gated one; the server action
// re-checks. The page resolves the shareable URL for the copy row.
export default async function EditCodePage({ params }: { params: Promise<{ code: string }> }) {
  const denied = await requireTeacherPage();
  if (denied) return denied;

  const { code } = await params;
  const entry = await getCode(code);

  if (entry === undefined) {
    return (
      <Main>
        <Notice heading="Code temporarily unavailable">
          <p>This code could not be loaded right now. Try again in a moment.</p>
        </Notice>
      </Main>
    );
  }
  if (entry === null) {
    return (
      <Main>
        <Notice heading="Code not found">
          <p>This code does not exist or has been deleted.</p>
        </Notice>
      </Main>
    );
  }

  const origin = await resolveAppOriginOr("");
  const shareUrl = origin ? `${origin}/${entry.code}` : `/${entry.code}`;
  // Every module gets the same share-link result. Rendered server-side and handed
  // to the client form as a slot, so the client never touches the server-only registry.
  // A cloze code also lists its gaps (the inventory the validator reported at upload).
  const cloze = entry.module === "cloze" ? await loadCloze(entry.fileUrl) : undefined;
  const inventory = cloze?.ok ? formatGapInventory(cloze.cloze.gaps) : undefined;
  const resultSlot = ShareLinkResult({ shareUrl, inventory });

  return (
    <Main>
      <CodeForm
        mode="edit"
        code={entry.code}
        initialModule={entry.module}
        initialFileUrl={entry.fileUrl}
        initialNote={entry.note}
        initialStartSeconds={entry.validFrom ? seconds(entry.validFrom) : undefined}
        initialEndSeconds={entry.validUntil ? seconds(entry.validUntil) : undefined}
        initialLlmProvider={entry.llm?.provider}
        initialLlmModel={entry.llm?.model}
        initialLlmReasoning={entry.llm?.reasoning}
        resultSlot={resultSlot}
      />
    </Main>
  );
}
