import { expect, type Page, test } from "@playwright/test";
import { TEACHER_STORAGE_STATE } from "./auth.constants";
import { sendAndExpectReply } from "./chat.utils";
import { mintTutorCode } from "./code.utils";
import { setEditorContent, watchErrors } from "./page.utils";

// A tutor uploaded to the app (`/api/files/<name>`) that places a fragment from a
// SIBLING uploaded library, referenced by a relative URL. The tutor page, the chat
// agent and the attribution read all load it through the server's database fetcher
// (`appHostedFetcher`, docs/files.md) — never an HTTP request to the app's own public
// files route, which is teacher-only. A broken load shows "This tutor cannot be
// loaded" instead of the chat, so a streamed reply proves every path resolved both
// files. @live-db (writes `novedu_files`), runs in CI against the fake LLM.

test.use({ storageState: TEACHER_STORAGE_STATE });

const fragments = (id: string) => `id: ${id}
fragments:
  - id: persona
    version: 1
    content: |
      You are a friendly tutor. Answer briefly.
`;

const tutor = (libraryName: string) => `id: e2e-hosted-tutor
name: "E2E Hosted Tutor"
description: "Uploaded tutor placing a fragment from an uploaded sibling library."
anonymous: true
llm:
  model: RedHatAI/gemma-4-31B-it-FP8-Dynamic
prompt:
  fragment_files:
    - id: lib
      url: "${libraryName}"
  tutor_instructions: |
    {{fragment "lib.persona"}}
`;

async function uploadFile(page: Page, name: string, kind: string, content: string) {
  await page.goto("/files/new");
  await page.getByLabel(/Name/).fill(name);
  await page.getByLabel("Kind").selectOption(kind);
  await setEditorContent(page, content);
  await page.getByRole("button", { name: "Validate & create" }).click();
  await expect(page).toHaveURL(new RegExp(`/files/edit/${name}$`), { timeout: 60_000 });
}

test("an uploaded tutor with an uploaded fragment library chats", {
  tag: ["@live", "@live-db"],
}, async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const libraryName = `e2e-hosted-lib-${stamp}`;
  const tutorName = `e2e-hosted-tutor-${stamp}`;

  await uploadFile(page, libraryName, "fragment", fragments(libraryName));
  await uploadFile(page, tutorName, "tutor", tutor(libraryName));

  const tutorUrl = `${new URL(page.url()).origin}/api/files/${tutorName}`;
  const code = await mintTutorCode({ tutor: tutorUrl });

  const errors = watchErrors(page);
  await page.goto(`/${code}`);
  await sendAndExpectReply(page, { message: "HOSTED please say hello" });
  await expect(page.getByTestId("copilot-assistant-message").last()).toContainText(
    "You wrote: HOSTED please say hello",
  );
  expect(errors).toEqual([]);
});
