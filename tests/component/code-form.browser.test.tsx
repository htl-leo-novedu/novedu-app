import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  addToDatetimeLocal,
  datetimeLocalToUnixSeconds,
  nowAsDatetimeLocal,
  unixSecondsToDatetimeLocal,
} from "@/lib/datetime-local";

// The form is reused for create AND edit. Server actions need auth + the
// database, neither of which exists in the browser runner, so they are mocked to
// capture the submitted FormData — letting the tests assert the browser→server
// contract (especially the local-time → unix-seconds conversion the form does).

const created: FormData[] = [];
const updated: { code: string; formData: FormData }[] = [];
let updateResult: { status: string; message?: string; errors?: unknown[] } = { status: "saved" };

vi.mock("@/lib/code-actions", () => ({
  createCodeAction: vi.fn(async (_prev: unknown, formData: FormData) => {
    created.push(formData);
    // The real action redirects; the form renders nothing extra in create mode.
    return { status: "idle" };
  }),
  updateCodeAction: vi.fn(async (code: string, _prev: unknown, formData: FormData) => {
    updated.push({ code, formData });
    return updateResult;
  }),
}));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));

import { CodeForm } from "@/app/codes/code-form";
import { ShareLinkResult } from "@/app/codes/share-link-result";

const FILE_URL = "https://example.com/tutor.yaml";
const START = "2026-06-10T10:00";
const END = "2026-06-10T12:00";

function inputValue(locator: { element: () => Element }): string {
  return (locator.element() as HTMLInputElement).value;
}

test("create: submits module, file URL, note, and window as unix seconds (local-time converted)", async () => {
  created.length = 0;
  const screen = await render(<CodeForm mode="create" initialModule="quiz" />);

  await screen.getByLabelText("Activity YAML URL").fill(FILE_URL);
  await screen.getByLabelText(/Note/).fill("My class");
  await screen.getByLabelText(/Available from/).fill(START);
  await screen.getByLabelText(/Available until/).fill(END);
  await screen.getByRole("button", { name: "Create code" }).click();

  await vi.waitFor(() => expect(created).toHaveLength(1));
  const formData = created[0];
  if (!formData) throw new Error("no FormData captured");
  expect(formData.get("module")).toBe("quiz");
  expect(formData.get("file")).toBe(FILE_URL);
  expect(formData.get("note")).toBe("My class");
  // Converted IN THE BROWSER — the only place the user's timezone is known.
  expect(formData.get("startTs")).toBe(String(datetimeLocalToUnixSeconds(START)));
  expect(formData.get("endTs")).toBe(String(datetimeLocalToUnixSeconds(END)));
});

test("create: the Now button fills 'Available from' with the current local time", async () => {
  const screen = await render(<CodeForm mode="create" />);

  await screen.getByRole("button", { name: "Now" }).click();

  const value = inputValue(screen.getByLabelText(/Available from/));
  const drift = Math.abs(
    datetimeLocalToUnixSeconds(value) - datetimeLocalToUnixSeconds(nowAsDatetimeLocal()),
  );
  expect(drift).toBeLessThanOrEqual(60);
});

test("create: +1h/+1d/+1w start from 'Available from' when until is empty, then extend until", async () => {
  const screen = await render(<CodeForm mode="create" />);
  await screen.getByLabelText(/Available from/).fill(START);

  await screen.getByRole("button", { name: "+1h" }).click();
  const until = screen.getByLabelText(/Available until/);
  expect(inputValue(until)).toBe(addToDatetimeLocal(START, 1, "hours"));

  await screen.getByRole("button", { name: "+1d" }).click();
  expect(inputValue(until)).toBe(
    addToDatetimeLocal(addToDatetimeLocal(START, 1, "hours"), 1, "days"),
  );
});

test("create: the Clear button empties a date field and submits it as an open bound", async () => {
  created.length = 0;
  const screen = await render(<CodeForm mode="create" />);

  await screen.getByLabelText("Activity YAML URL").fill(FILE_URL);
  await screen.getByLabelText(/Available from/).fill(START);
  await screen.getByLabelText(/Available until/).fill(END);

  // Clear the start: the field empties and the open-ended bound is submitted blank.
  await screen.getByRole("button", { name: "Clear start" }).click();
  expect(inputValue(screen.getByLabelText(/Available from/))).toBe("");

  await screen.getByRole("button", { name: "Create code" }).click();

  await vi.waitFor(() => expect(created).toHaveLength(1));
  const formData = created[0];
  if (!formData) throw new Error("no FormData captured");
  expect(formData.get("startTs")).toBe("");
  expect(formData.get("endTs")).toBe(String(datetimeLocalToUnixSeconds(END)));
});

test("edit: file URL is read-only, fields are pre-filled, and the shareable link shows", async () => {
  const shareUrl = "http://localhost:3000/a1b2c3d4e5";
  const screen = await render(
    <CodeForm
      mode="edit"
      code="a1b2c3d4e5"
      initialModule="tutor"
      initialFileUrl={FILE_URL}
      initialNote="3AHIF exercise"
      initialStartSeconds={datetimeLocalToUnixSeconds(START)}
      initialEndSeconds={datetimeLocalToUnixSeconds(END)}
      resultSlot={<ShareLinkResult shareUrl={shareUrl} />}
    />,
  );

  const url = screen.getByLabelText(/Activity YAML URL/);
  expect((url.element() as HTMLInputElement).readOnly).toBe(true);
  expect(inputValue(url)).toBe(FILE_URL);

  expect(inputValue(screen.getByLabelText(/Note/))).toBe("3AHIF exercise");
  expect(inputValue(screen.getByLabelText(/Available from/))).toBe(
    unixSecondsToDatetimeLocal(datetimeLocalToUnixSeconds(START)),
  );

  const link = screen.getByLabelText("Share link", { exact: true });
  await expect.element(link).toBeVisible();
  expect(inputValue(link)).toBe(shareUrl);
});

