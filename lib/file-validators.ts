import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import { loadAndCheckCoding } from "@/lib/coding-validate";
import type { FileKind } from "@/lib/file-name";
import { providerUnavailableReason } from "@/lib/llm/availability";
import type { LlmProvider } from "@/lib/llm/provider";
import {
  type Fetcher,
  loadAndCheckFragmentFile,
  type ValidationError,
  type ValidationWarning,
} from "@/lib/prompt-fragments";
import { loadQuiz } from "@/lib/quiz-fetch";
import { loadAndCheckQuiz } from "@/lib/quiz-validate";
import { loadAndBuildTutorPrompt } from "@/lib/tutors";
import { loadWriting } from "@/lib/writing-fetch";
import { loadAndCheckWriting } from "@/lib/writing-validate";

// Layer 2 of the codes architecture: the validator seam, keyed by `FileKind`.
// This is the SINGLE source of truth for "is this YAML valid, and what metadata
// does it carry," consumed by THREE call sites with different fetchers:
//   - the /files save + standalone Validate button (fetcher resolves the editor
//     buffer + app-hosted siblings — see lib/files-actions.ts),
//   - the code-create flow (fetcher = app-hosted/default; url = the row's file_url),
//   - (the @novedu/cli mirrors the same lib/tutors checks directly).
//
// A module (Layer 3) NEVER redefines validation — it references a `fileKind` and
// reuses that kind's validator. `fragment` lives here with a real validator and
// NO module (the canonical "validator without a module"); a future pure-library
// kind likewise adds only a validator entry.
//
// SERVER-ONLY: pulls in the tutor/quiz loaders. Never import from client components.

export type FileValidationResult =
  | {
      ok: true;
      warnings: ValidationWarning[];
      /** Denormalized title for the search columns (tutor only; null otherwise). */
      title: string | null;
      /** Denormalized description (tutor only; null otherwise). */
      description: string | null;
      /** The activity YAML's privacy flag — code-create freezes this onto the row. */
      anonymous: boolean;
    }
  | { ok: false; errors: ValidationError[] };

export interface FileValidator {
  validate(url: string, fetcher: Fetcher): Promise<FileValidationResult>;
}

// APP-ONLY availability gate on top of the (CLI-shared, env-free) loadAndCheck*
// core: a structurally valid YAML naming a provider THIS server cannot serve
// (e.g. `Azure Foundry` without AZURE_FOUNDRY_ENDPOINT) must fail at save/create
// time, not mid-chat. `null` means the provider is usable.
function providerGate(provider: LlmProvider): FileValidationResult | null {
  const reason = providerUnavailableReason(provider);
  return reason ? { ok: false, errors: [{ code: "PROVIDER_UNAVAILABLE", message: reason }] } : null;
}

// An activity kind's validator: its strict authoring check (tutor, quiz, writing,
// coding — CLI-shared and env-free), then the app-only provider gate, then the metadata
// code-create freezes onto the row. Kinds without a field fall back alike: no
// denormalized title/description ⇒ null; no `anonymous` field ⇒ the privacy-safe `true`.
function activityValidator(
  check: (
    url: string,
    fetcher: Fetcher,
  ) => Promise<
    | {
        ok: true;
        provider: LlmProvider;
        warnings: ValidationWarning[];
        title?: string | null;
        description?: string;
        anonymous?: boolean;
      }
    | { ok: false; errors: ValidationError[] }
  >,
): FileValidator {
  return {
    async validate(url, fetcher) {
      const result = await check(url, fetcher);
      if (!result.ok) return { ok: false, errors: result.errors };
      const gated = providerGate(result.provider);
      if (gated) return gated;
      return {
        ok: true,
        warnings: result.warnings,
        title: result.title ?? null,
        description: result.description ?? null,
        anonymous: result.anonymous ?? true,
      };
    },
  };
}

// fragment: a pure library kind — a real validator, NO module. Carries no
// title/description/anonymous (privacy-safe `true` default is never read: a
// fragment is never a code).
const fragmentValidator: FileValidator = {
  async validate(url, fetcher) {
    const result = await loadAndCheckFragmentFile(url, fetcher);
    if (!result.ok) return { ok: false, errors: result.errors };
    return { ok: true, warnings: result.warnings, title: null, description: null, anonymous: true };
  },
};

export const fileValidators: Record<FileKind, FileValidator> = {
  // The THOROUGH tutor gate (every fragment in every referenced library is
  // strict-rendered), matching share/create time and the validate page.
  tutor: activityValidator((url, fetcher) =>
    loadAndBuildTutorPrompt(url, fetcher, { validateLibraries: true }),
  ),
  fragment: fragmentValidator,
  // A structurally broken quiz / writing / coding activity BLOCKS the save; each check
  // defaults to the thorough library validation itself. Writing DEFAULTS
  // `anonymous: false` (the writing divergence) in its own check.
  quiz: activityValidator(loadAndCheckQuiz),
  writing: activityValidator(loadAndCheckWriting),
  // Coding is ALWAYS anonymous (no in-app conversations to attribute): frozen here,
  // whatever the check returns.
  coding: activityValidator(async (url, fetcher) => {
    const result = await loadAndCheckCoding(url, fetcher);
    return result.ok ? { ...result, anonymous: true } : result;
  }),
};

// Runtime-light read of just the activity YAML's `anonymous` flag, keyed by
// FileKind — the attribution path's counterpart to the validators above (no
// library validation, no metadata extraction). `definitive` is false when the
// YAML could not be read or the kind carries no anonymity flag: the caller then
// applies the privacy-safe default (`true`) but does NOT cache it, so a transient
// load failure does not permanently silence attribution. Co-located with the
// validators so each FileKind's privacy semantics live in ONE place. Callers:
// lib/user-chat-store.ts (whether to attribute a chat) and the tutor history gate
// lib/tutor-history-gate.ts (the live half of "Previous conversations"), both
// treating an unreadable YAML as anonymous.
export async function readAnonymousFlag(
  kind: FileKind,
  fileUrl: string,
): Promise<{ anonymous: boolean; definitive: boolean }> {
  try {
    if (kind === "quiz") {
      const loaded = await loadQuiz(fileUrl);
      if (loaded.ok) return { anonymous: loaded.quiz.anonymous, definitive: true };
    } else if (kind === "tutor") {
      const tutor = await loadAndBuildTutorPrompt(fileUrl, await serverYamlFetcher());
      if (tutor.ok) return { anonymous: tutor.anonymous, definitive: true };
    } else if (kind === "writing") {
      // Writing DEFAULTS `anonymous: false` (the writing divergence). When the YAML
      // could not be read we fall through to the privacy-safe `true` default below
      // (non-definitive, so it is not cached); a successful read carries the file's
      // own flag, which `parseWriting` already defaults to `false` when absent.
      const loaded = await loadWriting(fileUrl);
      if (loaded.ok) return { anonymous: loaded.writing.anonymous, definitive: true };
    } else if (kind === "coding") {
      // Coding is ALWAYS anonymous (no in-app conversations to attribute), so
      // this is definitive without reading the YAML.
      return { anonymous: true, definitive: true };
    }
  } catch (error) {
    console.error("file-validators: reading the activity YAML's anonymous flag failed", error);
  }
  return { anonymous: true, definitive: false };
}
