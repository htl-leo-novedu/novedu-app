"use client";

import { type ReactNode, useActionState, useState } from "react";
import { BackLink } from "@/components/back-link";
import { PageBody } from "@/components/page-main";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel, FieldSuccess } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { ErrorList } from "@/components/validation-result";
import { type CodeFormState, createCodeAction, updateCodeAction } from "@/lib/code-actions";
import { CODE_MODULES, type CodeModule, codeModuleLabels } from "@/lib/code-modules/types";
import {
  addToDatetimeLocal,
  type DatetimeLocalUnit,
  datetimeLocalToUnixSeconds,
  nowAsDatetimeLocal,
  unixSecondsToDatetimeLocal,
} from "@/lib/datetime-local";
import { LLM_OVERRIDE_PRESETS } from "@/lib/llm/presets";
import { REASONING_LEVELS } from "@/lib/llm/provider";

const INITIAL_STATE: CodeFormState = { status: "idle" };

// Fields inside the window row grow side by side; top-level fields only stretch
// (the form's main axis is vertical, so growing would stretch an input to the
// page height).
const ROW_FIELD_CLASSES = "grow basis-72 self-stretch";
const INPUT_ROW = "flex items-center gap-1.5";
// The tutor URL / activity shown read-only in edit mode (cannot be changed).
const READONLY_INPUT = "bg-foreground/5 font-mono text-foreground/70";

export interface CodeFormProps {
  mode: "create" | "edit";
  /** Create: preselects the activity. Edit: the row's module (shown read-only). */
  initialModule?: CodeModule;
  /** Editable in create mode; shown read-only (never submitted) in edit mode. */
  initialFileUrl?: string;
  initialNote?: string;
  initialStartSeconds?: number;
  initialEndSeconds?: number;
  /** The stored LLM override pair (edit mode); both empty = no override. */
  initialLlmProvider?: string;
  initialLlmModel?: string;
  /** The pair's optional reasoning level (edit mode); empty = the provider's default. */
  initialLlmReasoning?: string;
  /** Edit mode only: the code being edited. */
  code?: string;
  /**
   * Edit mode only: the module's result body (server-rendered), shown above the form —
   * tutor/quiz/writing render the share link, coding its little-coder connection config.
   */
  resultSlot?: ReactNode;
}

