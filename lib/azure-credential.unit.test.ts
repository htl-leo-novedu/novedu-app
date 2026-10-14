import { afterEach, describe, expect, it, vi } from "vitest";

// The explicit credential chains: `az login` first, then the Managed Identity —
// never `DefaultAzureCredential` (see lib/azure-credential.ts for why). Foundry
// alone may use a service principal, configured ONLY by its own variables.

const identity = vi.hoisted(() => ({
  AzureCliCredential: vi.fn(function (this: { kind: string; options: unknown }, options: unknown) {
    this.kind = "cli";
    this.options = options;
  }),
  ManagedIdentityCredential: vi.fn(function (this: { kind: string }) {
    this.kind = "mi";
  }),
  ChainedTokenCredential: vi.fn(function (this: { sources: unknown[] }, ...sources: unknown[]) {
    this.sources = sources;
  }),
  ClientSecretCredential: vi.fn(function (this: { kind: string }) {
    this.kind = "secret";
  }),
  ClientCertificateCredential: vi.fn(function (this: { kind: string }) {
    this.kind = "certificate";
  }),
}));

vi.mock("@azure/identity", () => identity);

import {
  buildCognitiveServicesCredential,
  buildDataStoreCredential,
  buildMonitorCredential,
  foundryCredentialKind,
} from "@/lib/azure-credential";

// The mocked module exports no DefaultAzureCredential, so a builder reaching for
// it would throw on the missing export instead of building.
type Chain = { sources: { kind: string; options?: unknown }[] };

const FOUNDRY_VARS = [
  "AZURE_FOUNDRY_TENANT_ID",
  "AZURE_FOUNDRY_CLIENT_ID",
  "AZURE_FOUNDRY_CLIENT_SECRET",
  "AZURE_FOUNDRY_CLIENT_CERTIFICATE",
] as const;

// Every test starts from a clean slate: no Foundry service principal, whatever
// the developer's shell or .env holds.
function clearFoundryEnv() {
  for (const name of FOUNDRY_VARS) vi.stubEnv(name, "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.each([
  ["buildMonitorCredential", buildMonitorCredential],
  ["buildCognitiveServicesCredential", buildCognitiveServicesCredential],
])("%s", (_name, build) => {
  it("chains the az CLI (ambient tenant) before the Managed Identity", () => {
    clearFoundryEnv();
    const credential = build() as unknown as Chain;
    expect(credential.sources.map((s) => s.kind)).toEqual(["cli", "mi"]);
    expect(credential.sources[0]?.options).toEqual({});
    expect(identity.ChainedTokenCredential).toHaveBeenCalledTimes(1);
  });
});

describe("buildDataStoreCredential", () => {
  it("chains the az CLI pinned to STORAGE_TENANT_ID before the Managed Identity", () => {
    vi.stubEnv("STORAGE_TENANT_ID", "tenant-1");
    const credential = buildDataStoreCredential() as unknown as Chain;
    expect(credential.sources.map((s) => s.kind)).toEqual(["cli", "mi"]);
    expect(credential.sources[0]?.options).toEqual({ tenantId: "tenant-1" });
  });

  it("leaves the az CLI on its ambient tenant when STORAGE_TENANT_ID is unset", () => {
    vi.stubEnv("STORAGE_TENANT_ID", "");
    const credential = buildDataStoreCredential() as unknown as Chain;
    expect(credential.sources[0]?.options).toEqual({});
  });
});

