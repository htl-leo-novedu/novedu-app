import { listClozeGapCounts } from "@/lib/cloze-counts-store";
import { loadCloze } from "@/lib/cloze-fetch";
import { toPublicCloze } from "@/lib/cloze-yaml";
import { type CodeEntry, effectiveLlm } from "@/lib/code-store";
import { ClozeDetailView } from "./cloze-detail-view";

const seconds = (date: Date | null) => (date ? Math.floor(date.getTime() / 1000) : null);

// The cloze module's teacher detail body on /codes/[code] (docs/cloze.md → Teacher
// view): loads the current exercise and the code's per-gap counts, then hands plain
// data to `ClozeDetailView` (facts, answer key with results, the per-gap table). The
// page above it renders the shared chrome (back link, code, LLM-override line).
//
// SERVER COMPONENT: reads the exercise via `loadCloze` and the counts via
// lib/cloze-counts-store.ts. The descriptor calls it as a plain function so no JSX
// lives in the server-only registry .ts file. The page mounting this already gates on
// `requireTeacherPage()`. The answer key is the teacher's own text: the references
// are shown here on purpose (never to a student before grading).
export async function ClozeDetail({ entry }: { entry: CodeEntry }) {
  const [loaded, counts] = await Promise.all([
    loadCloze(entry.fileUrl),
    listClozeGapCounts(entry.code),
  ]);
  const llm = loaded.ok ? effectiveLlm(entry, loaded.cloze) : undefined;

  return (
    <ClozeDetailView
      data={{
        fileUrl: entry.fileUrl,
        validFrom: seconds(entry.validFrom),
        validUntil: seconds(entry.validUntil),
        llm: llm ? { model: llm.model, reasoning: llm.reasoning } : undefined,
        exercise: loaded.ok
          ? {
              ok: true,
              text: toPublicCloze(loaded.cloze).text,
              gaps: loaded.cloze.gaps,
            }
          : { ok: false, message: loaded.message },
        counts,
      }}
    />
  );
}
