import { Main } from "@/components/page-main";
import { requireTeacherPage } from "@/components/require-teacher-page";
import { parseModuleParam } from "@/lib/code-modules/types";
import { moodleAvailable } from "@/lib/moodle-config";
import { CodeForm } from "../code-form";

// Teacher-only: create a code that grants students time-windowed access to an
// activity. The server action enforces the same rule; this page-level check is
// for honest UX, not security. On success the action redirects to the new code's
// edit page (which shows the shareable link).
//
// `?module=<kind>&file=<url>` pre-fills the activity + file URL — the "Create
// code" deep link from the YAML Files list lands here with a hosted file's public
// URL and its kind.
export default async function NewCodePage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string | string[]; file?: string | string[] }>;
}) {
  const denied = await requireTeacherPage();
  if (denied) return denied;

  const params = await searchParams;
  const fileParam = Array.isArray(params.file) ? params.file[0] : (params.file ?? "");
  const initialModule = parseModuleParam(params.module) ?? "tutor";

  return (
    <Main>
      <CodeForm
        mode="create"
        initialModule={initialModule}
        initialFileUrl={fileParam}
        moodleAvailable={(await moodleAvailable()) !== undefined}
      />
    </Main>
  );
}
