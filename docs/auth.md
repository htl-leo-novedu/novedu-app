# Authentication, teacher roles & student mode

Deep reference for the auth subsystem. The always-on invariants are summarized in
`AGENTS.md`; this file has the full mechanics. Read it before touching `auth.ts`,
`lib/auth-*.ts`, `lib/demo-*.ts`, `lib/db/auth-mode-preflight.ts`, `NOVEDU_AUTH_MODE`,
`lib/session.ts`, `lib/db/auth-schema.ts`, `proxy.ts`, `app/sign-in/**`, `app/device/**`,
`lib/device-actions.ts`, sessions, teacher gating, or student mode.

This app is gated by **better-auth**, with Microsoft Entra ID (single tenant) as the
only sign-in provider of Entra builds — the default, and every image a stage runs. A
**demo build** replaces it with one-click sign-in as four seeded demo personas (see
"Demo mode" below); everything after the sign-in is the same in both. Key facts so
future runs don't have to rediscover the setup:

## The instance and its tables

- **`auth.ts`** (repo root, server-only) — the single `betterAuth({...})` instance,
  exporting `auth` and the `Session` type: a shared base (database, secret, sessions,
  cookies, user fields, plugins) plus exactly one mode block, `entraAuthOptions()`
  (`lib/auth-entra-options.ts`) or a demo build's `demoAuthOptions()` ("Demo mode").
  The Entra block is a factory, so its settings are read only when an Entra build
  builds the instance. The Entra provider reads `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` directly from `.env` (not a better-auth env
  naming convention). `overrideUserInfoOnSignIn: true` means name/email are overwritten
  from the Entra profile on every sign-in, through `mapProfileToUser`, which the provider
  spreads over `{ name, email, image, emailVerified }` on both the create and that
  override update:
  - **`name`** — the trimmed `name` claim, falling back to `preferred_username`, then
    `email`, then `oid`. `novedu_user.name` is NOT NULL and every name fallback in the app
    (`??`, `COALESCE`) treats `""` as a real name, so a nameless profile must not store an
    empty string.
  - **`email`** — the `email` claim, falling back to `preferred_username` (the
    tenant-unique UPN), then `<oid>@entra.invalid`. Without a fallback a profile carrying
    no email is rejected with `EMAIL_NOT_FOUND`.
  - **`image: null`** — the app never stores or shows an avatar (the status bar renders
    initials instead), and `disableProfilePhoto: true` also skips the provider's Microsoft
    Graph photo fetch, an untimed extra request on every callback. `user.image` is
    therefore always null: nothing in the app reads it.
- **`given_name`** — a server-owned column beside `name`, NOT set by `mapProfileToUser`:
  better-auth drops every `input: false` field from that mapping's result, so the
  account hook that writes `is_teacher` (below) writes it too, from the ID token's
  `given_name` claim on every sign-in (`lib/given-name.ts`; trimmed, `NULL` when the token
  carries none). It is an optional claim, so both app registrations request it
  (`docs/azure-runtime-env.md`). The start page greets with it; `name` is the directory
  display name, which in the school tenant lists the surname first, so the greeting never
  takes a word of `name` and says a plain "Welcome back" without a given name.
- **Account linking by email.** `account.accountLinking` sets
  `trustedProviders: ["microsoft"]` and `requireLocalEmailVerified: false`, so an Entra
  identity whose `oid` is not yet in `novedu_account` links to the existing `novedu_user`
  row carrying the same email instead of creating a second one. **Both** options are
  required: Entra ID tokens carry no `email_verified` claim, and the app's own rows have
  `email_verified = false`. This is safe **only while the Entra app is single-tenant** —
  the tenant owns every email it can present. Revisit it before admitting a second tenant,
  where one tenant could claim another's address.
- **`update-user` is disabled.** `disabledPaths: ["/update-user"]` makes
  `/api/auth/update-user` answer `404` for everyone. Display names are the app's, taken
  from the Entra profile at every sign-in, and teacher-facing lists resolve user ids
  through `novedu_user.name` — a user rewriting their own name would rewrite what teachers
  see.
- **Route handler:** `app/api/auth/[...all]/route.ts` hands `GET`/`POST` to
  `toNextJsHandler(auth)` — every better-auth endpoint (`/api/auth/*`, incl. the sign-in
  callback and the device-flow endpoints below) lives behind this one catch-all route.
  A demo build answers only its allowlist there ("Demo mode").
