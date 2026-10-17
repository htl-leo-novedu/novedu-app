import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { serverYamlFetcher } from "@/lib/app-hosted-fetcher";
import { providerUnavailableReason } from "@/lib/llm/availability";
import {
  type LlmProvider,
  parseLenientProvider,
  parseLenientReasoningLevel,
  type ReasoningLevel,
} from "@/lib/llm/provider";
import { loadAndBuildTutorPrompt } from "@/lib/tutors";
import { chatMemory } from "./agent-context";
import { modelEntry } from "./model-entry";
import { reasoningStrippingProcessor } from "./reasoning-processor";
import { selectTutorTools } from "./tutor-tools";

// A single agent that is configured entirely by a tutor-definition YAML. The
// tutor's URL arrives per request via `requestContext` (set by the CopilotKit
// route after it verified the tutor code and thread token); this agent resolves its
// system prompt and model from that URL at request time using the reusable
// `lib/tutors` core.

// RequestContext keys the tutor module's buildRequestContext sets
// (lib/code-modules/tutor.ts). The override pair is the code's per-code LLM
// override (docs/ai-models.md): set together or not at all, it replaces the
// tutor YAML's `llm.provider`/`llm.model` below. The reasoning key is the
// pair's OPTIONAL third member — present only when the code's override carries
// a level.
export const TUTOR_URL = "tutor-url";
export const TUTOR_PROVIDER_OVERRIDE = "tutor-provider-override";
export const TUTOR_MODEL_OVERRIDE = "tutor-model-override";
export const TUTOR_REASONING_OVERRIDE = "tutor-reasoning-override";

interface LoadedTutor {
  prompt: string;
  model: string;
  provider: LlmProvider;
  /** Reasoning effort to drive the model at; absent = the model's own default. */
  reasoning?: ReasoningLevel;
  /** The YAML's validated `tools:` opt-in (docs/tutor-tools.md), [] by default. */
  tools: string[];
}

// A built prompt is NEVER cached across requests: the YAML is fetched + assembled
// fresh on every chat request. This keeps edits to a tutor YAML visible immediately
// and is forward-compatible with planned per-user parameters (which make the prompt
// user-specific, so caching it by URL would serve the wrong prompt). The only
// memoization is REQUEST-SCOPED: `instructions` and `model` both resolve per request
// and would each rebuild, so a WeakMap keyed on the per-request `requestContext` (a
// fresh object per chat request — see the CopilotKit route) shares one build between
// them, then lets it be garbage-collected with the request. The chat hot path uses
// DEFAULT load options (no `validateLibraries`); the thorough whole-library check is
// an authoring-time gate (share / validate page / CLI), not chat.
const perRequestBuild = new WeakMap<RequestContext, Promise<LoadedTutor>>();

function loadTutor(requestContext: RequestContext): Promise<LoadedTutor> {
  const inFlight = perRequestBuild.get(requestContext);
  if (inFlight) return inFlight;

  const promise = serverYamlFetcher()
    .then((fetcher) => loadAndBuildTutorPrompt(tutorUrl(requestContext), fetcher))
    .then((result) => {
      if (!result.ok) {
        const first = result.errors[0];
        throw new Error(
          first
            ? `Tutor validation failed (${first.code}): ${first.message}`
            : "Tutor validation failed",
        );
      }
      // The code's LLM override pair (when the runtime route put one on the
      // context) replaces the YAML's llm values wholesale.
      const override = llmOverride(requestContext);
      const provider = override?.provider ?? result.provider;
      const model = override?.model ?? result.model;
      // WHOLESALE: an override replaces the YAML's whole `llm:` block, so a
      // code overriding only the pair also drops the YAML's reasoning level.
      const reasoning = override ? override.reasoning : result.reasoning;
      // The authoring gate blocks saving such a file, but externally hosted YAML
      // (or an env change) can still name a provider this server cannot serve —
      // fail with a clear reason via this loader's established throw channel.
      // Checked on the EFFECTIVE provider, so an override is gated too.
      const unavailable = providerUnavailableReason(provider);
      if (unavailable) throw new Error(unavailable);
      return { prompt: result.prompt, model, provider, reasoning, tools: result.tools };
    });

  perRequestBuild.set(requestContext, promise);
  return promise;
}

function tutorUrl(requestContext: RequestContext): string {
  const url = requestContext.get(TUTOR_URL);
  if (typeof url !== "string" || url === "") {
    throw new Error("No tutor URL provided for this chat. Load a tutor first.");
  }
  return url;
}

// The code's LLM override off the request context; `undefined` when the code
// carries none. The runtime route sets the pair from a typed CodeEntry, so a
// present-but-invalid value is a wiring bug — fail loud rather than silently
// serving the YAML's (or the default) provider against the teacher's intent.
function llmOverride(
  requestContext: RequestContext,
): { provider: LlmProvider; model: string; reasoning?: ReasoningLevel } | undefined {
  const rawProvider = requestContext.get(TUTOR_PROVIDER_OVERRIDE);
  const rawModel = requestContext.get(TUTOR_MODEL_OVERRIDE);
  if (rawProvider === undefined && rawModel === undefined) return undefined;
  const provider = parseLenientProvider(rawProvider);
  if (!provider || typeof rawModel !== "string" || rawModel === "") {
    throw new Error("This code's LLM override is invalid. Ask the teacher to re-save the code.");
  }
  // The reasoning level is optional: an ABSENT key simply means no effort is
  // pinned. A PRESENT one that isn't a known level is the same wiring bug as an
  // invalid pair, so it fails the same way.
  const rawReasoning = requestContext.get(TUTOR_REASONING_OVERRIDE);
  const reasoning =
    rawReasoning === undefined ? undefined : parseLenientReasoningLevel(rawReasoning);
  if (rawReasoning !== undefined && !reasoning) {
    throw new Error("This code's LLM override is invalid. Ask the teacher to re-save the code.");
  }
  return { provider, model: rawModel, ...(reasoning ? { reasoning } : {}) };
}

export const tutorAgent = new Agent({
  id: "tutor",
  name: "Tutor",
  // Both resolvers run per request and share the same request-scoped build. The
  // prompt is used verbatim — no app-level formatting guidance is appended.
  instructions: async ({ requestContext }) => (await loadTutor(requestContext)).prompt,
  model: async ({ requestContext }) => {
    const loaded = await loadTutor(requestContext);
    return modelEntry(loaded.provider, loaded.model, loaded.reasoning);
  },
  // The YAML's opt-in tool selection (top-level `tools:`, docs/tutor-tools.md) —
  // an empty map for the (default) tool-less tutor. The platform never mentions
  // tools in the prompt; authors reference them in `tutor_instructions`.
  tools: async ({ requestContext }) => selectTutorTools((await loadTutor(requestContext)).tools),
  // Persist the conversation so the tutor remembers earlier turns (`chatMemory`,
  // shared with every chat agent). No explicit storage here: Memory inherits the
  // Mastra instance's Postgres store (see `index.ts`), so threads/messages land in the
  // `mastra_*` tables. The thread id is server-generated per page load
  // (app/[code]/page.tsx) and ownership-checked in the CopilotKit route, which also
  // sets the resource id (the tutor code — threads group per code).
  memory: chatMemory(),
  // Reasoning is a live-only artefact: this drops it after the response has
  // streamed and before memory persists the turn (app/mastra/reasoning-processor.ts).
  outputProcessors: [reasoningStrippingProcessor],
});
