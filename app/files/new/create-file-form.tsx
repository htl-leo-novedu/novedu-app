"use client";

import { type FormEvent, useRef, useState, useTransition } from "react";
import { BackLink } from "@/components/back-link";
import { PageBody } from "@/components/page-main";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldHint, FieldLabel, FieldSuccess } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ErrorList, WarningList } from "@/components/validation-result";
import { SAVE_KEYSHORTCUTS, useSaveShortcut, useShortcutHint } from "@/lib/keyboard-shortcuts";
import {
  createFileAction,
  type ValidationError,
  type ValidationWarning,
  validateNewFileAction,
} from "@/lib/yaml-files";
import { YamlEditor } from "../yaml-editor";

// Create form: name + kind + the CodeMirror editor (with an upload button). Name,
// kind, and content are controlled state — and the form submits via `onSubmit`
// (not a React form `action`), so a rejected save keeps everything the teacher
// entered instead of being wiped by React's post-action form reset.
//
// Two actions share the form: a standalone "Validate" checks the YAML WITHOUT
// storing (so teachers stop saving throwaway versions just to validate), and
// "Validate & create" validates again server-side and stores. Any edit clears the
// validate feedback so a stale "passed" note never lingers. On a successful create
// the action redirects to the edit page; failures show a short message or the full
// structured validator errors.
export function CreateFileForm() {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("tutor");
  const [content, setContent] = useState("");
  const [validating, startValidate] = useTransition();
  const [saving, startSave] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationError[] | null>(null);
  const [warnings, setWarnings] = useState<ValidationWarning[] | null>(null);
  const [passed, setPassed] = useState(false);
  const pending = validating || saving;
  const formRef = useRef<HTMLFormElement>(null);

  // Ctrl/⌘+S = "Validate & create", from anywhere on the page. `requestSubmit`
  // runs the form's own constraint checks and `onSubmit`, exactly like the button.
  useSaveShortcut(() => {
    if (!pending) formRef.current?.requestSubmit();
  });
  const saveHint = useShortcutHint("save");

  // Clear every validation outcome — called when starting an action and whenever
  // the buffer changes (so the result always reflects the CURRENT content).
  function resetFeedback() {
    setMessage(null);
    setErrors(null);
    setWarnings(null);
    setPassed(false);
  }

  function onValidate() {
    resetFeedback();
    startValidate(async () => {
      const result = await validateNewFileAction({ name, kind, content });
      if (result.ok) {
        setPassed(true);
        setWarnings(result.warnings);
      } else if ("errors" in result) {
        setErrors(result.errors);
      } else {
        setMessage(result.message);
      }
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetFeedback();
    startSave(async () => {
      const result = await createFileAction({ name, kind, content });
      // A successful create redirects (the action calls redirect()); only a
      // failure returns here.
      if ("errors" in result) setErrors(result.errors);
      else setMessage(result.message);
    });
  }

  return (
    <PageBody>
      <BackLink href="/files">Back to files</BackLink>
      <FieldHint>
        Create a hosted YAML file. Use <strong>Validate</strong> to check it without saving;{" "}
        <strong>Validate &amp; create</strong> stores it — an invalid tutor or fragment is rejected.
      </FieldHint>

      <form
        ref={formRef}
        className="flex min-h-0 flex-1 flex-col items-stretch gap-3.5"
        onSubmit={onSubmit}
      >
        <div className="flex flex-wrap items-end gap-3.5">
          <Field className="grow basis-72">
            <FieldLabel htmlFor="file-name">
              Name (letters, digits, underscore, hyphen — no spaces)
            </FieldLabel>
            <Input
              id="file-name"
              required
              maxLength={100}
              pattern="[A-Za-z0-9_-]+"
              autoComplete="off"
              className="font-mono"
              placeholder="e.g. linked-lists-tutor"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                resetFeedback();
              }}
              disabled={pending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="file-kind">Kind</FieldLabel>
            <Select
              id="file-kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
                resetFeedback();
              }}
              disabled={pending}
            >
              <option value="tutor">Tutor</option>
              <option value="fragment">Fragment</option>
              <option value="quiz">Quiz</option>
              <option value="writing">Writing</option>
              <option value="coding">Coding</option>
            </Select>
          </Field>
        </div>

        <YamlEditor
          value={content}
          onChange={(value) => {
            setContent(value);
            resetFeedback();
          }}
          disabled={pending}
          fill
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={onValidate} disabled={pending}>
            {validating ? "Validating…" : "Validate"}
          </Button>
          <Button
            type="submit"
            title={`Validate & create (${saveHint})`}
            aria-keyshortcuts={SAVE_KEYSHORTCUTS}
            disabled={pending}
          >
            {saving ? "Creating…" : "Validate & create"}
          </Button>
          {message ? <FieldError>{message}</FieldError> : null}
          {passed && !message && !errors ? <FieldSuccess>Validation passed</FieldSuccess> : null}
        </div>

        {errors ? <ErrorList errors={errors} /> : null}
        {passed && warnings && warnings.length > 0 ? <WarningList warnings={warnings} /> : null}
      </form>
    </PageBody>
  );
}