describe("buildCognitiveServicesCredential — Foundry service principal", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----";

  it("uses a client-secret credential when tenant, client id and secret are set", () => {
    clearFoundryEnv();
    vi.stubEnv("AZURE_FOUNDRY_TENANT_ID", "foundry-tenant");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_ID", "foundry-client");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_SECRET", "foundry-secret");
    const credential = buildCognitiveServicesCredential() as unknown as { kind: string };
    expect(credential.kind).toBe("secret");
    expect(identity.ClientSecretCredential).toHaveBeenCalledWith(
      "foundry-tenant",
      "foundry-client",
      "foundry-secret",
    );
    expect(identity.ChainedTokenCredential).not.toHaveBeenCalled();
    expect(foundryCredentialKind()).toBe("service-principal-secret");
  });

  it("uses a certificate credential over the PEM content when a certificate is set", () => {
    clearFoundryEnv();
    vi.stubEnv("AZURE_FOUNDRY_TENANT_ID", "foundry-tenant");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_ID", "foundry-client");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_CERTIFICATE", PEM);
    const credential = buildCognitiveServicesCredential() as unknown as { kind: string };
    expect(credential.kind).toBe("certificate");
    expect(identity.ClientCertificateCredential).toHaveBeenCalledWith(
      "foundry-tenant",
      "foundry-client",
      { certificate: PEM },
    );
    expect(identity.ChainedTokenCredential).not.toHaveBeenCalled();
    expect(foundryCredentialKind()).toBe("service-principal-certificate");
  });

  it("reports the managed identity / az chain when no service principal is configured", () => {
    clearFoundryEnv();
    expect(foundryCredentialKind()).toBe("managed-identity");
  });

  it("never picks up the generic AZURE_* sign-in variables", () => {
    clearFoundryEnv();
    vi.stubEnv("AZURE_TENANT_ID", "signin-tenant");
    vi.stubEnv("AZURE_CLIENT_ID", "signin-client");
    vi.stubEnv("AZURE_CLIENT_SECRET", "signin-secret");
    const credential = buildCognitiveServicesCredential() as unknown as Chain;
    expect(credential.sources.map((s) => s.kind)).toEqual(["cli", "mi"]);
    expect(identity.ClientSecretCredential).not.toHaveBeenCalled();
    expect(identity.ClientCertificateCredential).not.toHaveBeenCalled();

    // With both sets present, only the Foundry values reach the constructor.
    vi.stubEnv("AZURE_FOUNDRY_TENANT_ID", "foundry-tenant");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_ID", "foundry-client");
    vi.stubEnv("AZURE_FOUNDRY_CLIENT_SECRET", "foundry-secret");
    buildCognitiveServicesCredential();
    expect(identity.ClientSecretCredential).toHaveBeenCalledWith(
      "foundry-tenant",
      "foundry-client",
      "foundry-secret",
    );
  });

  it.each([
    [
      "tenant missing",
      { AZURE_FOUNDRY_CLIENT_ID: "foundry-client", AZURE_FOUNDRY_CLIENT_SECRET: "foundry-secret" },
      "AZURE_FOUNDRY_TENANT_ID not set",
    ],
    [
      "client id missing",
      { AZURE_FOUNDRY_TENANT_ID: "foundry-tenant", AZURE_FOUNDRY_CLIENT_CERTIFICATE: PEM },
      "AZURE_FOUNDRY_CLIENT_ID not set",
    ],
    [
      "ids without a credential",
      { AZURE_FOUNDRY_TENANT_ID: "foundry-tenant", AZURE_FOUNDRY_CLIENT_ID: "foundry-client" },
      "AZURE_FOUNDRY_CLIENT_SECRET or AZURE_FOUNDRY_CLIENT_CERTIFICATE not set",
    ],
    [
      "a credential without ids",
      { AZURE_FOUNDRY_CLIENT_SECRET: "foundry-secret" },
      "AZURE_FOUNDRY_TENANT_ID, AZURE_FOUNDRY_CLIENT_ID not set",
    ],
    [
      "both a secret and a certificate",
      {
        AZURE_FOUNDRY_TENANT_ID: "foundry-tenant",
        AZURE_FOUNDRY_CLIENT_ID: "foundry-client",
        AZURE_FOUNDRY_CLIENT_SECRET: "foundry-secret",
        AZURE_FOUNDRY_CLIENT_CERTIFICATE: PEM,
      },
      "set exactly one of AZURE_FOUNDRY_CLIENT_SECRET and AZURE_FOUNDRY_CLIENT_CERTIFICATE",
    ],
  ])("fails loudly, never falling back, on %s", (_case, env, expected) => {
    clearFoundryEnv();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    let message = "";
    try {
      buildCognitiveServicesCredential();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("Foundry service principal is misconfigured");
    expect(message).toContain(expected);
    // Variable names only — never a configured value.
    for (const value of Object.values(env)) expect(message).not.toContain(value);
    expect(identity.ChainedTokenCredential).not.toHaveBeenCalled();
    expect(() => foundryCredentialKind()).toThrow(expected);
  });
});
