import { Notice } from "@/components/notice";
import { Main, PageBody } from "@/components/page-main";
import { loadCloze } from "@/lib/cloze-fetch";
import { toPublicCloze } from "@/lib/cloze-yaml";
import type { CodeEntry } from "@/lib/code-store";
import { ClozeRunner } from "./_cloze/cloze-runner";

// The cloze module's student render: load + leniently parse the exercise from the
// code's file_url (uncached, so a fix shows on the next load) and ship ONLY the public
// projection (`toPublicCloze` — title, task, the text with numbered placeholders, the
// hints) to the client runner. The reference answers, `evaluation`, `instructions` and
// the llm block never reach the browser. No thread, no thread token: the
// `gradeCloze` / `explainCloze` actions re-verify the code on every submission.
// Invoked by the thin module switch in app/[code]/page.tsx.
export async function RenderCloze({ entry, code }: { entry: CodeEntry; code: string }) {
  const loaded = await loadCloze(entry.fileUrl);
  if (!loaded.ok) {
    return (
      <Main>
        <Notice heading="This exercise cannot be opened">
          <p>{loaded.message}</p>
        </Notice>
      </Main>
    );
  }

  return (
    <Main>
      <PageBody className="block">
        <ClozeRunner code={code} cloze={toPublicCloze(loaded.cloze)} />
      </PageBody>
    </Main>
  );
}
