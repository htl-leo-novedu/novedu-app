# Azure runtime environment: how Novedu is run

How the two-stage Azure environment is put together, what each resource is
for, how the `dev` and `prod` stages are kept apart, and how an image reaches
them. Read it before running any `az` command against `rg-novedu-shared` /
`rg-novedu-dev` / `rg-novedu-prod`, before touching
`scripts/db/provision-stage.*`, and before touching the deployment workflows.

> **Read *Access* first**: the rules, the tenant / subscription / admin-group
> ids, the separate `az` profile and how to get access. Do not run anything
> here before reading it.
>
> Still open: Azure Foundry in this tenant — both stages run on SCCH and on
> OpenRouter's allowlisted, Azure-backed GPT models (*OpenRouter* below).

## The staging concept

Two stages, **dev** and **prod**. Each stage owns everything that carries its
state or its rights; everything stateless and expensive to duplicate is shared.

| Per stage (isolated) | Shared between the stages |
|---|---|
| resource group, Key Vault, storage account + file share, Postgres database, App Insights, container app + its managed identity, GitHub deploy identity | Container Apps environment, Postgres *server*, container registry, Log Analytics workspace, the teacher guide's Static Web App |

The isolation is what makes the shared parts safe: a stage's identity holds
rights only on its own stage's resources and can only connect to its own
database, so sharing a server or an environment never shares data.

| | dev | prod |
|---|---|---|
| Resource group | `rg-novedu-dev` | `rg-novedu-prod` |
| Container app | `ca-novedu-dev`, 0.5 vCPU / 1 GiB | `ca-novedu-prod`, 1 vCPU / 2 GiB |
| Database | `novedu_dev` | `novedu_prod` |
| Hostname | `dev.novedu.at` | `app.novedu.at` |
| Replicas | 0–1 (scales to zero) | exactly 1 |

Each hostname is a custom domain on its container app (SNI binding) with a
managed certificate of the environment `cae-novedu`, validated by CNAME. The
apps still answer under their generated `*.austriaeast.azurecontainerapps.io`
names, but the app's configuration (`AUTH_URL`, `CODE_ORIGIN`) names the custom
domain, so sign-in works only there. The teacher guide has one version for both
stages, at `docs.novedu.at` (`swa-novedu-docs` below).

Everything is in **Austria East** (except the Static Web App, which the Free
plan does not offer there), and every resource carries the tags
`project=novedu` and `stage=shared|dev|prod`. There is **no
infrastructure-as-code**: the environment is built from an ordered runbook of
`az` commands, dev first, prod as an exact replay with different values. That
is why every change is coordinated (*Access* below). The design spec and the
runbook are working documents outside the repository (`docs/superpowers/specs`
is gitignored) — ask the developer leading the environment for them.

## Access

For every Novedu developer, and for Claude sessions working on a developer's
behalf. Read it before running any `az` command against the environment,
before changing how you run the app locally, and whenever a login has expired.

### Rules

- **Production is the prod stage.** Releases go through the pipeline: every
  publish deploys to dev, production follows through the manual `promote.yml`
  (*Deploying and running* below).
- **Local development runs against the dev stage's database** `novedu_dev`
  (`docs/database.md`), with the environment's own `az` profile (below). It
  holds real student and teacher data: never export it, and never load
  other data into it "to try something".
- **Coordinate before you change anything.** Without infrastructure-as-code,
  two people applying runbook steps at the same time collide silently.
  Read-only commands are always fine; anything that creates, changes or deletes
  a resource is agreed with the developer leading the environment first.
- **Group rights include prod.** Every member of the admin group is Owner of the
  prod resource group and Postgres admin on `novedu_prod` — which holds the real
  production data.
- **Never mix the environment into another `az` profile** (below). A command
  that lands in the wrong tenant or subscription is the main operational risk.

### Tenant and subscription

| | |
|---|---|
| Tenant | `91fc072c-edef-4f97-bdc5-cfb67718ae3a` (accounts `@htl-leonding.ac.at`) |
| Subscription | **`Novedu`** — `165b0053-6959-416b-9edf-aa3f82f3f270` |
| Region | Austria East (`austriaeast`) |
| Admin group | Entra security group `novedu-dev` — `46ba6be3-7489-4233-af5a-5649680b3fda` |
| Resource groups | `rg-novedu-shared`, `rg-novedu-dev`, `rg-novedu-prod` — nothing else |

A login to this tenant may show further subscriptions (for example
`Leonie Chatbot`), and a fresh login can select one of them as the default. They
are unrelated: **always pin `Novedu` right after a login** and never create
anything elsewhere. The `Novedu` subscription itself also holds resource groups
that are not part of this environment (`Novedu`, `ai-tutor-questionaire`); leave
them alone.

### Getting access

You need an `@htl-leonding.ac.at` account and membership in the **`novedu-dev`**
group; ask a current member to have you added. All work runs on the group's
rights (Owner on the three resource groups, Key Vault Secrets Officer, Entra
admin of `psql-novedu`) — nobody needs a personal role assignment.

The few steps that need **Owner on the subscription** — creating the resource
groups, assigning the group as their Owner, registering resource providers — are
one-time steps done by a subscription Owner. All resource providers the
environment needs are registered.

### The `az` profile, never mixed

The `az` CLI keeps its login state in one directory, chosen by
`AZURE_CONFIG_DIR`. The environment gets its own directory, and **every
developer uses the same one**, because the docs, scripts and agent instructions
in this repo rely on the name:

| Profile | `AZURE_CONFIG_DIR` | Logged in to |
|---|---|---|
| default | unset (`~/.azure`) | whatever you use otherwise |
| Novedu | `~/.htl-azure-novedu` | tenant `91fc072c-…`, subscription `Novedu` |

The profile is selected **per command** by the environment variable; nothing is
ever switched globally, so a command without the variable can never reach the
environment, and one with it can never reach anything else:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az <command>
```

In a script or a multi-command shell block, `export AZURE_CONFIG_DIR=~/.htl-azure-novedu`
once at the top. Never run `az login --tenant 91fc072c-…` or `az account set`
for the `Novedu` subscription in the default profile.

`AzureCliCredential` shells out to `az` and inherits the variable, so it also
decides which identity a locally running app uses. Local development reaches
`novedu_dev`, so the app's `.env` sets `AZURE_CONFIG_DIR` to the **absolute**
path of the profile (`.env` does not expand `~`) — see `docs/database.md`.
Every Entra token the local app requests through `az` then comes from this
tenant. Azure Foundry is the exception when `.env` configures a Foundry service
principal (`AZURE_FOUNDRY_TENANT_ID`, `AZURE_FOUNDRY_CLIENT_ID` and a client
secret or certificate, `docs/ai-models.md`): its tokens come from the Foundry
resource's own tenant, independent of this profile. Without one, a local
`.env` leaves `AZURE_FOUNDRY_ENDPOINT` unset — the profile's identity cannot
reach a Foundry resource outside this tenant.

### Logging in

Only a human can log in — it is an interactive Entra sign-in with MFA. The
refresh token lives in the profile directory, so a login lasts across sessions
until it expires or is revoked.

#### On a machine with a browser

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az login --tenant 91fc072c-edef-4f97-bdc5-cfb67718ae3a
AZURE_CONFIG_DIR=~/.htl-azure-novedu az account set --subscription 165b0053-6959-416b-9edf-aa3f82f3f270
```

#### Over SSH (no browser on the machine running `az`)

**The device-code flow does not work in this tenant**: the sign-in page answers
"You don't have access to this" even for an account that works fine in the
portal — the signature of a Conditional Access policy blocking the device-code
grant, while the browser flow is allowed. Without a display, `az login`
silently falls back to exactly that flow, so a plain `az login` over SSH always
fails this way. `--use-device-code` is never the fix.

Use the normal browser (authorization-code) flow instead, with the browser on
the local computer and the callback tunnelled to the remote `az`:

1. On the remote machine, start the login with a stand-in "browser" that only
   prints the sign-in URL. `DISPLAY` merely has to be non-empty so `az` picks
   the browser flow:

   ```bash
   DISPLAY=:0 BROWSER='echo %s' AZURE_CONFIG_DIR=~/.htl-azure-novedu \
     az login --tenant 91fc072c-edef-4f97-bdc5-cfb67718ae3a
   ```

   It prints a `https://login.microsoftonline.com/...` URL and keeps waiting.
   The URL contains `redirect_uri=http%3A%2F%2Flocalhost%3A<PORT>`; the port is
   random per login.

2. On the local computer, forward that port to the remote machine:

   ```bash
   ssh -N -L <PORT>:localhost:<PORT> <remote-host>
   ```

3. Open the printed URL in the local browser and sign in. Entra posts the result
   to `localhost:<PORT>`, the tunnel delivers it to the waiting `az`, and the
   login completes. If the final page cannot connect, the tunnel was not up yet:
   start it and reload that page.

4. Pin the subscription (`az account set`, as above) and close the tunnel.

**Never leave a second `az login` pending against the same profile.** A login
that fails or times out — a device-code attempt expires after about 15 minutes —
clears the profile's subscription list on its way out, and takes a working login
with it: every command then answers "Please run 'az login'". The only way back is
a new login; the profile files are not repaired by hand. Cancel an abandoned
attempt (Ctrl+C) before starting another.

A Claude session can run step 1 itself as a background command, read the URL and
port from its output, and hand steps 2–3 to the developer; it is notified when
the login completes.

### Verifying access

Read-only; run after every login and at the start of a work session.

```bash
export AZURE_CONFIG_DIR=~/.htl-azure-novedu
SUB=165b0053-6959-416b-9edf-aa3f82f3f270
GRP=46ba6be3-7489-4233-af5a-5649680b3fda

# 1. Right tenant, right subscription (Novedu), enabled
az account show --query "{name:name,id:id,tenant:tenantId,state:state,user:user.name}" -o json

# 2. Admin group: security-enabled, and the caller is a member (expected: true)
ME=$(az ad signed-in-user show --query id -o tsv)
az ad group show --group $GRP --query "{name:displayName,securityEnabled:securityEnabled}" -o json
az ad group member check --group $GRP --member-id "$ME" --query value -o tsv

# 3. Effective rights, own and through groups. Expected: Owner on the three
#    rg-novedu-* groups via novedu-dev; a subscription Owner also sees that scope.
az role assignment list --assignee "$ME" --all --include-groups \
  --query "[].{role:roleDefinitionName,scope:scope}" -o table

# 4. Resource providers the environment needs (expected: Registered)
for p in Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL \
         Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.Storage \
         Microsoft.Insights Microsoft.ManagedIdentity; do
  printf "%-32s %s\n" $p "$(az provider show -n $p --query registrationState -o tsv)"
done

# 5. Tokens can be issued: ARM, and Postgres (Entra auth to psql-novedu).
#    Query the expiry only — never print a token.
az account get-access-token --query expiresOn -o tsv
az account get-access-token --resource-type oss-rdbms --query expiresOn -o tsv
```

