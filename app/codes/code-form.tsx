"use client";

import { type ReactNode, useActionState, useCallback, useEffect, useRef, useState } from "react";
import { BackLink } from "@/components/back-link";
import { PageBody } from "@/components/page-main";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel, FieldSuccess } from "@/components/ui/field";
import { Input, inputVariants, Select } from "@/components/ui/input";
import { ErrorList } from "@/components/validation-result";
import type { ActivityLlm } from "@/lib/activity-load";
import {
  type CodeFormState,
  createCodeAction,
  readActivityLlmAction,
  updateCodeAction,
} from "@/lib/code-actions";
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
import { cn } from "@/lib/utils";

const INITIAL_STATE: CodeFormState = { status: "idle" };

// The form is three groups (the activity, its LLM, the availability window), the
// later two set off by a hairline. Inside a group, fields in a row grow side by side
// and wrap on narrow screens: a wide field takes nearly all the spare room, a narrow
// one (Activity, Reasoning) little of it, but its whole line once the row wraps.
const FORM_GROUP = "flex flex-col gap-3.5 self-stretch";
const GROUP_DIVIDER = "border-foreground/15 border-t pt-5";
const FIELD_ROW = "flex flex-wrap gap-3.5 self-stretch";
const ROW_FIELD_CLASSES = "grow-9 basis-72";
const NARROW_ROW_FIELD_CLASSES = "grow basis-52";
// A date input with its helper buttons; on a phone the buttons wrap under the input
// rather than pushing the row past the screen edge.
const INPUT_ROW = "flex flex-wrap items-center gap-1.5";
// What the teacher can see but not change here: the activity and YAML URL in edit
// mode (frozen), and the YAML's own LLM.
const READONLY_INPUT = "bg-foreground/5 font-mono text-foreground/70";

/** The "Activity's LLM" field: the YAML's own `llm:` block, as far as it has been read. */
type YamlLlm =
  | { status: "none" }
  | { status: "reading" }
  | { status: "read"; llm: ActivityLlm }
  | { status: "failed" };

// A status message is prose (sans); the read LLM keeps the read-only mono.
const YAML_LLM_TONE: Record<YamlLlm["status"], string> = {
  none: "font-sans text-foreground/55",
  reading: "font-sans text-foreground/55",
  failed: "font-sans text-warning",
  read: "",
};

// Read-only, at the head of the LLM group, so the teacher sees what an override
// would replace without opening the file. One generic warning for every failure —
// creating a code validates the file and reports the details. The field is ALWAYS
// rendered, one input tall with its text cut to one line (the whole text in its
// tooltip): leaving the URL field by pressing "Create code" starts a read, and a
// field that grew on that mousedown would push the button away from the mouseup,
// swallowing the click.
function ActivityLlmField({ state, isEdit }: { state: YamlLlm; isEdit: boolean }) {
  const text = activityLlmText(state, isEdit);
  return (
    <Field>
      <FieldLabel htmlFor="code-yaml-llm">Activity&apos;s LLM (from the YAML)</FieldLabel>
      <output
        id="code-yaml-llm"
        htmlFor="code-url"
        title={text}
        className={cn(
          inputVariants(),
          READONLY_INPUT,
          "flex items-center",
          YAML_LLM_TONE[state.status],
        )}
      >
        <span className="truncate">{text}</span>
      </output>
    </Field>
  );
}

