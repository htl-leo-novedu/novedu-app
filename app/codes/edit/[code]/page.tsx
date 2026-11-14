import { Notice } from "@/components/notice";
import { Main } from "@/components/page-main";
import { requireTeacherPage } from "@/components/require-teacher-page";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { getCode } from "@/lib/code-store";
import { moodleAvailable } from "@/lib/moodle-config";
import { CodeForm } from "../../code-form";
import { ShareLinkResult } from "../../share-link-result";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

// Teacher-only: edit a code's note, availability window, LLM override and (for a
// quiz, while Moodle is connected) its Moodle hand-in switch. The module + file URL
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
  const resultSlot = ShareLinkResult({ shareUrl });

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
        moodleAvailable={(await moodleAvailable()) !== undefined}
        initialMoodle={entry.moodle}
      />
    </Main>
  );
}