Austria East offers every resource type the environment uses — Container Apps
environments, apps and managed certificates, Log Analytics, Postgres Flexible
Server (versions up to 18; Burstable `Standard_B1ms` and `Standard_B2s`),
Container Registry, Key Vault, Storage, Application Insights, user-assigned
identities. Re-check Postgres with
`az postgres flexible-server list-skus -l austriaeast` if a SKU change is planned.

### CLI extensions

Extensions are installed **per profile**: the `~/.htl-azure-novedu` profile
does not see the ones in `~/.azure`. `az containerapp` works from the core CLI
and needs none. The extension this profile does need is `application-insights`,
for any `az monitor app-insights` command:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az extension add -n application-insights
```

`az monitor log-analytics query` (for example the workspace's `Usage` table)
needs the preview extension `log-analytics`, which `az` installs on first use.

### What stays with a human

- The login itself (above).
- Typing or pasting a secret value: a person enters it directly into Key Vault
  (`az keyvault secret set ... --file /dev/stdin -o none`, or the portal). A
  Claude session may only move a value it never sees — piped from its source
  into Key Vault inside one command, with no output — and checks names, lengths
  and hashes, never values. No secret value appears in a session or its
  transcript.
- DNS records for the stage hostnames.

Tokens are never printed, logged, or written to files by a Claude session;
checks query metadata such as `expiresOn` only.

## Shared resources (`rg-novedu-shared`)

### `log-novedu` — Log Analytics

One workspace, `PerGB2018`, 30 days retention, **daily cap 0.5 GB**. It takes
the Container Apps environment's logs and backs both stages' Application
Insights resources. The cap bounds what a log storm can cost; once it is
reached, ingestion stops until the reset (17:00 UTC) — logs and telemetry of
both stages are then missing for the rest of that window, so a gap there means
"cap hit", not "nothing happened". Check it with
`az monitor log-analytics workspace show -g rg-novedu-shared -n log-novedu --query workspaceCapping`.

### `cae-novedu` — Container Apps environment

Workload-profiles environment type using **only the built-in `Consumption`
profile**; no dedicated profile is ever added. No VNet, no separate managed
infrastructure resource group. Logs go to `log-novedu`.

Its children live in the shared group even though they belong to a stage — the
two **environment storage definitions**:

| Definition | Storage account | Share | Access |
|---|---|---|---|
| `files-dev` | `stnovedudev` | `novedu-files` | ReadWrite |
| `files-prod` | `stnoveduprod` | `novedu-files` | ReadWrite |

The Azure Files mount is **key-based**, so each storage account's access key
sits in its environment storage definition. That is the one secret that cannot
live in Key Vault; one storage account per stage is what keeps it harmless,
because dev's key cannot open prod's share.

### `crnovedu` — Container Registry

Basic tier, **admin user disabled** (`crnovedu.azurecr.io`). One repository,
`novedu`, holding the images the stages run. Every tag is an immutable version
tag, `<package.json version>.<workflow run number>` (e.g. `0.1.0.126`); there is
no `:latest` here, because a stage must always name the exact version it runs.
The stages pull only from here, never from GHCR, so starting a container
(including a scale-from-zero) depends on no registry outside Azure.

Pushing is the pipeline's job (*Deploying and running* below). The Basic tier
has **no retention policy**, so old versions accumulate until someone purges
them:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az acr run --registry crnovedu \
  --cmd "acr purge --filter 'novedu:.*' --ago 90d --keep 10 --untagged" /dev/null
```

Check first which versions the two stages currently run (*Reviewing the
environment*) — purging one of those leaves the stage unable to restart.

### `psql-novedu` — Postgres Flexible Server

| | |
|---|---|
| Version / SKU | 18, Burstable `Standard_B1ms`, 32 GB, storage auto-grow off |
| Backups | 7 days, no geo-redundant backup, no high availability |
| Network | public endpoint, TLS |
| Authentication | **Entra-only — password authentication is disabled** |
| Entra admin | the security group `novedu-dev` |
| Databases | `novedu_dev`, `novedu_prod` — each migrated by its own stage at boot. `novedu_dev` holds the copy of the prototype's data (*Data in the dev stage*) and serves local development (`docs/database.md`) |

The firewall is an "allow Azure services" rule plus one rule per developer
machine IP. Adding one:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az postgres flexible-server firewall-rule create \
  -g rg-novedu-shared --server-name psql-novedu \
  --name <rule> --start-ip-address <ip> --end-ip-address <ip>
```

### `swa-novedu-docs` — Static Web App (teacher guide)

| | |
|---|---|
| Plan / region | Free, West Europe |
| Hostname | `docs.novedu.at`, a custom domain validated by CNAME to the default hostname `blue-sky-0a21f7b03.6.azurestaticapps.net`, with an SWA-managed certificate |
| Source | none linked — content is uploaded by `promote.yml` only (`docs/teacher-docs.md`) |
| Deploy rights | `id-novedu-gh-prod` holds Contributor on this resource, to read the deployment token at runtime |

Serves the static teacher guide — one version, released with each promotion and
built from the promoted image's commit. Recreating it from scratch:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az staticwebapp create \
  -n swa-novedu-docs -g rg-novedu-shared -l westeurope --sku Free \
  --tags project=novedu stage=shared
# the DNS CNAME docs.novedu.at → <new default hostname> (external DNS admin), then:
AZURE_CONFIG_DIR=~/.htl-azure-novedu az staticwebapp hostname set \
  -n swa-novedu-docs -g rg-novedu-shared --hostname docs.novedu.at
AZURE_CONFIG_DIR=~/.htl-azure-novedu az role assignment create \
  --assignee-object-id <principalId of id-novedu-gh-prod> --assignee-principal-type ServicePrincipal \
  --role Contributor --scope <resource id of swa-novedu-docs>
```