function activityLlmText(state: YamlLlm, isEdit: boolean): string {
  switch (state.status) {
    case "none":
      return "Enter the Activity YAML URL to see it.";
    case "reading":
      return "Reading the model from the YAML…";
    case "failed":
      return isEdit
        ? "Couldn't read the model from this YAML file."
        : "Couldn't read the model from this YAML file. Creating the code checks the file and shows what's wrong.";
    case "read": {
      const { provider, model, reasoning } = state.llm;
      return `${provider} · ${model} · ${reasoning ?? "provider default"}`;
    }
  }
}

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
// (shown read-only), so there is no YAML re-validation. Both modes READ the YAML's
// `llm:` block for display only (the "Activity's LLM" field above the override).
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
  // changes nothing until Apply; Apply and Clear reset it, so the dropdown never
  // claims a pick the fields no longer hold.
  const [quickPick, setQuickPick] = useState("");
  const chosenPreset = LLM_OVERRIDE_PRESETS.find((preset) => preset.label === quickPick);

  // The activity YAML's own LLM: read when the form opens with a URL (edit, or the
  // YAML Files "Create code" link), then whenever the URL field is left holding a
  // URL other than the last one read. Only the newest read may settle the line, so
  // a slow answer for an earlier URL never shows next to a later one.
  const [yamlLlm, setYamlLlm] = useState<YamlLlm>({ status: "none" });
  const lastReadUrl = useRef<string | null>(null);
  const latestRead = useRef(0);
  const readYamlLlm = useCallback((value: string) => {
    const url = value.trim();
    if (url === lastReadUrl.current) return;
    lastReadUrl.current = url;
    const read = ++latestRead.current;
    if (url === "") {
      setYamlLlm({ status: "none" });
      return;
    }
    setYamlLlm({ status: "reading" });
    const settle = (llm: ActivityLlm | null) => {
      if (read === latestRead.current) {
        setYamlLlm(llm ? { status: "read", llm } : { status: "failed" });
      }
    };
    readActivityLlmAction(url).then(settle, () => settle(null));
  }, []);
  useEffect(() => {
    readYamlLlm(initialFileUrl);
  }, [initialFileUrl, readYamlLlm]);

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

      <form className="flex shrink-0 flex-col items-start gap-5" action={formAction}>
        <div className={FORM_GROUP}>
          <div className={FIELD_ROW}>
            <Field className={NARROW_ROW_FIELD_CLASSES}>
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

            <Field className={ROW_FIELD_CLASSES}>
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
                  onBlur={(event) => readYamlLlm(event.currentTarget.value)}
                  disabled={pending}
                />
              )}
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="code-note">
              Note (optional — shown in the list of codes)
            </FieldLabel>
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
        </div>

        {/* The LLM: the activity YAML's own (read-only), then the optional per-code
            override that replaces its provider/model (and reasoning level) for this
            code only. Both-or-nothing — the server action rejects a half-filled
            pair, and a level without the pair. Editable in BOTH modes (not frozen
            like the module/file URL). */}
        <div className={cn(FORM_GROUP, GROUP_DIVIDER)}>
          <ActivityLlmField state={yamlLlm} isEdit={isEdit} />
          <div className="flex flex-col gap-1.5">
            <div className={FIELD_ROW}>
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
              <Field className={NARROW_ROW_FIELD_CLASSES}>
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
                size="sm"
                onClick={() => {
                  if (!chosenPreset) return;
                  setLlmProvider(chosenPreset.provider);
                  setLlmModel(chosenPreset.model);
                  // A quick pick fills the WHOLE override — one without a level
                  // clears one the teacher had picked.
                  setLlmReasoning(chosenPreset.reasoning ?? "");
                  setQuickPick("");
                }}
                disabled={pending || !chosenPreset}
                title="Fill the override fields with the chosen quick pick"
                aria-label="Apply LLM quick pick"
              >
                Apply
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLlmProvider("");
                  setLlmModel("");
                  setLlmReasoning("");
                  setQuickPick("");
                }}
                disabled={pending || (!llmProvider && !llmModel && !llmReasoning)}
                title="Use the activity's LLM settings"
                aria-label="Clear LLM override"
              >
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div className={cn(FIELD_ROW, GROUP_DIVIDER)}>
          <Field className={ROW_FIELD_CLASSES}>
            <FieldLabel htmlFor="code-start">
              Available from (your local time — leave blank for no start)
            </FieldLabel>
            <div className={INPUT_ROW}>
              <Input
                id="code-start"
                type="datetime-local"
                name="start"
                className="min-w-48 flex-1 font-mono"
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
                className="min-w-48 flex-1 font-mono"
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
              {/* The three steps wrap as one unit. */}
              <div className="flex gap-1.5">
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