- **Five database tables**, all in the app's `novedu_` naming inside `public`, defined
  by hand in `lib/db/auth-schema.ts` (a maintained mirror of better-auth's own schema —
  the header comment there explains how to check it after a better-auth upgrade) and
  wired to the instance via `user.modelName` / `session.modelName` / `account.modelName`
  / `verification.modelName` / the `deviceAuthorization` plugin's `schema` option:
  - **`novedu_user`** — one row per signed-in person: `id`, `name`, `email` (unique),
    `email_verified`, `image` (always null), `created_at`, `updated_at`, and the app's
    own `is_teacher` and `given_name` fields (see below). This is the id every `user_id`/`created_by`
    column across the `novedu_*` tables stores by value.
  - **`novedu_session`** — one row per live session: `id`, `expires_at`, `token`
    (unique), `created_at`, `updated_at`, `ip_address`, `user_agent`, `user_id` (FK to
    `novedu_user.id`, cascade). Both auth channels (browser cookie, CLI/API bearer) share
    this table.
  - **`novedu_account`** — the link to the identity provider: `id`, `account_id`,
    `provider_id`, `user_id` (FK, cascade), the OAuth token columns
    (`access_token`/`refresh_token`/`id_token`/…), `scope`, `created_at`, `updated_at`.
    One row per `(provider_id, account_id)` pair.
  - **`novedu_verification`** — better-auth's short-lived OAuth state during a sign-in
    round trip. Transient: written at the start of a flow, consumed at its end.
  - **`novedu_device_code`** — the device-authorization plugin's table, one row per CLI
    sign-in attempt (`device_code`, `user_code`, `user_id`, `status`, `client_id`, …). No
    foreign key on `user_id` — the row is deleted on redemption/denial and never joined
    for display.
  - The **two foreign keys** — `novedu_session.user_id` and `novedu_account.user_id`,
    both `→ novedu_user.id ON DELETE CASCADE` — are the only foreign keys anywhere in
    the `novedu_*` space; there are still none between `novedu_*` and `mastra_*`
    (`docs/database.md`).

## Sessions

- **Database-backed, no cookie cache.** Every `getSession()` call goes to the database (an
  indexed query on `novedu_session.token`, plus the user row) — there is no `session_data`
  cookie, only `session_token`. That means a sign-out or a changed `is_teacher` value takes
  effect on the very next request, on both channels, with no staleness window to reason
  about. `getSession()` (`lib/session.ts`) is wrapped in React's `cache()`, so the several
  callers of one render (the page, the status bar, the student-mode helpers) share a single
  lookup per request.
- **A FIXED 30-day window.** `session.expiresIn = 30 days` with
  `session.disableSessionRefresh: true`: a session is never extended, so everyone signs in
  again 30 days after signing in. Refreshing is not an option worth having here — it emits
  a session `Set-Cookie`, which `nextCookies()` writes into whatever response is being
  built, including a BEARER route's (planting the CLI caller's session in the browser that
  happened to trigger it); and a Server Component cannot write a cookie at all, so half the
  cookie channel could not renew anyway.
- **Cookie names.** `advanced.cookiePrefix` is `novedu`, so the session cookie is
  `novedu.session_token` under an `http` base URL and `__Secure-novedu.session_token`
  under `https` (the `__Secure-` prefix is a browser-enforced guarantee that the cookie was
  only ever set over TLS). The app's own prefix also keeps another better-auth app on
  `localhost` — cookies ignore ports — from writing over this app's session cookie.
  `proxy.ts`'s presence check (`getSessionCookie` from `better-auth/cookies`, given the
  same prefix) reads either name. The value is `${token}.${signature}`, URL-encoded, where
  the signature is an `HMAC-SHA256` of the RAW token under `AUTH_SECRET` in standard,
  PADDED base64 (44 characters), as `makeSignature` from `better-auth/crypto` produces it.
  It is the only cookie better-auth sets here: the OAuth state of a sign-in round trip
  lives in `novedu_verification`, not in a cookie, because the instance has a database.
- **`AUTH_URL`.** Unset locally: better-auth infers the base URL from the request.
  Each Azure stage sets `AUTH_URL` to its public base URL (`https://app.novedu.at/api/auth` on prod;
  a value that already carries the `/api/auth` path is used as-is, a bare origin gets it
  appended) — that is what better-auth treats as its `baseURL` **and** as a trusted origin, so a POST from the real browser (the `/device`
  approve/deny actions, for instance) passes better-auth's origin check. It is also what
  decides the cookie's host scope. Sign-in breaks if it names the wrong host.

## The user id

The session user id is **`novedu_user.id`** — never the Entra `oid` directly, though the
two coincide for the user rows that migrations seed: those carry the Entra `oid` as their
id (the value their `novedu_codes.created_by`, `novedu_user_chats.user_id`, etc. hold),
and the `oid` itself is kept in `novedu_account.account_id` either way (that is what
makes a seeded, oid-keyed user row link to the right identity on its first sign-in —
the callback matches by `(provider_id, account_id)`, so the placeholder seed email
never matters). A person signing in for the first time gets a random 32-character id.
Nothing that joins on the user id needs to know or care which case it is: it is always
`novedu_user.id`, by value, everywhere.

