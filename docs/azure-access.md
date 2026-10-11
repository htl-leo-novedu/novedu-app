# Azure access, and the old environment on standby

> **Temporary document.** It exists while the old Azure environment is kept on
> standby as an emergency fallback. When that environment is decommissioned,
> move what is still true (profile handling, login, access checks) into
> `docs/azure-runtime-env.md`, then **delete this file and its entry in
> `AGENTS.md`**.

For every Novedu developer, and for Claude sessions working on a developer's
behalf. Read it before running any `az` command against either environment,
before changing how you run the app locally, and whenever a login has expired.

## Two environments

Novedu runs in a two-stage Azure Container Apps environment in the tenant of
HTL Leonding (`docs/azure-runtime-env.md`). A single App Service in a
different tenant and subscription is kept on standby.

| | Old environment (standby) | New environment (production) |
|---|---|---|
| Role | **Fallback only.** The Novedu app does not run. The App Service answers `novedu.at` with a temporary redirect to `app.novedu.at`; its database and file share keep the data exactly as it was when the app was stopped | **Production.** `app.novedu.at` (prod stage) serves users; `dev.novedu.at` (dev stage) holds a copy of the old environment's data |
| Hosting | App Service `novedu-chat-mvp-at`, RG `Novedu-Chat-MVP` | Container Apps, image from Azure Container Registry |
| Database | Postgres server `db-pgnovedu`, database `novedu` | Postgres server `psql-novedu`, databases `novedu_dev` / `novedu_prod` |
| Image files | share `novedu-files` in `stnoveduchatmvp` | share `novedu-files` per stage (`docs/azure-runtime-env.md`) |

The prod stage holds **no** copy of the old environment's data. That data
lives in two places — unchanged in the old environment, and as the copy in the
dev stage (`docs/azure-runtime-env.md`, "Data in the dev
stage").

What is still open: Azure Foundry in the new tenant (both stages run on SCCH
only), and decommissioning the old environment.

There is no infrastructure-as-code: the new environment is built from an ordered
runbook of `az` commands, dev first, prod as a replay. The design spec and the
runbook are working documents outside the repository (`docs/superpowers/specs`
is gitignored) — ask the developer leading the environment for them.

## Rules

- **Production is the prod stage.** Releases go through the pipeline: every
  publish deploys to dev, production follows through the manual `promote.yml`
  (`docs/azure-runtime-env.md`).
- **Leave the old environment alone.** Its database, file share and settings are
  the fallback, so nothing writes to them: no app, no local boot, no script. The
  only sanctioned changes are the redirect below and the rollback. Read-only
  commands are fine.
- **Local development runs against the dev stage's database** `novedu_dev`
  (`docs/database.md`), with the new profile. It holds real student and teacher
  data: never export it, and never copy anything further over "to try
  something".
- **Coordinate before you change anything in the new environment.** Without
  infrastructure-as-code, two people applying runbook steps at the same time
  collide silently. Read-only commands are always fine; anything that creates,
  changes or deletes a resource is agreed with the developer leading the
  environment first.
- **Group rights include prod.** Every member of the admin group is Owner of the
  prod resource group and Postgres admin on `novedu_prod` — which holds the real
  production data.
- **Never mix the two environments in one `az` profile** (below). A command
  that lands in the wrong tenant or subscription is the main operational risk.

## The old environment on standby

The App Service `novedu-chat-mvp-at` keeps the `novedu.at` binding and its
certificate, but instead of the Novedu image it runs a minimal nginx container,
`docker.io/rstropek/novedu-redirect:1`, built by hand from
`deploy/novedu-at-redirect/`. Every request is answered with a **302** to the
same path and query on `https://app.novedu.at` (plain HTTP first gets the App
Service's 301 to HTTPS). The redirect is temporary by intent: `novedu.at` is to
become a landing page, and its DNS is managed outside this project.

Its settings differ from the app's in exactly two values: the container image
and `WEBSITES_PORT=80` (the app used `3000`). `DOCKER_ENABLE_CI` is `false`, so
nothing redeploys it. Every other app setting and the `/novedu-files` mount are
left as they were.

**Rollback** — only in an emergency, and agreed with the developer leading the
environment. It revives the old app exactly at the state it was stopped in;
whatever was written on `app.novedu.at` since is not in it.

```bash
# default profile = the old tenant
az webapp config container set -n novedu-chat-mvp-at -g Novedu-Chat-MVP \
  --container-image-name docker.io/rstropek/novedu-chat-mvp:0.2.0.130
az webapp config appsettings set -n novedu-chat-mvp-at -g Novedu-Chat-MVP \
  --settings WEBSITES_PORT=3000 -o none
az webapp restart -n novedu-chat-mvp-at -g Novedu-Chat-MVP
```

The image is pinned to the version the old app last ran, which stays in the
Docker Hub repository `rstropek/novedu-chat-mvp`: a newer image would migrate
the old database forward.

## The new environment

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

## Two `az` profiles, never mixed

The `az` CLI keeps its login state in one directory, chosen by
`AZURE_CONFIG_DIR`. The new environment gets its own directory, and **every
developer uses the same one**, because the docs, scripts and agent instructions
in this repo rely on the name:

| Profile | `AZURE_CONFIG_DIR` | Logged in to |
|---|---|---|
| default | unset (`~/.azure`) | whatever you use otherwise — for developers with access to the old environment, its tenant |
| new environment | `~/.htl-azure-novedu` | tenant `91fc072c-…`, subscription `Novedu` |

The profile is selected **per command** by the environment variable; nothing is
ever switched globally, so a command without the variable can never reach the
new environment, and one with it can never reach the old:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az <command>
```

In a script or a multi-command shell block, `export AZURE_CONFIG_DIR=~/.htl-azure-novedu`
once at the top. Never run `az login --tenant 91fc072c-…` or `az account set`
for the new subscription in the default profile.

`AzureCliCredential` shells out to `az` and inherits the variable, so it also
decides which identity a locally running app uses. Local development reaches
`novedu_dev` in the new tenant, so the app's `.env` sets
`AZURE_CONFIG_DIR` to the **absolute** path of the new profile (`.env` does not
expand `~`) — see `docs/database.md`. Every Entra token the local app requests
then comes from the new tenant, including Azure Foundry's, which is why a local
`.env` leaves `AZURE_FOUNDRY_ENDPOINT` unset.

## Logging in

Only a human can log in — it is an interactive Entra sign-in with MFA. The
refresh token lives in the profile directory, so a login lasts across sessions
until it expires or is revoked.

### On a machine with a browser

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az login --tenant 91fc072c-edef-4f97-bdc5-cfb67718ae3a
AZURE_CONFIG_DIR=~/.htl-azure-novedu az account set --subscription 165b0053-6959-416b-9edf-aa3f82f3f270
```

### Over SSH (no browser on the machine running `az`)

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

## Verifying access

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

## CLI extensions

Extensions are installed **per profile**: the new-environment profile does not
see the ones in `~/.azure`. `az containerapp` works from the core CLI and needs
none. The extension this profile does need is `application-insights`, for any
`az monitor app-insights` command:

```bash
AZURE_CONFIG_DIR=~/.htl-azure-novedu az extension add -n application-insights
```

`az monitor log-analytics query` (for example the workspace's `Usage` table)
needs the preview extension `log-analytics`, which `az` installs on first use.

## What stays with a human

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
