import { AccessDenied } from "@/components/notice";
import { Main } from "@/components/page-main";
import type { ParamRecord } from "@/lib/db/paging";
import { getListEngine } from "@/lib/list-engine";
import { isEffectiveTeacher } from "@/lib/student-mode";
import { ClassicCodesList } from "./_classic/classic-codes-list";
import { CodesList } from "./_list/codes-list";

// Teacher-only: the list of ALL codes. Two list engines render it side by side
// while the new one proves itself (see `docs/filtered-lists.md`, "The new list
// engine"); the device's Classic/New switch cookie picks one. "Effective"
// teacher: a teacher in student mode is denied like a student.
export default async function CodesPage({ searchParams }: { searchParams: Promise<ParamRecord> }) {
  if (!(await isEffectiveTeacher())) {
    return (
      <Main>
        <AccessDenied />
      </Main>
    );
  }
  const sp = await searchParams;
  return (await getListEngine()) === "new" ? <CodesList sp={sp} /> : <ClassicCodesList sp={sp} />;
}