## Teacher role

Finer-grained access is by Entra **group** membership, but the result is a plain
**server-owned column**, not something read off the token per request:

- The Entra group whose members are teachers is `TEACHER_GROUP_ID` in `.env`. It is a
  Microsoft 365 group, not a security group, so the app registration must emit it in the
  `groups` claim: `groupMembershipClaims` is `All` (or `ApplicationGroup` with the group
  assigned to the application) — under `SecurityGroup` it never appears and every teacher
  signs in as a student.
- `applyIdTokenClaims` in `lib/auth-entra-options.ts` is a `databaseHooks.account.create.after` /
  `account.update.after` hook — it runs on the **account** row, once for a brand-new
  identity and again on every later sign-in of an existing one (including the seeded
  account's first sign-in), reading the fresh `id_token` better-auth has just stored
  there. `lib/teacher.ts`'s `teacherFromIdToken(idToken, TEACHER_GROUP_ID)` decodes the
  token's payload (no signature check needed — the token arrived over TLS straight from
  Entra's own token endpoint) and looks for the group id in the `groups` claim, and the
  hook writes the result to `novedu_user.is_teacher` — in the same update as
  `given_name` (above).
- The hook runs **before** the session is created, so the very next `getSession()` after
  a sign-in already reflects the new role — there is no "stale until re-sign-in" gap.
- **Server-owned, fail-closed.** `additionalFields.isTeacher` on the `user` config sets
  `input: false`, so `is_teacher` can never be set through the API — and
  `/api/auth/update-user`, the endpoint that would carry it, is disabled outright (above)
  — in an Entra build the hook is the only writer at runtime. (Two other writers
  exist outside it: a demo build's persona seed, which replaces the hook there, and the
  e2e principal minting, which writes the rows directly — `docs/testing.md`.) A failure inside the hook (a DB hiccup, a malformed token) is caught
  and logged; the flag simply keeps its previous value, which for a brand-new user is
  `false` — fail closed, never fail open.
- **Group overage.** When a user belongs to too many groups to fit in the token, Entra
  drops the `groups` array and substitutes a `_claim_names`/`_claim_sources` pointer.
  `resolveTeacher` reports this as `overage` and **fails closed** (not a teacher) —
  resolving it for real would need a Microsoft Graph call, which is not implemented.
  Prefer "Groups assigned to the application" in the Entra app registration to avoid it.
- Gate teacher-only server actions / route handlers with **`requireEffectiveTeacher()`**
  from `lib/student-mode.ts` (throws → respond 403); it honors student mode (below).
  `requireTeacher()` in `lib/session.ts` checks only the raw role and exists to gate
  entering student mode itself; the CLI/API bearer routes, which have no student mode,
  read the same column through `requireBearerTeacher()` (`docs/api.md`).

## The gate

- **`proxy.ts`** at the repo root checks that a session cookie is **present**, with **no
  signature check and no database call**: `getSessionCookie` from `better-auth/cookies`,
  given the same `cookiePrefix: "novedu"` as `auth.ts`, reads either cookie name and the
  proxy redirects when there is nothing. No cookie ⇒ bounce to `/sign-in`, carrying the
  path it wanted as `?callbackURL=`. The prefix is a repeated literal rather than an
  import: importing `auth.ts` here would drag the database pool and the provider
  credentials into the gate, so the **two literals must be kept in sync**.
- **What it cannot catch:** any cookie whose value does not resolve to a live session — a
  garbage or foreign one, and a genuine one whose `novedu_session` row is gone (deleted or
  expired). Telling them apart needs work the gate deliberately does not do. Such a request
  passes and the page renders **signed-out**; the status bar then shows a **"Sign in"**
  link instead of the user menu (`components/user-menu.tsx`), which is the way back. The
  layout never redirects, which is also why `/sign-in` is excluded from the matcher below.
- It is **not** the authorization boundary — every page, server action and route handler
  behind it re-establishes the session itself
  (`getSession()`/`requireEffectiveTeacher()` on the cookie channel, `requireBearerUser()`
  on the CLI/API channel), so a cookie without a live session buys nothing but a render it
  could have had anyway.
- The matcher excludes: the better-auth endpoints themselves (`api/auth`, needed to sign
  in and to run the device flow the CLI polls), `/sign-in` (redirecting it to itself
  would loop), the public `/api/version` build-identity probe, the public `/api/files`
  YAML-hosting GET, the public `/api/coding` routes (gated by the per-user API key —
  `docs/coding.md`), the CLI/API bearer routes (`/api/me`, `/api/codes`, `/api/reports`,
  `/api/images`, `/api/eval` — each self-gates via `requireBearerUser`/`requireBearerTeacher`,
  `docs/api.md`), and static assets. The former teacher-guide paths `/docs/*` need no
  exclusion: `next.config.ts` 308-redirects them to docs.novedu.at, and redirects run
  before the proxy (`docs/teacher-docs.md`). `GET /api/image-content/<id>` — the
  route that serves app-hosted image bytes — is deliberately NOT excluded: it uses
  the normal cookie session, stays behind this gate like any page, and its handler
  calls `getSession()` itself on top of that. It applies no further authorization
  beyond a live session — no teacher check, no `checkCode()`, no thread token —
  because teacher-hosted images are shared authenticated assets, not per-code
  resources (`docs/images.md`).
- **`/sign-in`** (`app/sign-in/page.tsx`, server) reads `callbackURL` and `error` from
  the query, validates the callback is an app-relative path (it must start with `/`, and
  its second character may be neither `/` nor `\` — `//host` and `/\host` are both
  protocol-relative to a browser, which would turn the sign-in into an open redirect), and
  renders a generic error line when `error` is set alongside `<SignInButton
  callbackURL=…/>`. It is one of the two screens that render **without the app chrome**
  (`components/app-chrome.tsx`, `docs/styling.md`), so it carries the product name itself
  and centres its card in the full viewport — there is no status bar offering a burger
  menu to a visitor who is not signed in, and no second "Sign in" control. The client button (`app/sign-in/sign-in-button.tsx`) calls
  `authClient.signIn.social({ provider: "microsoft", callbackURL, errorCallbackURL:
  "/sign-in?error=1" })` — a failure inside the round trip comes back to that error URL.
  Only a failure to START the redirect needs handling client-side (success navigates
  away), and it arrives in two shapes the button treats alike: `signIn.social` RESOLVES
  with `{ error }` on a non-2xx (better-fetch throws only when configured to) and rejects
  on a network error. Both re-enable the button and render one inline "Sign-in failed"
  line, so it never sticks on "Signing in…". A demo build renders the demo persona
  buttons in that card instead ("Demo mode"); the callback validation and the error line
  are shared.

## Sign-out

The Microsoft provider in `lib/auth-entra-options.ts` sets `prompt: "login"`, so every new browser
sign-in requests fresh Entra authentication even when a Microsoft SSO session is
already active. This protects the shared-computer flow: after a teacher signs out,
clicking sign-in must not silently sign the next person in as that teacher. Existing
Novedu sessions retain their fixed 30-day lifetime.

`lib/auth-actions.ts`'s `signOutAction` (a server action, wired to the sign-out button
in the user menu) deletes the student-mode cookie first (it applies only to the session
that set it anyway — "Student mode" below) — then calls `auth.api.signOut({ headers: await headers() })`, which deletes the
session row and clears the cookie, and redirects to `/sign-in`. This ends the Novedu
session only; it does not sign the browser out of Microsoft.

