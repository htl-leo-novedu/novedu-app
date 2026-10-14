import {
  AzureCliCredential,
  ChainedTokenCredential,
  ClientCertificateCredential,
  ClientSecretCredential,
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

// How this app authenticates against Azure Cognitive Services — today the Azure
// Foundry (Azure OpenAI) endpoint used by `lib/llm/foundry-endpoint.ts`. Decided
// once, from configuration (`foundryCredentialConfig`):
//
// - A Foundry SERVICE PRINCIPAL, when its settings are present: an app
//   registration in the Foundry resource's tenant holding `Cognitive Services
//   OpenAI User` on the resource, authenticating with a client secret OR a PEM
//   certificate (exactly one). This is what reaches a Foundry resource in ANOTHER
//   tenant — neither the Managed Identity nor the `az` profile (which locally
//   must point at the database's tenant) can. It is the only place a Foundry
//   secret or certificate is allowed; on a stage it comes from that stage's Key
//   Vault. Its settings carry Foundry-specific names for the same reason the
//   chains avoid `DefaultAzureCredential`: the generic `AZURE_TENANT_ID` /
//   `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` belong to user sign-in.
// - Otherwise the same explicit chain as the data-store credential, but WITHOUT
//   the `STORAGE_TENANT_ID` pin: the Foundry resource lives in the ambient tenant
//   of the `az login` identity locally and of the Managed Identity on Azure.
//
// A partially configured service principal (or one with BOTH a secret and a
// certificate) throws on first use — it never silently falls back to the chain.
// The error names variables only, never their values.
//
// SERVER-ONLY: handles Azure credentials. Never import from client components.

const FOUNDRY_TENANT_ID = "AZURE_FOUNDRY_TENANT_ID";
const FOUNDRY_CLIENT_ID = "AZURE_FOUNDRY_CLIENT_ID";
const FOUNDRY_CLIENT_SECRET = "AZURE_FOUNDRY_CLIENT_SECRET";
const FOUNDRY_CLIENT_CERTIFICATE = "AZURE_FOUNDRY_CLIENT_CERTIFICATE";

export type FoundryCredentialKind =
  | "managed-identity"
  | "service-principal-secret"
  | "service-principal-certificate";

type FoundryCredentialConfig =
  | { kind: "managed-identity" }
  | { kind: "service-principal-secret"; tenantId: string; clientId: string; secret: string }
  | {
      kind: "service-principal-certificate";
      tenantId: string;
      clientId: string;
      certificate: string;
    };

function foundryCredentialConfig(): FoundryCredentialConfig {
  const tenantId = process.env[FOUNDRY_TENANT_ID] ?? "";
  const clientId = process.env[FOUNDRY_CLIENT_ID] ?? "";
  const secret = process.env[FOUNDRY_CLIENT_SECRET] ?? "";
  const certificate = process.env[FOUNDRY_CLIENT_CERTIFICATE] ?? "";
  if (!tenantId && !clientId && !secret && !certificate) return { kind: "managed-identity" };

  const problem = "Foundry service principal is misconfigured";
  if (secret && certificate) {
    throw new Error(
      `${problem}: set exactly one of ${FOUNDRY_CLIENT_SECRET} and ${FOUNDRY_CLIENT_CERTIFICATE}, not both`,
    );
  }
  const missing = [
    ...(tenantId ? [] : [FOUNDRY_TENANT_ID]),
    ...(clientId ? [] : [FOUNDRY_CLIENT_ID]),
    ...(secret || certificate ? [] : [`${FOUNDRY_CLIENT_SECRET} or ${FOUNDRY_CLIENT_CERTIFICATE}`]),
  ];
  if (missing.length > 0) throw new Error(`${problem}: ${missing.join(", ")} not set`);

  return secret
    ? { kind: "service-principal-secret", tenantId, clientId, secret }
    : { kind: "service-principal-certificate", tenantId, clientId, certificate };
}

/** Which Foundry credential this process uses; throws on a misconfigured service principal. */
export function foundryCredentialKind(): FoundryCredentialKind {
  return foundryCredentialConfig().kind;
}

export function buildCognitiveServicesCredential(): TokenCredential {
  const config = foundryCredentialConfig();
  switch (config.kind) {
    case "service-principal-secret":
      return new ClientSecretCredential(config.tenantId, config.clientId, config.secret);
    case "service-principal-certificate":
      // PEM only (certificate + unencrypted private key) — @azure/identity reads no PFX.
      return new ClientCertificateCredential(config.tenantId, config.clientId, {
        certificate: config.certificate,
      });
    case "managed-identity":
      return new ChainedTokenCredential(
        new AzureCliCredential({}),
        new ManagedIdentityCredential(),
      );
  }
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
