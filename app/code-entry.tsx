"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { extractCode } from "@/lib/code-input";

// The start page's code entry form (app/_home/continue-section.tsx). Submitting
// navigates to `/<code>`, where the server checks the code — this component
// validates only the FORMAT (instant feedback for typos), never the code's
// existence.
export function CodeEntryForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [formatError, setFormatError] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const code = extractCode(value);
    if (!code) {
      setFormatError(true);
      return;
    }
    router.push(`/${code}`);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          className="min-w-0 flex-1 font-mono tracking-wider placeholder:tracking-normal"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setFormatError(false);
          }}
          placeholder="Code or link"
          aria-label="Code"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <Button type="submit">Open</Button>
      </form>
      {formatError ? (
        <FieldError>
          A code is up to 32 letters/digits/hyphens — check for typos, or paste the full link.
        </FieldError>
      ) : null}
    </div>
  );
}