## `/device`

Where a person approves the command line's sign-in request. The CLI always prints a
complete link carrying its code (`/device?user_code=…`), so the page never asks anyone
to type one — without a code in the URL there is nothing to show.

- Visiting `/device?user_code=…` while signed in **claims** the code for that user via
  `auth.api.deviceVerify` — this is mandatory: `deviceApprove`/`deviceDeny` fail with
  "not claimed" unless the same signed-in user first viewed the code through this GET.
  That claim is also what makes approving possible for only the person who opened the
  link: someone else opening it sees the code's status with no client id and no buttons
  (rendered the same as an unknown/expired code).
- A **pending, claimed** code renders the requesting client's id, the signed-in
  account's name and email, a warning to approve only a code requested on the viewer's
  own machine a moment ago, and Approve/Deny buttons.
- The two decisions are server actions (`lib/device-actions.ts`,
  `deviceApproveAction`/`deviceDenyAction`) calling `auth.api.deviceApprove`/`deviceDeny`
  with `headers: await headers()` — no cookies are set, so the page stays server-only;
  each redirects back to `/device` with the outcome in the query
  (`?done=approved|denied` or `?error=1`).
- **No manual code-entry form.** The CLI always hands out the full link, so a bare visit
  to `/device` renders one line pointing back at it.
- The page is app-owned and styled like the rest — no Entra wording anywhere in it.

## Two auth channels

The app authenticates callers in exactly two ways; every server entry point uses one or
the other, never both:

1. **Browser cookie sessions** (this doc): the better-auth session cookie, the
   `proxy.ts` gate, `session.user`, teacher gating via `requireEffectiveTeacher()` — the
   channel for everything a human uses in the browser.
