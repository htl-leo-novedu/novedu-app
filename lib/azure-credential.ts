import {
  AzureCliCredential,
  ChainedTokenCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from "@azure/identity";

// The ONE way this app authenticates against its data store — the Postgres
// database behind the single shared pool (lib/db/pool.ts), used by Drizzle for
// the novedu_* tables and by the Mastra store alike. It is reached
// passwordless: the token this credential mints is handed to node-postgres as
// the connection password. The DB lives in the `STORAGE_TENANT_ID` tenant.
//
// The chain is built EXPLICITLY rather than using `DefaultAzureCredential`: that
// one would pick up `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` via
// its `EnvironmentCredential` — but this app sets those for *user sign-in*
// (auth.ts) — the sign-in app registration, which has no Postgres role — and
// would authenticate as the wrong service principal. This chain ignores those
// vars.
//
// SERVER-ONLY: handles Azure credentials. Never import from client components.
export function buildDataStoreCredential(): TokenCredential {
  const tenantId = process.env.STORAGE_TENANT_ID;
  return new ChainedTokenCredential(
    // Local dev: the `az login` identity, pinned to the data-store tenant
    // (optional — if unset, the az credential uses its ambient default tenant).
    // Succeeds first, so the Managed Identity below is never reached off Azure.
    new AzureCliCredential(tenantId ? { tenantId } : {}),
    // On Azure: the app's system-assigned Managed Identity (the `az` CLI is
    // absent there, so the CLI credential fails fast and the chain falls
    // through). For a *user-assigned* identity instead, pass
    // `{ clientId: "<identity-client-id>" }` here.
    new ManagedIdentityCredential(),
  );
}

// The ONE way this app authenticates against Azure Cognitive Services — today the
// Azure Foundry (Azure OpenAI) endpoint used by `lib/llm/foundry-endpoint.ts`. Same
// explicit chain as the data-store credential (and the same reason to avoid
// `DefaultAzureCredential` — see above), but WITHOUT the `STORAGE_TENANT_ID` pin:
// the Foundry resource lives in the ambient tenant of the `az login` identity.
//
// SERVER-ONLY: handles Azure credentials. Never import from client components.
export function buildCognitiveServicesCredential(): TokenCredential {
  return new ChainedTokenCredential(new AzureCliCredential({}), new ManagedIdentityCredential());
}

// The ONE way this app READS its own telemetry — the Application Insights query
// API behind the LLM diagnostics page (`lib/diagnostics-client.ts`,
// docs/diagnostics.md). Same explicit chain and the same reason to avoid
// `DefaultAzureCredential` (see above), without a tenant pin: the App Insights
// resource lives in the ambient tenant of the `az login` identity locally and of
// the Managed Identity on Azure. That identity needs the `Reader` role on the
// App Insights resource. Locally that is the Novedu `az` profile
// (`AZURE_CONFIG_DIR`, docs/azure-runtime-env.md, "Access").
//
// SERVER-ONLY: handles Azure credentials. Never import from client components.
export function buildMonitorCredential(): TokenCredential {
  return new ChainedTokenCredential(new AzureCliCredential({}), new ManagedIdentityCredential());
}
