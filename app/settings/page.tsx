import { DataUnavailable } from "@/components/dashboard-ui";
import { Notice } from "@/components/notice";
import { Main, PageBody } from "@/components/page-main";
import { cardVariants } from "@/components/ui/card";
import { resolveAppOriginOr } from "@/lib/app-origin";
import { moodleConnection, moodleKeyConfigured, publicKeyPem } from "@/lib/moodle-config";
import { countOwnQuizResults } from "@/lib/quiz-result-store";
import { getSession } from "@/lib/session";
import { effectiveTeacherForSession } from "@/lib/student-mode";
import { getTheme } from "@/lib/theme-server";
import { getUserSettings } from "@/lib/user-settings-store";
import { MoodleConnection, type MoodleConnectionView } from "./moodle-connection";
import { QuizResultsSettings } from "./quiz-results-settings";
import { ThemeSettings } from "./theme-settings";

// The Settings page (docs/home.md → Settings page): the one home of per-user
// preferences, reached from the user menu, for every signed-in user in either
// role. A list of sections: "Appearance" is this device's colour theme (a
// cookie, lib/theme.ts); "Quiz results" is backed by a column of
// `novedu_user_settings`; "Moodle connection" (effective teachers only) is the
// read-only view of the Moodle server configuration (docs/moodle.md). Gated by the session like every page — the page
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

  const [settings, saved, theme, teacher] = await Promise.all([
    getUserSettings(userId),
    countOwnQuizResults(userId),
    getTheme(),
    effectiveTeacherForSession(session),
  ]);
  const moodle = teacher ? await moodleConnectionView() : undefined;

  return (
    <Main>
      <PageBody>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <section
            aria-labelledby="settings-appearance"
            className={cardVariants({ pad: "section" })}
          >
            <h2 id="settings-appearance" className="mb-3 font-semibold text-base tracking-tight">
              Appearance
            </h2>
            <ThemeSettings initialTheme={theme} />
          </section>
          <section aria-labelledby="settings-quiz" className={cardVariants({ pad: "section" })}>
            <h2 id="settings-quiz" className="mb-3 font-semibold text-base tracking-tight">
              Quiz results
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
          {moodle && (
            <section aria-labelledby="settings-moodle" className={cardVariants({ pad: "section" })}>
              <h2 id="settings-moodle" className="mb-3 font-semibold text-base tracking-tight">
                Moodle connection
              </h2>
              <MoodleConnection view={moodle} />
            </section>
          )}
        </div>
      </PageBody>
    </Main>
  );
}

/** What the teacher's "Moodle connection" section shows; read from the server configuration. */
async function moodleConnectionView(): Promise<MoodleConnectionView> {
  const pem = moodleKeyConfigured() ? await publicKeyPem() : undefined;
  if (!pem) return { state: "no-key" };
  const origin = await resolveAppOriginOr("");
  return {
    state: "key",
    connectedTo: moodleConnection()?.issuer ?? null,
    toolUrl: `${origin}/api/lti/launch`,
    loginUrl: `${origin}/api/lti/login`,
    jwksUrl: `${origin}/api/lti/jwks`,
    publicKeyPem: pem,
  };
}
