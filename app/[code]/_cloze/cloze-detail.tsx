import { Notice } from "@/components/notice";
import { META_LABEL } from "@/components/ui/meta-label";
import { loadCloze } from "@/lib/cloze-fetch";
import { formatGapInventory } from "@/lib/cloze-gaps";
import { type CodeEntry, effectiveLlm } from "@/lib/code-store";
import { LocalTime } from "../../local-time";

const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

// The cloze module's teacher detail body on /codes/[code]: the facts of the code — its
// exercise file, its window, the effective model and the current gap inventory (the
// teacher's own references, never a student answer). The page above it renders the
// shared chrome (back link, code, LLM-override line).
//
// SERVER COMPONENT: reads the exercise via `loadCloze`. The descriptor calls it as a
// plain function so no JSX lives in the server-only registry .ts file. The page mounting
// this already gates on `requireTeacherPage()`.
export async function ClozeDetail({ entry }: { entry: CodeEntry }) {
  const loaded = await loadCloze(entry.fileUrl);
  const llm = loaded.ok ? effectiveLlm(entry, loaded.cloze) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
        <dt className={META_LABEL}>File</dt>
        <dd className="wrap-anywhere">
          <a href={entry.fileUrl} target="_blank" rel="noopener noreferrer">
            {entry.fileUrl}
          </a>
        </dd>
        <dt className={META_LABEL}>Opens</dt>
        <dd>
          <LocalTime seconds={seconds(entry.validFrom)} fallback="No start" />
        </dd>
        <dt className={META_LABEL}>Closes</dt>
        <dd>
          <LocalTime seconds={seconds(entry.validUntil)} fallback="No end" />
        </dd>
        {llm ? (
          <>
            <dt className={META_LABEL}>Model</dt>
            <dd>
              <code>{llm.model}</code>
              {llm.reasoning ? (
                <>
                  {" · reasoning "}
                  <code>{llm.reasoning}</code>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      {loaded.ok ? (
        <div>
          <p className={`mb-1.5 ${META_LABEL}`}>Gaps</p>
          <p data-testid="cloze-inventory">{formatGapInventory(loaded.cloze.gaps)}</p>
        </div>
      ) : (
        <Notice heading="This exercise could not be loaded">
          <p>{loaded.message}</p>
        </Notice>
      )}
    </div>
  );
}
