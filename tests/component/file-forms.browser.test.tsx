import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

// The create/edit forms have a standalone "Validate" button that checks the
// YAML WITHOUT saving. These specs pin that wiring: Validate renders the
// validator's result (errors / passed note + warnings) and NEVER calls the
// create/update action, and editing the buffer clears a stale "passed" note. The
// server actions, router and CodeMirror editor are mocked — this is pure client
// behaviour.
const actions = vi.hoisted(() => ({
  validateNewFileAction: vi.fn(),
  createFileAction: vi.fn(),
  validateExistingFileAction: vi.fn(),
  updateFileAction: vi.fn(),
}));

vi.mock("@/lib/files-actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("next/link", () => import("@/tests/mocks/next-link"));
// A plain textarea stands in for the CodeMirror editor so the test is fast and can
// drive content with a normal control.
vi.mock("@/app/files/yaml-editor", () => ({
  YamlEditor: ({
    value,
    onChange,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
  }) => (
    <textarea
      aria-label="YAML content"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { EditFileForm } from "@/app/files/edit/[...name]/edit-file-form";
import { CreateFileForm } from "@/app/files/new/create-file-form";

const SCHEMA_ERROR = {
  ok: false,
  errors: [{ code: "FRAGMENT_FILE_SCHEMA_ERROR", message: "bad" }],
};

test("create: Validate surfaces the validator's errors and does NOT create", async () => {
  actions.validateNewFileAction.mockResolvedValue(SCHEMA_ERROR);
  const screen = await render(<CreateFileForm />);

  await screen.getByRole("button", { name: "Validate", exact: true }).click();

  await expect.element(screen.getByText("FRAGMENT_FILE_SCHEMA_ERROR")).toBeVisible();
  expect(actions.createFileAction).not.toHaveBeenCalled();
});

test("create: a passing Validate shows the passed note and any warnings, no create", async () => {
  actions.validateNewFileAction.mockResolvedValue({
    ok: true,
    warnings: [{ code: "UNDECLARED_VARIABLE", message: "heads up" }],
  });
  const screen = await render(<CreateFileForm />);

  await screen.getByRole("button", { name: "Validate", exact: true }).click();

  await expect.element(screen.getByText("Validation passed")).toBeVisible();
  await expect.element(screen.getByText("UNDECLARED_VARIABLE")).toBeVisible();
  expect(actions.createFileAction).not.toHaveBeenCalled();
});

test("create: editing the buffer clears a stale 'passed' note", async () => {
  actions.validateNewFileAction.mockResolvedValue({ ok: true, warnings: [] });
  const screen = await render(<CreateFileForm />);

  await screen.getByRole("button", { name: "Validate", exact: true }).click();
  await expect.element(screen.getByText("Validation passed")).toBeVisible();

  await screen.getByLabelText("YAML content").fill("id: changed\n");
  await expect.poll(() => screen.getByText("Validation passed").query()).toBeNull();
});

test("edit: Validate surfaces errors and does NOT save", async () => {
  actions.validateExistingFileAction.mockResolvedValue(SCHEMA_ERROR);
  const screen = await render(
    <EditFileForm
      name="my-file"
      kind="fragment"
      initialContent="id: f"
      publicUrl="https://app.example/api/files/my-file"
    />,
  );

  await screen.getByRole("button", { name: "Validate", exact: true }).click();

  await expect.element(screen.getByText("FRAGMENT_FILE_SCHEMA_ERROR")).toBeVisible();
  expect(actions.updateFileAction).not.toHaveBeenCalled();
});