// One form for BOTH creating and editing a code. Validation + storage live in the
// server actions; this only converts the datetime-local values (local wall-clock)
// to unix seconds — a conversion that MUST happen in the browser, the only place
// the teacher's timezone is known. Create picks the activity (`module`) + file and
// redirects to the new code's edit page on success (which shows the module's result
// body — `resultSlot`). Edit changes the note/window only — the module + file URL are frozen
// (shown read-only), so there is no YAML re-validation.
export function CodeForm({
  mode,
  initialModule = "tutor",
  initialFileUrl = "",
  initialNote = "",
  initialStartSeconds,
  initialEndSeconds,
  initialLlmProvider = "",
  initialLlmModel = "",
  initialLlmReasoning = "",
  code,
  resultSlot,
}: CodeFormProps) {
  const isEdit = mode === "edit";
  const action: (state: CodeFormState, formData: FormData) => Promise<CodeFormState> = isEdit
    ? updateCodeAction.bind(null, code ?? "")
    : createCodeAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [start, setStart] = useState(
    initialStartSeconds ? unixSecondsToDatetimeLocal(initialStartSeconds) : "",
  );
  const [end, setEnd] = useState(
    initialEndSeconds ? unixSecondsToDatetimeLocal(initialEndSeconds) : "",
  );
  // The LLM override pair — controlled so a quick pick can fill/clear both
  // fields at once. Free text; the server action validates the provider.
  const [llmProvider, setLlmProvider] = useState(initialLlmProvider);
  const [llmModel, setLlmModel] = useState(initialLlmModel);
  // The pair's optional reasoning level — controlled for the same reason (a
  // quick pick fills or clears it along with the pair). "" means "provider
  // default" (the parameter is then not sent at all).
  const [llmReasoning, setLlmReasoning] = useState(initialLlmReasoning);
  // The quick pick chosen in the dropdown (its label; "" = none). Choosing one
  // changes nothing until Apply.
  const [quickPick, setQuickPick] = useState("");
  const chosenPreset = LLM_OVERRIDE_PRESETS.find((preset) => preset.label === quickPick);

  // "+1h"/"+1d"/"+1w": extend the until time if set; otherwise start the window
  // length from the from time (or from now as a last resort).
  function extendEnd(amount: number, unit: DatetimeLocalUnit) {
    const base = end || start || nowAsDatetimeLocal();
    setEnd(addToDatetimeLocal(base, amount, unit));
  }

  return (
    <PageBody className="pb-5">
      <BackLink href="/codes">Back to codes</BackLink>

      {isEdit ? resultSlot : null}

      <form className="flex shrink-0 flex-col items-start gap-3.5" action={formAction}>
        <Field className="self-stretch">
          <FieldLabel htmlFor="code-module">Activity</FieldLabel>
          {isEdit ? (
            <Input
              id="code-module"
              type="text"
              className={READONLY_INPUT}
              readOnly
              value={codeModuleLabels[initialModule].badge}
              aria-label="Activity (read-only)"
              title="The activity cannot be changed — create a new code for a different activity."
            />
          ) : (
            <Select
              id="code-module"
              name="module"
              defaultValue={initialModule}
              className="font-mono"
              disabled={pending}
            >
              {CODE_MODULES.map((m) => (
                <option key={m} value={m}>
                  {codeModuleLabels[m].badge}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field className="self-stretch">
          <FieldLabel htmlFor="code-url">Activity YAML URL</FieldLabel>
          {isEdit ? (
            <Input
              id="code-url"
              type="url"
              className={READONLY_INPUT}
              readOnly
              value={initialFileUrl}
              aria-label="Activity YAML URL (read-only)"
              title="The file URL cannot be changed — create a new code to share a different file."
            />
          ) : (
            <Input
              id="code-url"
              type="url"
              name="file"
              required
              autoComplete="on"
              defaultValue={initialFileUrl}
              className="font-mono"
              placeholder="https://example.com/path/to/activity.yaml"
              disabled={pending}
            />
          )}
        </Field>

        <Field className="self-stretch">
          <FieldLabel htmlFor="code-note">Note (optional — shown in the list of codes)</FieldLabel>
          <Input
            id="code-note"
            type="text"
            name="note"
            maxLength={200}
            autoComplete="on"
            defaultValue={initialNote}
            className="font-mono"
            placeholder="e.g. 3AHIF linked lists exercise"
            disabled={pending}
          />
        </Field>

        {/* Optional per-code LLM override: replaces the activity YAML's llm
            provider/model (and reasoning level) for this code only.
            Both-or-nothing — the server action rejects a half-filled pair, and
            a level without the pair. Editable in BOTH modes (not frozen like
            the module/file URL). */}
        <div className="flex flex-col gap-1.5 self-stretch">
          <div className="flex flex-wrap gap-3.5 self-stretch">
            <Field className={ROW_FIELD_CLASSES}>
              <FieldLabel htmlFor="code-llm-provider">
                LLM provider override (optional — leave blank to use the activity&apos;s LLM)
              </FieldLabel>
              <Input
                id="code-llm-provider"
                type="text"
                name="llmProvider"
                className="font-mono"
                value={llmProvider}
                onChange={(event) => setLlmProvider(event.target.value)}
                placeholder="SCCH, Azure Foundry or OpenRouter"
                disabled={pending}
              />
            </Field>
            <Field className={ROW_FIELD_CLASSES}>
              <FieldLabel htmlFor="code-llm-model">
                LLM model override (required with a provider override)
              </FieldLabel>
              <Input
                id="code-llm-model"
                type="text"
                name="llmModel"
                maxLength={256}
                className="font-mono"
                value={llmModel}
                onChange={(event) => setLlmModel(event.target.value)}
                placeholder="e.g. openai/gpt-6-luna"
                disabled={pending}
              />
            </Field>
            <Field className="grow-0 basis-52 self-stretch">
              <FieldLabel htmlFor="code-llm-reasoning">Reasoning (optional)</FieldLabel>
              <Select
                id="code-llm-reasoning"
                name="llmReasoning"
                className="font-mono"
                value={llmReasoning}
                onChange={(event) => setLlmReasoning(event.target.value)}
                disabled={pending}
              >
                <option value="">Provider default</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {/* Quick picks: a convenience, never an allowlist. The select has no
              `name`, so it is never submitted — only the fields above are. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              aria-label="LLM quick pick"
              className="w-80 max-w-full font-mono"
              value={quickPick}
              onChange={(event) => setQuickPick(event.target.value)}
              disabled={pending}
            >
              <option value="">Quick pick…</option>
              {LLM_OVERRIDE_PRESETS.map((preset) => (
                <option key={preset.label} value={preset.label}>
                  {preset.label}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              onClick={() => {
                if (!chosenPreset) return;
                setLlmProvider(chosenPreset.provider);
                setLlmModel(chosenPreset.model);
                // A quick pick fills the WHOLE override — one without a level
                // clears one the teacher had picked.
                setLlmReasoning(chosenPreset.reasoning ?? "");
              }}
              disabled={pending || !chosenPreset}
              title="Fill the override fields with the chosen quick pick"
            >
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setLlmProvider("");
                setLlmModel("");
                setLlmReasoning("");
              }}
              disabled={pending || (!llmProvider && !llmModel && !llmReasoning)}
              title="Use the activity's LLM settings"
              aria-label="Clear LLM override"
            >
              Clear
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-3.5 self-stretch">
          <Field className={ROW_FIELD_CLASSES}>
            <FieldLabel htmlFor="code-start">
              Available from (your local time — leave blank for no start)
            </FieldLabel>
            <div className={INPUT_ROW}>
              <Input
                id="code-start"
                type="datetime-local"
                name="start"
                className="min-w-0 flex-1 font-mono"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                disabled={pending}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStart("")}
                disabled={pending || !start}
                title="No start"
                aria-label="Clear start"
              >
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStart(nowAsDatetimeLocal())}
                disabled={pending}
              >
                Now
              </Button>
            </div>
          </Field>
          <Field className={ROW_FIELD_CLASSES}>
            <FieldLabel htmlFor="code-end">
              Available until (your local time — leave blank for no end)
            </FieldLabel>
            <div className={INPUT_ROW}>
              <Input
                id="code-end"
                type="datetime-local"
                name="end"
                className="min-w-0 flex-1 font-mono"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                disabled={pending}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEnd("")}
                disabled={pending || !end}
                title="No end"
                aria-label="Clear end"
              >
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendEnd(1, "hours")}
                disabled={pending}
              >
                +1h
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendEnd(1, "days")}
                disabled={pending}
              >
                +1d
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendEnd(1, "weeks")}
                disabled={pending}
              >
                +1w
              </Button>
            </div>
          </Field>
        </div>

        {/* What the server stores: the window as unix seconds (UTC). */}
        <input
          type="hidden"
          name="startTs"
          value={start ? datetimeLocalToUnixSeconds(start) : ""}
        />
        <input type="hidden" name="endTs" value={end ? datetimeLocalToUnixSeconds(end) : ""} />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save changes" : "Create code"}
          </Button>
          {isEdit && state.status === "saved" ? <FieldSuccess>Saved</FieldSuccess> : null}
        </div>
      </form>

      <div className="flex shrink-0 flex-col gap-4">
        {state.status === "error" && "message" in state ? (
          <FieldError>{state.message}</FieldError>
        ) : null}
        {state.status === "error" && "errors" in state ? <ErrorList errors={state.errors} /> : null}
      </div>
    </PageBody>
  );
}