## Per-stage resources

Read `dev`/`prod` for `<stage>` throughout; the two stages differ only in the
values listed above.

### Container app `ca-novedu-<stage>`

Single-revision mode, external ingress, HTTPS only, system-assigned managed
identity, Consumption profile.

Both apps run the Novedu image from `crnovedu`, pulled with the app's own
system-assigned identity (no registry credential is stored), on target port
3000, with their full configuration — secret references and environment
variables, see *Configuration* below — and the stage's Azure Files share
mounted at `/novedu-files`:

| | |
|---|---|
| Volume | `files-<stage>`, type `AzureFile`, from the environment storage definition of the same name |
| Mount path | `/novedu-files` — what `IMAGE_STORAGE_ROOT` points at (`docs/images.md`) |

Each app has three HTTP probes on the public `GET /api/version` (port 3000):

| Probe | Period | Timeout | Failure threshold |
|---|---|---|---|
| Startup | 5 s | 3 s | 60 — five minutes for a boot that applies migrations |
| Liveness | 30 s | 5 s | 3 |
| Readiness | 10 s | 3 s | 3 |

The route touches neither the database nor an LLM provider, so an outage of a
dependency never restarts the container. Next.js answers requests only once
`instrumentation.ts` has finished, so the startup probe also covers the
boot-time migrations. `/api/health` is teacher-only and checks dependencies —
unsuitable on both counts.

Dev scales 0–1, prod runs exactly one replica (min = max = 1); both are reached
at their custom domain (*The staging concept*).

### Key Vault `kv-novedu-<stage>`