2. **CLI / API session-token bearer** (`docs/api.md`): the same session token, sent as
   `Authorization: Bearer …`, validated per request by `lib/api-auth.ts`
   (`requireBearerUser`/`requireBearerTeacher`) through `auth.api.getSession` — routes
   excluded per-path from the proxy matcher. **Only** the `Authorization` header is
   forwarded to better-auth, so a browser cookie can never authenticate this channel.
   Same identity model — `novedu_user.id` is the user id and `is_teacher` is the same
   server-owned column — but **no cookie and no student mode** (that is a cookie): the
   bearer path always sees the caller's real role.

The teacher-gating rule therefore splits by channel: cookie surfaces use
`requireEffectiveTeacher()`, bearer routes use `requireBearerTeacher()`.

## User display names

Every surface that shows a user id resolves it to a human name through
**`novedu_user.name`** — the value overwritten from the Entra profile on every sign-in
(exactly what the status bar shows for that person). There is no separate write path to
maintain: better-auth itself keeps `name` current as part of the sign-in it already
performs (`overrideUserInfoOnSignIn: true`), so there is nothing here analogous to a
per-request upsert.

- **Read — by LEFT JOIN, with a raw-id fallback.** Every surface that shows a user id
  resolves it in the SAME query that loads the rows: `ownerJoin`/`ownerLabel`
  (`lib/db/owners.ts`, shared by the teacher list pages), `listSavers`
  (`lib/writing-store.ts`), `getCodeStats` (`lib/code-stats-store.ts`), and `listReports`
  (`lib/report-store.ts`, backing the teacher **reports inbox** at `/reports` —
  `docs/reports.md`) LEFT-JOIN `novedu_user` BY VALUE (no FK), and the writing student
  page reads the name off the savers row it already loads. A missing row (an id that has
  never signed in through the web app, e.g. an old orphaned id) ⇒ `null` ⇒ the raw id is
  shown, kept as the element `title` so it's still visible on hover. The savers filter
  matches name **or** id.
- **No garbage collection.** Rows are never deleted — module-agnostic, so a deleted code
  never touches them. Anonymity is respected for free: a name is only ever shown where
  the id already is (`getCodeStats` nulls both for anonymous codes). The **one
  deliberate exception** is the reports inbox: a student who files a report waives their
  own anonymity by an explicit, on-form action, so `novedu_reports.user_id` (and the name
  resolved from it) is surfaced to the teacher even on an anonymous code — the store
  never reveals any *other* student, though (`docs/reports.md`).

## Student mode