test("edit: Save submits the window + note to the bound code and shows 'Saved'", async () => {
  updated.length = 0;
  updateResult = { status: "saved" };
  const screen = await render(
    <CodeForm
      mode="edit"
      code="a1b2c3d4e5"
      initialModule="tutor"
      initialFileUrl={FILE_URL}
      initialNote="old"
      initialStartSeconds={datetimeLocalToUnixSeconds(START)}
      initialEndSeconds={datetimeLocalToUnixSeconds(END)}
    />,
  );

  await screen.getByLabelText(/Note/).fill("new note");
  await screen.getByRole("button", { name: "Save changes" }).click();

  await expect.element(screen.getByText("Saved")).toBeVisible();
  expect(updated).toHaveLength(1);
  const captured = updated[0];
  if (!captured) throw new Error("no update captured");
  expect(captured.code).toBe("a1b2c3d4e5");
  expect(captured.formData.get("note")).toBe("new note");
  expect(captured.formData.get("startTs")).toBe(String(datetimeLocalToUnixSeconds(START)));
});

test("edit: renders the server action's error message", async () => {
  updateResult = { status: "error", message: "This code no longer exists. Reload the list." };
  const screen = await render(
    <CodeForm
      mode="edit"
      code="a1b2c3d4e5"
      initialModule="tutor"
      initialFileUrl={FILE_URL}
      initialNote="x"
      initialStartSeconds={datetimeLocalToUnixSeconds(START)}
      initialEndSeconds={datetimeLocalToUnixSeconds(END)}
    />,
  );

  await screen.getByRole("button", { name: "Save changes" }).click();
  await expect.element(screen.getByText(/no longer exists/i)).toBeVisible();
});

// The LLM override's quick picks: a dropdown + Apply that fills the free-text
// pair and the reasoning select, which stay editable (docs/codes.md).
test("override: choosing a quick pick fills nothing until Apply, which fills all three fields", async () => {
  const screen = await render(<CodeForm mode="create" />);
  const provider = screen.getByLabelText(/LLM provider override/);
  const model = screen.getByLabelText(/LLM model override/);
  const reasoning = screen.getByLabelText(/Reasoning/);
  const apply = screen.getByRole("button", { name: "Apply" });

  await expect.element(apply).toBeDisabled();

  await screen.getByLabelText("LLM quick pick").selectOptions("OpenRouter · GPT-6 Luna (medium)");
  expect(inputValue(provider)).toBe("");
  expect(inputValue(model)).toBe("");
  expect(inputValue(reasoning)).toBe("");

  await apply.click();
  expect(inputValue(provider)).toBe("OpenRouter");
  expect(inputValue(model)).toBe("openai/gpt-6-luna");
  expect(inputValue(reasoning)).toBe("medium");

  // The fields stay free text after Apply.
  await model.fill("openai/gpt-6.1-sol");
  expect(inputValue(model)).toBe("openai/gpt-6.1-sol");
});

test("override: an SCCH quick pick resets reasoning to Provider default; Clear empties all three", async () => {
  created.length = 0;
  const screen = await render(<CodeForm mode="create" />);
  const quickPick = screen.getByLabelText("LLM quick pick");
  const apply = screen.getByRole("button", { name: "Apply" });
  const reasoning = screen.getByLabelText(/Reasoning/);

  await quickPick.selectOptions("OpenRouter · GPT-5.6 Terra (medium)");
  await apply.click();
  expect(inputValue(reasoning)).toBe("medium");

  await quickPick.selectOptions("SCCH · Gemma 4");
  await apply.click();
  expect(inputValue(screen.getByLabelText(/LLM provider override/))).toBe("SCCH");
  expect(inputValue(screen.getByLabelText(/LLM model override/))).toBe(
    "RedHatAI/gemma-4-31B-it-FP8-Dynamic",
  );
  expect(inputValue(reasoning)).toBe("");

  // The quick pick itself is never submitted — only the override fields are.
  await screen.getByLabelText("Activity YAML URL").fill(FILE_URL);
  await screen.getByRole("button", { name: "Create code" }).click();
  await vi.waitFor(() => expect(created).toHaveLength(1));
  const formData = created[0];
  if (!formData) throw new Error("no FormData captured");
  expect(formData.get("llmProvider")).toBe("SCCH");
  expect(formData.get("llmModel")).toBe("RedHatAI/gemma-4-31B-it-FP8-Dynamic");
  expect(formData.get("llmReasoning")).toBe("");
  expect([...formData.values()]).not.toContain("SCCH · Gemma 4");

  await screen.getByRole("button", { name: "Clear LLM override" }).click();
  expect(inputValue(screen.getByLabelText(/LLM provider override/))).toBe("");
  expect(inputValue(screen.getByLabelText(/LLM model override/))).toBe("");
  expect(inputValue(reasoning)).toBe("");
});
