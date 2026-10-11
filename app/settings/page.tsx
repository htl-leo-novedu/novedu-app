import { DataUnavailable } from "@/components/dashboard-ui";
import { Notice } from "@/components/notice";
import { Main, PageBody } from "@/components/page-main";
import { cardVariants } from "@/components/ui/card";
import { countOwnQuizResults } from "@/lib/quiz-result-store";
import { getSession } from "@/lib/session";
import { getUserSettings } from "@/lib/user-settings-store";
import { QuizResultsSettings } from "./quiz-results-settings";

// The Settings page (docs/home.md → Settings page): the one home of per-user
// preferences, reached from the user menu, for every signed-in user in either
// role. A list of sections, each backed by a column of `novedu_user_settings`;
// today only "Quiz and exercise results". Gated by the session like every page — the page
// and its actions (lib/user-settings-actions.ts) act only on the session
// user's own row. No teacher gate, no bearer route.

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return (
      <Main>
        <Notice heading="Session problem">
          <p>Your session could not be read. Sign out and sign in again.</p>
        </Notice>
      </Main>
    );
  }

  const [settings, saved] = await Promise.all([
    getUserSettings(userId),
    countOwnQuizResults(userId),
  ]);

  return (
    <Main>
      <PageBody>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <section aria-labelledby="settings-quiz" className={cardVariants({ pad: "section" })}>
            <h2 id="settings-quiz" className="mb-3 font-semibold text-base tracking-tight">
              Quiz and exercise results
            </h2>
            {settings === undefined || saved === undefined ? (
              <DataUnavailable />
            ) : (
              <QuizResultsSettings
                initialSaveQuizResults={settings.saveQuizResults}
                initialSaved={saved}
              />
            )}
          </section>
        </div>
      </PageBody>
    </Main>
  );
}