RBAC mode, soft delete 90 days, no purge protection. The `novedu-dev` group is
Key Vault Secrets Officer, the stage's app identity is Key Vault Secrets User.
It holds the five secrets of *Configuration* below; a secret value is never
displayed, logged or written to a file on its way in (*Access*, "What stays
with a human").

### Storage account `stnovedudev` / `stnoveduprod`

StorageV2, `Standard_LRS`, TLS 1.2 minimum, no public blob access, shared-key
access enabled (the Azure Files mount needs it). One file share `novedu-files`
with a 100 GiB quota.

The share is already provisioned as an **image root**: an `images/` directory
plus the `.novedu-files-root` sentinel, whose bytes come from
`scripts/lib/image-root.mjs`. Both are written through the storage API rather
than by the app, because the image adapter never creates the root, `images/` or
the sentinel and has no fallback directory — see `docs/images.md`. The share is
mounted into the stage's container app at `/novedu-files`, which is where the
app's `IMAGE_STORAGE_ROOT` points.

### Application Insights `appi-novedu-<stage>`

Workspace-based on `log-novedu`, one resource per stage, so each stage's
telemetry stays its own. The app reaches it through
`APPLICATIONINSIGHTS_CONNECTION_STRING`, a Key Vault reference to the stage's
own connection string (`docs/telemetry.md`). The connection string must carry
`ApplicationId=`: the teacher-only `/diagnostics` page reads the resource back
through it with the app's own identity, which therefore needs **Reader** on
**its own** stage's `appi-novedu-<stage>` (`docs/diagnostics.md`).

### GitHub identity `id-novedu-gh-<stage>`

A user-assigned managed identity per stage for GitHub Actions OIDC, audience
`api://AzureADTokenExchange`:

| Identity | Federated credential subject |
|---|---|
| `id-novedu-gh-dev` | `repo:htl-leo-novedu@330419586/novedu-app@1263139282:ref:refs/heads/main` |
| `id-novedu-gh-prod` | `repo:htl-leo-novedu@330419586/novedu-app@1263139282:environment:production` |

The subjects use GitHub's immutable format: `330419586` is the id of the
`htl-leo-novedu` organization, `1263139282` the id of the repository.
These are the only credentials the pipeline has: **no Azure secret is stored in
GitHub**. A federated token is issued only for the exact subject above, so a
run from another branch — or a fork PR — cannot obtain one
(`docs/ci-security.md`).

## Identity and access

The complete list of role assignments inside the environment — **no identity
of one stage holds any right on the other stage's resources** (the docs Static
Web App is a shared resource, not a stage's):

| Principal | Rights |
|---|---|
| group `novedu-dev` | Owner on the three resource groups; Key Vault Secrets Officer on both vaults; Entra admin of `psql-novedu` |
| `ca-novedu-<stage>` (system-assigned MI) | AcrPull on `crnovedu`; Key Vault Secrets User on **its own** stage's vault; a Postgres role in **its own** stage's database; Reader on **its own** stage's `appi-novedu-<stage>` |
| `id-novedu-gh-dev` | AcrPush on `crnovedu`; Contributor on the resource `ca-novedu-dev` |
| `id-novedu-gh-prod` | AcrPull on `crnovedu`; Contributor on the resource `ca-novedu-prod`; Contributor on the resource `swa-novedu-docs` |

Only the dev GitHub identity may push images; the prod one only pulls and
updates its own app, so a promotion can never introduce a new image.

Human access runs entirely on the group's rights — nobody needs a personal role
assignment. Group membership therefore includes prod and its production data
(*Access*).

The resource groups also **inherit every assignment made on the subscription**
`Novedu`. There it is the subscription Owners only — no Contributor, no service
principal. Anyone added at that scope reaches everything in both stages: the
storage keys, a shell in the running container (and with it the resolved
secrets), and the right to appoint a Postgres Entra admin. Keep that scope to
the Owners; *Reviewing the environment* lists it.

### Delete locks

A `CanNotDelete` lock named `no-delete` sits on each resource that holds data
or secrets the runbook cannot rebuild: `psql-novedu`, `stnovedudev`,
`stnoveduprod`, `kv-novedu-dev` and `kv-novedu-prod`. It blocks deleting the
resource and anything below it on the management plane — a database, a file
share, a role assignment scoped to the resource — but no data operation: rows,
files and secret versions are written and deleted as before. Deleting such a
resource on purpose starts with `az lock delete`.

## Configuration

Both stages are configured in full: every secret sits in the stage's own Key
Vault, the container app references it there, and the plain settings are on the
app. Read `dev`/`prod` for `<stage>` throughout.

### Secrets

Five secrets per stage, under **identical names in both vaults**. Each is wired
into the container app as a Key Vault reference,
`keyvaultref:<versionless secret URI>,identityref:system`, so the app resolves
it when a revision starts, using its own system-assigned identity — which is
Key Vault Secrets User on its own stage's vault only. The reference is
versionless, so a new secret version needs no change to the app.

| Key Vault secret | App secret | Environment variable | Value |
|---|---|---|---|
| `AUTH-SECRET` | `auth-secret` | `AUTH_SECRET` | each stage its own value; prod's randomly generated (32 bytes, base64) |
| `AZURE-CLIENT-SECRET` | `azure-client-secret` | `AZURE_CLIENT_SECRET` | dev: the secret of the registration *Novedu Chat MVP*, expiring 2028-06-08. prod: the secret `novedu-prod` of *Novedu Chat (prod)*, expiring 2028-09-20. The vault secret's `expires` attribute carries the same date |
| `SCCH-API-KEY` | `scch-api-key` | `SCCH_API_KEY` | the one SCCH key — the **only** secret that is identical in both stages |
| `OPENROUTER-API-KEY` | `openrouter-api-key` | `OPENROUTER_API_KEY` | each stage its own key in the OpenRouter workspace `rs-htl-leonding` — dev `novedu-dev`, prod `novedu-prod` (*OpenRouter* below) |
| `APPLICATIONINSIGHTS-CONNECTION-STRING` | `appinsights-connection-string` | `APPLICATIONINSIGHTS_CONNECTION_STRING` | the stage's own `appi-novedu-<stage>` |

Apart from the SCCH key no secret is shared between the stages, so
compromising dev's vault tells nobody anything about prod.

A Foundry service principal's client secret or PEM certificate
(`AZURE_FOUNDRY_CLIENT_SECRET` / `AZURE_FOUNDRY_CLIENT_CERTIFICATE`,
`docs/ai-models.md`) belongs in the same place, wired the same way — a Key Vault
reference, never a plain value on the container app. A certificate is a Key Vault
certificate created with the PEM content type, so its secret value is the PEM the
app reads. The stages configure none (*Deliberately not set*).

### Environment variables

Plain values on the container app, beside the five secret references:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://ca-novedu-<stage>@psql-novedu.postgres.database.azure.com/novedu_<stage>?sslmode=require` |
| `AUTH_URL` | `https://<the stage's hostname>/api/auth` |
| `CODE_ORIGIN` | `https://<the stage's hostname>` |
| `AZURE_TENANT_ID` | `91fc072c-edef-4f97-bdc5-cfb67718ae3a` (both stages) |
| `AZURE_CLIENT_ID` | dev `4d44fc4b-0434-4981-9765-62e2074ceecb`, prod `d36756ba-5d79-4809-8a01-896d02639a34` |
| `TEACHER_GROUP_ID` | `1adac4e1-be54-458c-90ef-318d89f83317` (both stages) |
| `SCCH_BASE_URL` | `https://llm2go-api.scch.at/v1` |
| `IMAGE_STORAGE_ROOT` | `/novedu-files` |
| `OTEL_SERVICE_NAME` | `novedu-chat-<stage>` |

`DATABASE_URL` carries **no password**: the app authenticates with its managed
identity token (`lib/db/pool.ts`, `docs/database.md`).

The hostname is the stage's custom domain, `dev.novedu.at` or `app.novedu.at`.
`AUTH_URL` is better-auth's base URL: it builds the OAuth `redirect_uri` from
it, while the state cookie lives on the host the browser started from — so a
value that differs from the host people use breaks sign-in. Changing a stage's
hostname therefore means changing `AUTH_URL` and `CODE_ORIGIN`, the stage's
`*_BASE_URL` GitHub variable, adding the new callback to that stage's app
registration, and rewriting `novedu_codes.file_url` (*Data in the dev
stage*).

### Deliberately not set

- **`AZURE_FOUNDRY_ENDPOINT` (and the `AZURE_FOUNDRY_*` service-principal
  variables)** — these stages run on **SCCH and OpenRouter**, never on Foundry
  directly. A provider's variables are its switch: without them the app boots
  normally, `/health` reports Foundry as `Not configured (<variable> is
  missing)`, and `providerUnavailableReason` rejects an activity, code or eval
  request that names Azure Foundry as unavailable on these stages
  (`docs/ai-models.md`). Every default provider is SCCH.
- **`OPENROUTER_BASE_URL`** — the app talks to the public OpenRouter host; the
  allowlist lives in the workspace, not in a proxy (*OpenRouter* below).
- **`STORAGE_TENANT_ID`** — it only pins the tenant of a local `az` credential
  and means nothing to a managed identity.
- **`OTEL_EXPORTER_OTLP_ENDPOINT`** — it would win over the Application
  Insights connection string; telemetry goes to Azure Monitor
  (`docs/telemetry.md`).

### OpenRouter

`OPENROUTER_API_KEY` reaches one OpenRouter workspace, **`rs-htl-leonding`**
(`094e1664-2411-43a8-abf7-d895ddb0ab45`), configured outside Azure with
OpenRouter's management API or website:

- **BYOK, BYOK-only:** an Azure credential for the Azure OpenAI resource
  `oai-rstropek-sweden` (resource group `oai`, Sweden; deployments
  `gpt-6-luna`, `gpt-5.6-terra`, `gpt-6.1-sol`, GlobalStandard), with
  OpenRouter's shared capacity switched off — every request is served by that
  resource.
- **Default guardrail** (applies to every key in the workspace): the three models
  `openai/gpt-6-luna`, `openai/gpt-5.6-terra`, `openai/gpt-6.1-sol`, provider
  Azure only. Any other model is refused at runtime with HTTP `404` ("… matching
  your guardrail restrictions"). OpenRouter stores the allowlist as **dated**
  model slugs, so when an alias moves to a newer snapshot, requests may be
  refused until the guardrail lists the new slug and the Azure deployment is
  upgraded to match.
- **Budget:** the workspace's weekly budget, BYOK traffic included (counted at
  OpenRouter's list price, not the Azure cost). The keys carry no limit and no
  expiry of their own.
- **Logging:** request/response logging and broadcast are off.

A new or rotated stage key is created in that workspace and piped straight into
the stage's vault (*Setting or rotating a secret*); the two stages never share a
key. Local development has a third key of its own, `novedu-localhost`, in the
developer's git-ignored `.env`, so the local `@live-llm` OpenRouter legs
(docs/testing.md) run against the same allowlist as the stages.

`oai-rstropek-sweden` is **not** part of the Novedu environment: it sits in the
*Microsoft Azure Sponsorship* subscription, reached through the developer's
default `az` profile, not `~/.htl-azure-novedu`, and no Novedu identity holds a
role on it. OpenRouter BYOK for Azure takes an API key only (no Entra
credential), so that resource keeps local (key) auth enabled. Rotating its key:
put the resource's second key into the workspace's BYOK entry, verify a request
still answers on Azure, then regenerate the first key.

### Sign-in app registrations

Sign-in runs against the tenant that hosts the environment, through two Entra
app registrations in it:

| Registration | Client id | Used by | Redirect URIs |
|---|---|---|---|
| *Novedu Chat MVP* | `4d44fc4b-0434-4981-9765-62e2074ceecb` | `ca-novedu-dev`, local development | `https://dev.novedu.at/api/auth/callback/microsoft`, the same path on `ca-novedu-dev`'s generated name, and `http://localhost:3000/api/auth/callback/microsoft` |
| *Novedu Chat (prod)* | `d36756ba-5d79-4809-8a01-896d02639a34` | `ca-novedu-prod` | `https://app.novedu.at/api/auth/callback/microsoft` and the same path on `ca-novedu-prod`'s generated name |

Both are single-tenant, carry `groupMembershipClaims: All` with the optional
`groups` claim on the id and the access token — that is what `TEACHER_GROUP_ID`
is matched against — plus the optional `given_name` and `family_name` claims on
the id token (the start page greets with `given_name`, `docs/auth.md`), request
Graph `User.Read` and `profile` with per-user consent, and grant no implicit flow.

Accounts are keyed by the Entra `oid`, which is tenant-wide, so the same person
is the same user under both registrations; the two stages nevertheless share no
data, because each has its own database (`docs/auth.md`).

### Setting or rotating a secret

The value goes in on stdin — never in an argument, and never displayed, in a
terminal or a Claude session (*Access*):

```bash
export AZURE_CONFIG_DIR=~/.htl-azure-novedu

az keyvault secret set --vault-name kv-novedu-<stage> --name <NAME> \
  --file /dev/stdin --encoding utf-8 -o none
```

Because the app's reference is versionless, the new value is picked up by the
next revision — or immediately with
`az containerapp revision restart -g rg-novedu-<stage> -n ca-novedu-<stage> --revision <revision>`.

A client secret expires, so check it before it does. The `expires` attribute
of `AZURE-CLIENT-SECRET` mirrors the registration's end date — Key Vault does
not enforce it, it only makes the date visible (and lets a near-expiry event
fire); set it again with `az keyvault secret set-attributes --expires <date>
-o none` whenever the secret is rotated:

```bash
az ad app credential list --id <client id> \
  --query "[].{name:displayName,end:endDateTime}" -o table
az keyvault secret show --vault-name kv-novedu-<stage> -n AZURE-CLIENT-SECRET \
  --query attributes.expires -o tsv
```

## Postgres roles and stage isolation

Both stages live on one server, so the stage boundary is a **privilege, not a
network rule**. Each stage is provisioned with

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu node scripts/db/provision-stage.mjs <dev|prod>
```

and verified with the same command plus `--check`. The runner substitutes the
stage's identifiers into `scripts/db/provision-stage.sql`, picks the database
each block runs on, and skips the two statements Postgres cannot express
idempotently, so **re-running is safe**; `--check` changes nothing and exits 1
when an expectation fails. The password is an Entra access token fetched from
the ambient `az` profile — which is why the script refuses to run without
`AZURE_CONFIG_DIR`.

Per stage it produces:

- the app's managed identity registered as the Postgres role
  `ca-novedu-<stage>` — a plain login role with exactly the privilege model of
  `docs/database.md`: `CONNECT` + `CREATE` on its database, `USAGE` + `CREATE`
  on the schemas `public` and `mastra`, owning what it creates at boot;
- the database owned by the group role, not by the app role;
- `revoke create on schema public from public`;
- `revoke connect on database … from public`, so a stage's identity cannot even
  open a connection to the other stage's database.

**Humans connect as the group.** A group member logs in with the group name
`novedu-dev` as the Postgres user and their own Entra token as the password, so
every developer's connection string is identical.

**Dev only:** the group is a member of `ca-novedu-dev` and

```sql
alter role "novedu-dev" in database novedu_dev set role = 'ca-novedu-dev';
```

makes every group session act as the dev app role automatically — a fresh
session reports `current_user=ca-novedu-dev`, `session_user=novedu-dev`. Objects
created by a developer's local boot are therefore owned by the app role from
the start, and the **ownership hazard** of `docs/database.md` cannot occur in
`novedu_dev`. The flip side: admin work inside that database starts with `SET
ROLE NONE` (which the provisioning script does itself). `novedu_prod` has no
such default; there the group is a plain admin.

## Data in the dev stage

`novedu_dev` and the dev image share hold a **copy of the prototype's data**
— the single app that ran at `novedu.at` before these stages — taken when that
app was stopped, so teachers and students can continue
activities that started there (the prod stage started empty). It is real student and
teacher data: treat the dev stage like production when it comes to exporting or
sharing what is in it. Everything created on dev since then lives beside it.

The copy differs from the prototype's data in four deliberate ways:

- **No chat messages.** `mastra.mastra_messages` is empty; the threads exist, so
  a stored chat opens with an empty transcript.
- **No credentials.** `novedu_session`, `novedu_device_code`,
  `novedu_verification` and `novedu_coding_keys` are empty, and the token
  columns of `novedu_account` are null — session tokens and coding API keys are
  stored in plaintext and would otherwise be working credentials on this stage.
  Everyone signs in fresh; students request a new coding key.
- **App-hosted file URLs point at the dev stage.** `novedu_codes.file_url` is an
  absolute URL, and the app resolves it from its own database only when it
  starts with the stage's `CODE_ORIGIN`; any other origin is fetched over
  HTTPS. Every app-hosted `…/api/files/…` URL in this stage's database
  therefore has the origin `https://dev.novedu.at`. Changing a stage's
  hostname means rewriting them to the new `CODE_ORIGIN`.
- **Only active images.** The share holds the bytes of the active image rows
  under `images/<key>/content`; closed rows had no bytes in the prototype either.

Sign-in needs no mapping: the prototype authenticated against the same Entra
tenant and teacher group, so a user's `oid` finds their copied
`novedu_account` row and the teacher flag is recomputed as usual.

The copy is a `pg_dump` of the schemas `public` and `mastra` restored with
`--no-owner --no-acl --role=ca-novedu-dev` into the stopped stage, without the
dump's schema entries — the stage's schemas and grants stay as provisioned, and
every restored object is owned by the app role (`provision-stage.mjs dev
--check` verifies it). There is no `pg_dump` on the dev machines; the
`postgres:18` container image provides it.

## Deploying and running

Development is **trunk-based**: `main` is the only long-lived branch, and the
stages are deployment targets, not branches. One image is built once per merge
to `main` and both stages run that same artifact — prod never gets a separately
built one.

| Step | Where | What happens |
|---|---|---|
| Publish | `.github/workflows/docker-publish.yml` | QA gate, then the image is built **once** under the version tag and pushed to GHCR (`ghcr.io/htl-leo-novedu/novedu-app`, a public package; the version tag plus `:latest`) — the build artifact the next step copies. |
| Deploy to dev | its `deploy-dev` job | Copies that very image registry-to-registry into `crnovedu` (same digest) and deploys it to `ca-novedu-dev`. A red `deploy-dev` leaves production untouched. |
| Promote to prod | `.github/workflows/promote.yml`, manual | Verifies the version exists in `crnovedu` and deploys it to `ca-novedu-prod`. **No image is built.** Then publishes the teacher guide, built from that image's commit (in a job without Azure access), to `swa-novedu-docs`. |

Both deploy steps go through the composite action
`.github/actions/deploy-stage`: `az containerapp update --image`, then poll the
stage's `/api/version` until it reports that version (10 minutes, revision list
printed on timeout). **Green means the stage answers with the version** — the
poll also wakes a scaled-to-zero app. Database migrations run at app boot, per
stage, so deploying to a stage migrates that stage's database.

### Promoting and rolling back

```bash
gh workflow run promote.yml -f version=0.1.0.126   # a specific version
gh workflow run promote.yml                        # the version dev currently runs
```

An empty `version` resolves to what dev reports at `/api/version`. **Rollback is
the same command with an older version** — one that is in `crnovedu` and in the
GHCR package, where `promote.yml` reads the image's commit — and it rolls the teacher guide back
too — except to a version from before the guide had its own host, which leaves
the guide as it is. Migrations are forward-only, so rolling back across one only
works if that migration was backward-compatible.

### GitHub configuration

No Azure secret is involved anywhere — all of this is plain repository or
environment **variables** (`docs/ci-security.md`).

| Scope | Name | Holds |
|---|---|---|
| repository variable | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | the tenant and subscription of *Access* |
| repository variable | `AZURE_DEV_CLIENT_ID` | client id of `id-novedu-gh-dev` |
| repository variable | `DEV_BASE_URL` | dev's public base URL, no trailing slash |
| environment `production` | `AZURE_PROD_CLIENT_ID` | client id of `id-novedu-gh-prod` |
| environment `production` | `PROD_BASE_URL` | prod's public base URL, no trailing slash |

The `production` environment's deployment branches are **`main` only**; it is
what the prod identity's federated subject matches, so it is part of the trust
chain, not a convenience. A required reviewer can be added to it without
touching the workflow. The two `*_BASE_URL` variables carry the stages'
custom domains, `https://dev.novedu.at` and `https://app.novedu.at`.

The GHCR package **`novedu-app`** must be **Public** (package settings →
visibility). `promote.yml` reads the image's commit from it without logging in,
so a private package fails every promote with `unauthorized`; `compose.yaml`
pulls its `:demo` and `:fake-llm` images from it anonymously too.

### Constraints the pipeline respects

- **One replica per stage is a hard limit** (dev 0–1, prod exactly 1). The Drizzle migrator takes no lock, and the pool maximum of 20
  connections (`lib/db/pool.ts`) is sized against what a `Standard_B1ms`
  offers (50).
- **Single-revision mode** keeps the old revision serving until the new one is
  ready, so a failed boot-time migration leaves the stage on its previous
  revision.
- **The probes poll `/api/version`**, the same route the pipeline polls, and
  the startup probe allows a boot five minutes. `az containerapp update
  --image` keeps them.
- **Dev scales to zero**, so the first request after an idle period pays a cold
  start that includes the boot-time migration check.

## Reviewing the environment

Read-only; safe at any time, unlike anything that creates or changes a
resource (*Access*).

```bash
export AZURE_CONFIG_DIR=~/.htl-azure-novedu

# What exists, per resource group
for rg in rg-novedu-shared rg-novedu-dev rg-novedu-prod; do
  echo "== $rg"; az resource list -g $rg -o table
done

# Every role assignment in the environment
az role assignment list --all \
  --query "[?contains(scope,'rg-novedu-')].{principal:principalName,type:principalType,role:roleDefinitionName,scope:scope}" \
  -o table

# ... and what the resource groups inherit from the subscription and above
# (expected: the subscription Owners, nothing else)
az role assignment list --scope /subscriptions/165b0053-6959-416b-9edf-aa3f82f3f270 --include-inherited \
  --query "[?!contains(scope,'/resourceGroups/')].{principal:principalName,type:principalType,role:roleDefinitionName,scope:scope}" \
  -o table

# The delete locks (expected: no-delete on the Postgres server, both storage
# accounts and both vaults)
for rg in rg-novedu-shared rg-novedu-dev rg-novedu-prod; do
  az lock list -g $rg --query "[].{name:name,level:level,id:id}" -o tsv
done

# A stage's probes
az containerapp show -g rg-novedu-dev -n ca-novedu-dev \
  --query "properties.template.containers[0].probes[].{type:type,path:httpGet.path,period:periodSeconds,failures:failureThreshold}" -o table

# Postgres is Entra-only (password auth disabled)
az postgres flexible-server show -g rg-novedu-shared -n psql-novedu --query authConfig

# The environment's storage definitions
az containerapp env storage list -g rg-novedu-shared -n cae-novedu -o table

# The image versions in the registry, newest first
az acr repository show-tags -n crnovedu --repository novedu --orderby time_desc --top 10

# What a stage runs: image, port, registry (identity pull) and the file mount
az containerapp show -g rg-novedu-<stage> -n ca-novedu-<stage> --query "{
  image:properties.template.containers[0].image,
  port:properties.configuration.ingress.targetPort,
  fqdn:properties.configuration.ingress.fqdn,
  registries:properties.configuration.registries[].{server:server,identity:identity},
  volumes:properties.template.volumes[].{name:name,storage:storageName,type:storageType},
  mounts:properties.template.containers[0].volumeMounts }"

# The teacher guide's Static Web App: custom domain and its status
az staticwebapp hostname list -n swa-novedu-docs -g rg-novedu-shared -o table

# The GitHub OIDC federated credentials, per stage
az identity federated-credential list \
  -g rg-novedu-<stage> --identity-name id-novedu-gh-<stage> -o table

# Which secrets a vault holds — names only, never values
az keyvault secret list --vault-name kv-novedu-<stage> --query "[].name" -o tsv

# How the app resolves them: reference URI and the identity used
az containerapp show -g rg-novedu-<stage> -n ca-novedu-<stage> \
  --query "properties.configuration.secrets[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity}" \
  -o table

# The app's environment variables (secret-backed ones show only the secret name)
az containerapp show -g rg-novedu-<stage> -n ca-novedu-<stage> \
  --query "properties.template.containers[0].env" -o table

# Database, app role, grants and cross-stage isolation, per stage
node scripts/db/provision-stage.mjs <stage> --check
```

The profile's CLI extensions: *Access*, "CLI extensions".