A real teacher can temporarily view the app as a student ("View as student" in the
user menu). State = httpOnly session cookie `student-mode` (`lib/student-mode.ts`)
whose value is the id of the Novedu session that entered the mode; it applies only
while that session is the current one, so a new sign-in never inherits it — not after
an expired session, a reset database, or a browser that restored its session cookies
(and a `localhost` cookie spans every port, so a stale one from another local Novedu
would otherwise apply). It only RESTRICTS, never grants, so it is unsigned. Sign-out
also deletes it (`lib/auth-actions.ts`). Derive ALL
teacher gating/display from **`getTeacherView()`** (or the `isEffectiveTeacher()` /
`requireEffectiveTeacher()` shorthands) in `lib/student-mode.ts` — NOT from
`session.user.isTeacher` / `requireTeacher()` directly, which ignore the mode
(`tests/unit/teacher-gate.test.ts` confines both to an allow-list of files).
`requireTeacher()` (`lib/session.ts`) remains the real-role check and gates ENTERING the
mode (`lib/student-mode-actions.ts`); exiting is ungated (the visible "Student
mode" pill in the status bar carries the Exit control). Kept out of `auth.ts` because
`proxy.ts` only checks that a session cookie is present and never imports `auth.ts`, and
student mode is app policy layered on top of a session rather than part of the auth
instance itself.

The family, all in `lib/student-mode.ts`:

| Export | Use |
| --- | --- |
| `teacherViewForSession(session)` | THE rule ("real teacher AND not simulating") → the triple, for a session the caller ALREADY has |
| `effectiveTeacherForSession(session)` | the rule's boolean half, same session-taking form |
| `getTeacherView()` | the `{ realTeacher, studentMode, effectiveTeacher }` triple — calls `getSession()` itself |
| `isEffectiveTeacher()` | boolean shorthand over `getTeacherView()` |
| `requireEffectiveTeacher()` | the throwing gate for teacher-only server work |
| `requireTeacherUserId()` | `requireEffectiveTeacher()` + the session user id, returned as `{ ok }` instead of thrown |
| `isStudentMode(session)` | the raw cookie read: does the cookie name this session? |

Every other export **delegates to `teacherViewForSession`**, so the rule has
exactly one definition, and that function is the only student-mode-aware reader
of the raw `session.user.isTeacher` claim (`requireTeacher()` in `lib/session.ts` reads
it only to gate entering the mode; the bearer channel, which has no student mode, reads
`is_teacher` through `requireBearerTeacher()` — `docs/api.md`). Reach for
a session-taking form only on a hot path that already called `getSession()` and would
otherwise look the session up twice — today that is the chat runtime route,
which gates reasoning display on it (`docs/chat.md`); both take `Session | null`
and treat `null` as a non-teacher.

The cookie NAME lives in `lib/student-mode-constants.ts` (re-exported from
`lib/student-mode.ts`), an import-free module so the Playwright specs — which set
the cookie directly and cannot load `next/headers` — spell it from one source. They
build it with `studentModeCookie(context)` (`e2e/principal.utils.ts`), which looks up
the context's session id.

## e2e session minting

e2e tests bypass interactive login entirely: `e2e/auth.setup.ts` upserts the test
principals directly into `novedu_user` (name, email, `is_teacher`) through `e2e/db.ts`,
inserts a `novedu_session` row for each (a random token, `expires_at` a day out), and
mints the matching cookie value through `e2e/session-cookie.ts` — `${token}.${sig}`
URL-encoded, the signature from better-auth's own `makeSignature` (`better-auth/crypto`,
async), stored under the `novedu.session_token` cookie name from `e2e/auth.constants.ts`
(`secure: false`, `Lax`, `localhost`, matching a local `http` server). Nothing on the test
side re-implements the format, so a minted cookie resolves to a session for the same
reason a real one does. Playwright `storageState` then injects it, exactly like the real
cookie better-auth would have set. `e2e/sign-in.spec.ts` mints from the same helper for
the cookies that resolve to nothing — a garbage value and a correctly signed one with no
session row — and asserts both reach `/` and render the "Sign in" link. Real auth stays
ON everywhere else; this only proves the gate lets a valid session through. Two states are
minted: a student (default,
`STORAGE_STATE`) and a teacher (`TEACHER_STORAGE_STATE`, `is_teacher: true`) —
teacher-only specs opt in via `test.use({ storageState: TEACHER_STORAGE_STATE })`. The
bearer-channel equivalent, `mintSessionToken` in `e2e/api-auth.utils.ts`, does the same
upsert-plus-session-row dance but returns the raw token for use as a bearer header
(`docs/api.md`, `docs/testing.md`).

## Demo mode

A **demo build** signs people in without Entra: the sign-in page offers two demo
teachers and two demo students, one click each. It exists for evaluators, training
setups and contributors who have no Entra app registration. After sign-in nothing
differs — the teacher role from `novedu_user.is_teacher`, the same database sessions,
student mode, sign-out, and the CLI device flow. "Demo" is an openly labelled
replacement: the sign-in page and an undismissable ribbon say that anyone who can reach
the instance can sign in as anyone. Because it is a sign-in bypass, it exists **only in
demo builds**, and each database belongs to exactly one mode.

### The switch: `NOVEDU_AUTH_MODE`, frozen at build time

- **`NOVEDU_AUTH_MODE`** is `entra` (also when unset or empty) or `demo`. It is read in
  one place, `next.config.ts` (through `parseAuthMode` in `lib/auth-mode.ts`), which
  fails `next build` / `next dev` on any other value and on a set
  `NEXT_PUBLIC_NOVEDU_AUTH_MODE`, and **always** re-emits the normalized value through
  `nextConfig.env`. Next inlines every `config.env` entry at build time, in server and
  client code alike — unlike a `NEXT_PUBLIC_*` variable, which it inlines only when it is
  set at build time, so an unset one would leave a live runtime lookup.
- Every branch site compares the literal `process.env.NOVEDU_AUTH_MODE === "demo"`, which
  folds to a constant, so each build carries only its own mode's code. The demo-only
  modules (`lib/demo-personas.ts`, `lib/demo-boot.ts`, `lib/demo-seed.ts`,
  `lib/auth-demo-allowlist.ts`, `app/sign-in/demo-sign-in.tsx`,
  `components/demo-ribbon.tsx`) load only through `await import()` inside such a branch.
  The one static import is `demoAuthOptions()` (`lib/auth-demo-options.ts`), because
  `betterAuth({...})` is built synchronously; it is inert configuration with no password
  and no persona data. `tests/unit/auth-mode-guard.test.ts` confines the variable to its
  files, pins the literal comparison, and rejects static imports of the demo modules.
