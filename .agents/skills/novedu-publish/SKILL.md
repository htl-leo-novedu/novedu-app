---
name: novedu-publish
description: Publish novedu into production
---

**Prerequisite:** After your changes, you performed a full QA run including live e2e tests. For a change that touches many tests, also run `npm run test:unit` with the top-level `env:` of `.github/workflows/qa.yml` exported (e.g. CI sets `DATABASE_URL`), so a test that silently depends on the local environment fails before the push, not in CI.

**Check whether the CLI must be republished** — but *not* by "are there changes under `./cli`". The CLI's `validate`, `prompts` and `eval` commands bundle app code (`lib/prompt-fragments`, the `*-validate` modules, `lib/tutors`, the prompt builders and eval schemas) into `dist/main.js` at build time, so the published `@novedu/cli` goes stale whenever those change, even with no `./cli` diff. Republish if the release touches any module the CLI imports (`grep -rhoE "@/lib/[^\"']+" cli/src`) or anything they import. If the user already decided, follow that; if borderline, ask.

**Moodle hand-in:** CI tests it only against a fake platform. When the release changes the Moodle code (`lib/moodle-*`, `app/lti`, `app/api/lti`, the quiz Finish page or receipts in `submitAnswer`, sign-in or `proxy.ts`, the `jose` package), say so and offer a run of the `novedu-moodle-test` skill against a local Moodle; Rainer decides.

**Note:** the teacher guide (`teacher-docs/`) is not in the image — `promote.yml` builds it from the promoted image's commit and uploads it to https://docs.novedu.at, so no extra publish step exists for docs. A `teacher-docs/**` change still needs this whole flow to reach docs.novedu.at: `docker-publish.yml` builds an image for it by design (the image version is the release unit), and the promotion publishes the guide. Verify with `https://docs.novedu.at/version.txt` (the commit the guide was built from).

**Steps:**
1. Create a new branch with a fitting name
2. Commit changes to the branch
3. Create a PR based on the branch
4. Monitor the QA GH Action using `gh` CLI and wait for it to complete
5. If the QA run is successful, merge the PR
6. Monitor `docker-publish.yml` and ensure it completes successfully — the image build and the `deploy-dev` job, which deploys it to the dev stage (green = `https://dev.novedu.at/api/version` reports the new version).
7. Promote the same version to production (the prod stage, `app.novedu.at`): `gh workflow run promote.yml` (an empty `version` takes what dev runs) and monitor the run — green = `https://app.novedu.at/api/version` reports the new version. Promotion rebuilds no image (it builds only the teacher guide); rollback is the same workflow with an older version (`docs/azure-runtime-env.md`).

**Publishing the CLI** (when the check above says so): bump `cli/package.json` `"version"` (usually no source change — the new logic is bundled on rebuild), land it on `main` via the steps above, then `git tag cli-v<version> && git push origin cli-v<version>` to trigger `publish-cli.yml`. Verify with `npm view @novedu/cli version`.