- **Frozen per process.** A built image keeps the mode it was built with: setting
  `NOVEDU_AUTH_MODE` at runtime changes nothing. `next dev` evaluates `next.config.ts`
  once at startup, so editing the mode in `.env.local` while it runs changes nothing
  either — **changing the mode needs a dev-server restart.**
- Contributors set `NOVEDU_AUTH_MODE=demo` in `.env.local` for `npm run dev`, together
  with **empty** `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` and
  `TEACHER_GROUP_ID` lines (an empty `.env.local` value wins over `.env`) and a
  `DATABASE_URL` naming a database of its own (below).
- The published images (`ghcr.io/htl-leo-novedu/novedu-app`, a public package): the
  production image is an Entra build; the `:demo` tag is the demo build of the same
  commit (`README.md`, `docs/ci-security.md`).
- **`compose.yaml`** (repo root) is the ready-made way to run the `:demo` image: a
  Postgres database of its own, the fake LLM as SCCH, a provisioned image root, ports on
  loopback only and no Entra setting (README, "Try Novedu locally"). Contributors start
  only its `postgres` and `fake-llm` services for `npm run dev`.

### The auth instance in a demo build

`demoAuthOptions()` is merged into the shared base by `mergeAuthOptions`
(`lib/auth-options-merge.ts`) — explicitly, not a shallow spread: `account` options merge
one level deep (the shared `account.modelName` survives), `disabledPaths` concatenate,
and any other key set on both sides throws. The demo block:

- `emailAndPassword: { enabled: true, disableSignUp: true }` — sign-in only.
- `rateLimit.customRules["/sign-in/email"] = { window: 60, max: 100 }`. better-auth
  rate-limits in production by default, at 3 sign-ins per 10 s per IP, and a class
  behind one NAT or one Docker port mapping shares one IP. The password is public, so
  throttling protects nothing; the cap only bounds the scrypt CPU an abuser can burn.
- It calls the env lock (below) and throws on a refusal — a second line behind the boot.

In an Entra build `emailAndPassword` stays off: `POST /api/auth/sign-in/email` answers
`400 EMAIL_PASSWORD_DISABLED`.

### The HTTP surface: an allowlist

The personas are shared by everyone who can reach the instance, so every better-auth
endpoint that touches a user's own account or sessions would leak between visitors
(`/list-sessions` hands out the others' session tokens, `/revoke-sessions` signs everyone
out, `/change-password` locks everyone out). In a demo build the catch-all route answers
only `lib/auth-demo-allowlist.ts`'s **allowlist** and returns `404` for everything else,
before better-auth's router runs:

- `POST /sign-in/email`, `POST /sign-out`, `GET /get-session`;
- `POST /device/code`, `POST /device/token` — the CLI's device flow. Viewing, approving
  and denying a code happen server-side on `/device` through `auth.api.*`, which never
  passes through the route.

The match is exact on method and path, normalized the way better-auth's router does it
(`/api/auth` stripped, trailing slashes removed). `lib/auth-demo-allowlist.unit.test.ts`
enumerates every HTTP endpoint the installed better-auth exposes on this instance against
a reviewed list, so a better-auth bump that adds one fails until someone classifies it.

### One mode per database: the provenance preflight

better-auth resolves a session from its row without asking how it was created, so an
Entra build pointed at a demo database would keep honouring the demo sessions and bearer
tokens — and a demo build pointed at real data would let anyone in as whoever it seeds.
Both builds therefore run `lib/db/auth-mode-preflight.ts` at boot, **read-only and
before migrations** (so a wrong configuration never writes DDL to the wrong database):

- no `novedu_account` table yet → a fresh database, accepted;
- an **Entra build** refuses any `credential` account (a demo persona);
- a **demo build** refuses any account of another provider (someone ever signed in
  through a real identity provider, e.g. a copy of `novedu_dev`). The e2e principals are
  user and session rows **without** account rows, so a database the e2e suite ran
  against keeps booting in either mode.

A refusal fails startup with the mode, the reason and the remedy: a separate database.
Like any failure in `instrumentation.ts` (a failed migration, say), it fails Next's
instrumentation hook: the process logs the error and stays up, but answers **every**
request with `500` — nothing is served, sign-in included. The env lock below fails the
same way.
A contributor who runs both modes locally needs two databases. A future sign-in method
that creates `credential` accounts in an Entra build (an email-code login, say) has to
revisit this check together with it.

### The env lock

`demoBootRefusal` (`lib/demo-env-lock.ts`) refuses a demo build, before any database
work and also when `DATABASE_URL` is unset, when:

- any of `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `TEACHER_GROUP_ID`
  is set to a non-empty value;
- `AUTH_URL`'s host is `novedu.at` or ends in `.novedu.at` (lower-cased, a trailing dot
  removed — ports and `app.novedu.at.` are caught, `novedu.at.example.com` is not);
- `AUTH_URL` does not parse (fails closed).

It runs at boot (`startDemoBoot`, `lib/demo-boot.ts`) and again when the auth instance is
built — which also happens during `next build`, so a demo **build** refuses the Entra
settings too (the Dockerfile sets its Entra placeholders for Entra builds only). Accepted
false positives: `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` exported globally in a shell, or a
contributor `.env` with Entra values — blank them in `.env.local`.

### The personas and the seed

`lib/demo-personas.ts` (client-safe; the sign-in buttons need it):

| user id | account id | name | email | role |
| --- | --- | --- | --- | --- |
| `demo-teacher-1` | `demo-teacher-1-credential` | Anna Berger | `anna.berger@demo.novedu.invalid` | teacher |
| `demo-teacher-2` | `demo-teacher-2-credential` | Lukas Huber | `lukas.huber@demo.novedu.invalid` | teacher |
| `demo-student-1` | `demo-student-1-credential` | Mia Gruber | `mia.gruber@demo.novedu.invalid` | student |
| `demo-student-2` | `demo-student-2-credential` | Noah Wagner | `noah.wagner@demo.novedu.invalid` | student |

The given name is the first word of the name. Two teachers show that a teacher's codes
are scoped to their creator; two students show the per-student views. `DEMO_PASSWORD`
(`novedu-demo-login-not-a-secret`) is public by design.

A demo build's boot, in order (`instrumentation.ts`): the env lock, the log line
`instrumentation: auth mode DEMO — one-click demo accounts, no Entra` (an Entra build
logs `instrumentation: auth mode Entra ID`), the preflight, migrations and Mastra
storage, then **the seed** (`lib/demo-seed.ts`) — one transaction under a fixed
`pg_advisory_xact_lock`, because a dev server may boot twice concurrently:

- upserts the four `novedu_user` rows by id (`name`, `given_name`, `email`,
  `email_verified = true`, `is_teacher`, timestamps);
- upserts the four `credential` accounts by their fixed id, with `account_id` = the
  user id — better-auth's email sign-in accepts only `provider_id = 'credential'` with
  `account_id = user.id`, and `novedu_account` has no unique index on
  `(provider_id, account_id)`, so the fixed primary key is what makes the upsert
  repeatable;
- keeps the stored password hash when `verifyPassword` accepts it and re-hashes
  (`hashPassword`, `better-auth/crypto`) only otherwise — scrypt salts randomly;
- aborts, naming the email, when a persona email belongs to a row with a different id —
  no silent takeover.

Every boot resets drift (a changed role, name or password). In a demo build the seed is
the only runtime writer of the personas' `is_teacher`; the Entra account hook is not
registered.

### What a visitor sees

- **`/sign-in`** renders `DemoSignIn` (`app/sign-in/demo-sign-in.tsx`): the heading
  "Sign in as a demo person", a line saying that anyone who can open the page can sign in
  as any of these people, and one button per persona ("Anna Berger · Teacher"), each
  calling `authClient.signIn.email({ email, password: DEMO_PASSWORD, callbackURL })`.
  Failures are handled like `SignInButton`'s: a resolved `{ error }` and a rejection both
  re-enable the buttons and show one "Sign-in failed" line.
- **The DEMO ribbon** (`components/demo-ribbon.tsx`) replaces the hostname-based
  environment ribbon in the root layout: rendered on the server (in the first HTML, no
  hydration-time hostname logic), with no "×" and blind to the dismissal key the other
  ribbon honours, so a tab that once hid LOCAL still sees DEMO. It sits outside
  `AppChrome`, so `/sign-in` and `/device` show it too. Both ribbons share
  `components/ribbon-frame.tsx`.
- After sign-in: the greeting by given name, teacher or student home, student mode,
  sign-out back to `/sign-in`, and `novedu login --server http://localhost:3000`
  approved at `/device` by a signed-in persona.

### Build markers

Two literals only a demo build uses at runtime — `DEMO_PASSWORD` and the demo boot log
line — identify a demo build's compiled output. `scripts/ci/check-demo-markers.mjs <dir>
--expect absent|present` reads both from source (so it never passes vacuously) and greps
only compiled output: `.next/server` and `.next/static`, and in a standalone tree or an
image `server.js` + `.next/server` + `.next/static` — never `.next/dev` or `.next/cache`,
where a local demo `npm run dev` leaves demo chunks. CI expects them absent from every
Entra build and image and present in the demo ones (`docs/testing.md`,
`docs/ci-security.md`). The behavioural proof that an Entra build has no email sign-in is
the e2e assertion on `sign-in/email`, not the grep.
