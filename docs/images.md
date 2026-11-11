# App-hosted Images

Deep reference for the **module-agnostic image subsystem**: teachers upload PNG /
JPEG / SVG images *in the app* and reference them by name from quiz YAML (one
optional image per question). The bytes live under a configured filesystem root
(`IMAGE_STORAGE_ROOT`) and are served by the app itself through the
**same-origin, cookie-session** route `GET /api/image-content/<id>` — there is
NO direct-to-storage traffic and no signed URL of any kind. The always-on
invariants are summarized in `AGENTS.md`; this file has the full mechanics.
Read it before touching `app/images/**`, `app/api/images/**`,
`app/api/image-content/**`, `lib/image-store.ts`, `lib/image-fs.ts`,
`lib/image-service.ts`, `lib/image-resolve.ts`, `lib/image-ref.ts`,
`lib/relative-url.ts`, `lib/images-actions.ts`, `lib/bounded-form.ts`,
`components/content-image.tsx`, `components/image-lightbox.tsx`, the image
helpers in `lib/file-name.ts`, or the `novedu_images` schema.

## Four layers

The subsystem is split so an image flows from upload to render through four
independent seams; a module only ever sees the top one.

**Layer 1 — storage** (`novedu_images` + `lib/image-store.ts` + `lib/image-fs.ts`):
metadata in SQL, bytes under the configured filesystem root. `lib/image-fs.ts` is
the ONE place the app touches that filesystem; `lib/image-store.ts` is the ONE
place it touches the table.

**Layer 2 — the management surface** (`/images`): teacher-only list + upload +
delete, mirroring `/files`.

**Layer 3 — the resolution primitive** (`ImageRef` → `resolveImageRef` →
`ResolvedImage`, plus the pure `resolveRelativeUrl`): turns a reference a module
embedded into a usable URL.

**Layer 4 — the display component** (`<ContentImage>`): a client component that
renders a `ResolvedImage` as a bounded thumbnail opening the shared
`<ImageLightbox>` (`components/image-lightbox.tsx`) — the same lightbox the
`/images` list's "View" button opens.

## Surfaces

| Surface | Path | Who | Notes |
| --- | --- | --- | --- |
| List | `/images` (`app/images/page.tsx`) | teacher | active versions only, contains-filter over name + an **owner** dropdown (the signed-in teacher by default); a row's "View" button opens the image in the shared lightbox from its `/api/image-content/<id>` URL (no inline thumbnail) |
| Upload | `/images/new` (`upload-image-form.tsx`) | teacher | name + file picker; ONE server-action POST carrying the bytes |
| Bearer API / CLI | `GET /api/images`, `POST /api/images/<name>` (`app/api/images/**`) | teacher (bearer token) | the CLI's `images upload/list` over `lib/image-service.ts`; see below and `docs/api.md` |
| Read | `GET /api/image-content/<id>` (`app/api/image-content/[id]/route.ts`) | any signed-in user | cookie-session byte route; see "Read route" below |

Both pages gate with **`requireTeacherPage()`** ("effective" teacher — student
mode is denied); the bearer routes gate with **`requireBearerTeacher()`**
(`lib/api-auth.ts` — no student mode on that channel). There is no edit
surface: an image is immutable once uploaded; to change it, delete and
re-upload (the name is reusable).

## Data model — `novedu_images` (temporal / append-only)

Mirrors `novedu_files` (see `docs/files.md`). Each row is **one version** of one
image; the row holds **metadata only** — the bytes live under the storage root,
addressed by `blob_path`. The image's stable identity is its **`name`** (the
surrogate `id` is per-version, and is also the value the byte URL is built
from — `/api/image-content/<id>`); the **active** version is the single row
with `valid_until IS NULL`. `created_by` is the user id of whoever wrote a
version, `closed_by` the user id of whoever ended it.

| Column | Meaning |
| --- | --- |
| `id` (PK) | per-version uuid; also the `/api/image-content/<id>` byte-route id |
| `name` | the teacher-chosen public identifier (`varchar(450)`) |
| `blob_path` | server-chosen **object key** beneath the storage root: `<uuid>.<ext>`, mapped to `<root>/images/<key>/content` |
| `mime_type` | `image/png` \| `image/jpeg` \| `image/svg+xml` |
| `byte_size` | measured size of the stored object in bytes |
| `credit` | optional attribution / "Content Credentials" (e.g. a CC BY notice), `text`, NULL when none |
| `created_by` / `valid_from` / `valid_until` / `closed_by` | the temporal columns |

**"At most one active version per name" is enforced at the DATABASE level** by a
Postgres **partial unique index** `ux_novedu_images_active_name`
(`name` WHERE `valid_until IS NULL`) — it both closes the create-time race and
serves the active-row hot path. Names are reusable after deletion (the index only
constrains *active* rows). As with every `novedu_*` table there are **NO foreign
keys**. Images are **not** garbage-collected — soft-delete only, history stays.

The `blob_path` is a random UUID plus the MIME's extension, so it never collides
and never leaks the teacher's chosen name into the object-key namespace.

## Store — `lib/image-store.ts` (server-only)

The **only** module that touches `novedu_images`, so the "filter on the active
version" invariant (a module-private `activeRow()` predicate every query goes
through) lives in one place. Never throws — a DB problem surfaces as
`undefined` / `{ ok: false, reason }`, which callers turn into a graceful message.

- `listImages({ search?, createdBy? })` — active rows, newest first. Filters
  apply **in SQL** (a case-insensitive contains-match over `name` for `search`,
  `createdBy` for the owner dropdown) — never in memory; see
  `docs/filtered-lists.md`. The rows carry the owner's display name from a LEFT JOIN
  on `novedu_user`; `listImageOwners()` is the dropdown's option set. **"Owner"
  here is the LAST WRITER** — `created_by` belongs to the active version.
- `getActiveImage(name)` — the active row; `null` = malformed name or no active
  version (unknown/deleted), `undefined` = DB error. Backs the resolver and the
  upload-time name-clash check.
- `getActiveImageById(id)` — the active row **by its per-version row id**; `null`
  for a malformed id (no query at all) or a closed/unknown row, `undefined` on a
  DB error. This is what `GET /api/image-content/<id>` re-checks on **every**
  byte request, so a deleted or replaced image stops being served immediately.
- `createImage(input, userId)` — writes version 1 for an image whose object is
  already published on disk; runs in a transaction so the existence check and
  the insert are atomic, and a duplicate-key error (Postgres SQLSTATE `23505`,
  via `isUniqueViolation`) maps to `reason: "name-taken"`. Any other failure
  reports `{ reason: "error", outcome: "definite" | "uncertain" }` —
  `lib/db/errors.ts`'s `classifyDbFailure` (below) tells the service whether it
  is safe to delete the object it just wrote.
- `softDeleteImages` — delete is **bulk-only**: closes the active rows in ONE
  transaction (all-or-nothing for the rows; the shared multi-delete layer —
  `docs/filtered-lists.md`), then removes the backing objects **best-effort,
  OUTSIDE that transaction**, per image — an object-deletion failure never fails
  the delete, it just lingers for reconciliation, and an already-missing object
  is logged as a note, not an error.

## Definite vs. uncertain SQL outcomes — `lib/db/errors.ts`

Alongside the existing `isUniqueViolation`, `lib/db/errors.ts` exposes
`sqlState(error)` (the Postgres SQLSTATE from a bounded `error.cause` walk, or
`null` when the error carries none) and `classifyDbFailure(error)`:

- a SQLSTATE is present and its class is **not** `08` (connection exception) →
  `"definite"` — the server answered and the transaction rolled back
  (integrity, syntax, resource, operator intervention, …); compensating for it
  (deleting the object the insert would have referenced) is safe.
- class `08`, or **no** SQLSTATE at all (a socket error, `ECONNRESET`,
  `ETIMEDOUT`, a pool timeout) → `"uncertain"` — the connection broke and the
  write may or may not have committed; the caller must NOT compensate, and
  leaves the object for reconciliation instead.

This is the rule the image create path (below) uses to decide whether a
just-written object is safe to delete after an insert failure.

## Filesystem adapter — `lib/image-fs.ts` (server-only)

The ONE place the app touches the filesystem that holds image bytes. Everything
above it (the service, the store, the routes) speaks in opaque object **keys**
(the `blob_path` value of a `novedu_images` row) and never sees a path.

- **Root.** `IMAGE_STORAGE_ROOT` is read INSIDE `verifyImageRoot()` on **every**
  call, never at module scope, in `next build`, or in the Docker builder stage.
  The layout beneath it:

  ```
  <root>/.novedu-files-root      the operator-provisioned sentinel
  <root>/images/<key>/content    one object per image version
  ```

- **Sentinel.** `verifyImageRoot()` requires the root to exist, be a directory,
  carry `.novedu-files-root` as a regular file of EXACTLY 16 bytes matching the
  UTF-8 marker `novedu-files-v1` plus one trailing LF (`0x0A`) — checked
  byte-for-byte, size first so a huge file is never read to be rejected — and
  have a readable-and-writable `images/` subdirectory. The adapter **never
  creates** the root, `images/`, or the sentinel, and there is **no fallback**
  to a local directory: silently writing into the app container when the
  mounted share is away would lose data the moment it returns. A missing,
  wrong, or unwritable root makes every operation return `unavailable`; the
  rest of the app keeps running.
- **Key layout and safety.** A key must match the server-generated shape
  (`<lowercase-uuid>.(png|jpg|svg)`); anything else (empty, absolute, `..`,
  a `/` or `\`, a NUL byte, or a resolved path that escapes `<root>/images`) is
  rejected before touching disk. Client-supplied names never reach this module.
- **Publish is exclusive `mkdir` + temp + rename.** `writeNewObject` reserves
  the object directory with a non-recursive `mkdir` (`EEXIST` = the key is
  already in use, reported as `exists` — a real no-overwrite reservation, not a
  race window), streams the source into a temporary sibling file while counting
  bytes against the caller's cap, then calls `FileHandle.sync()`, closes the
  handle, and only then `rename`s the temporary file to `content` in the same
  directory — an atomic publish within the directory. Every failure path (too
  large, empty, a failing source stream, or any filesystem error) removes the
  whole object directory, so a reader can never see a partial object and a
  retry can reuse the key. No file locks anywhere — the Azure Files SMB mount
  advises against them.
- **No symlinks followed.** An object directory or `content` file that is a
  symbolic link is reported as an `error`, never treated as data.
- **Reads and deletes.** `inspectObject`/`openObject` distinguish absence
  (`exists: false` / `missing: true` — DATA, not an error) from an operational
  failure (permission, a link where a file belongs, …); `openObject` returns a
  Node stream.
  `deleteObject` is idempotent: removing an already-gone object is
  `{ ok: true, existed: false }`, not an error.
- **MIME is never invented from bytes.** The adapter derives only byte length
  from what it wrote; the authoritative MIME is always the SQL row's declared
  value (see the service below) — no signature sniffing.

## Service & server actions — `lib/image-service.ts` + `lib/images-actions.ts`

The policy pipeline lives in **`lib/image-service.ts`** — the transport-agnostic
seam shared by the web server action and the bearer API route, mirroring
`lib/file-service.ts`. **Auth never enters the service**: each channel gates
itself and passes the verified user id in; failures carry a `reason`
discriminant (`invalid` / `conflict` / `unavailable`) the channels map to a
form message or HTTP 400/409/503. The largest image is **5 MB**
(`MAX_IMAGE_BYTES`, enforced TWICE — once before a byte is written, again by
the adapter while streaming); only `image/png` / `image/jpeg` /
`image/svg+xml` are allowed. The client copy of the same literal
(`app/images/new/upload-image-form.tsx`, which cannot import this server
module) is pinned equal to it by a source-text guard in
`lib/image-service.unit.test.ts`; `lib/answer-images.ts` has its own
same-named constant for STUDENT photos, a different subsystem, deliberately
not merged with this one.

`createImageForUser(userId, { name, mime, credit?, content })` does the WHOLE
upload in one call — there is no upload slot and no confirm step:

1. Validate the name, the declared MIME against the allowlist, and the
   `Blob`'s size (`0` → invalid "empty"; over 5 MB → invalid "too large").
2. Check the name is free (`getActiveImage`); a DB error here is `unavailable`,
   an active row is `conflict`.
3. Generate a key (`<randomUUID()>.<extension>`) and `writeNewObject` the
   stream through the adapter, retrying ONCE with a fresh key on `exists`
   (the collision case); an adapter `too-large`/`empty`/`source` failure maps
   to `invalid`, anything else to `unavailable`.
4. Normalize `credit` (trim, drop if empty, clamp to 512 chars) and
   `createImage` the metadata row with the MEASURED byte length and the
   validated declared MIME — no deep content sniffing is promised.

The object exists before the row, so a crash in between leaves an
unreferenced object (harmless, reconcilable) and never a row pointing at
nothing. On an insert failure: `name-taken` deletes the just-written object
best-effort and reports `conflict`; a `definite` SQL failure (`classifyDbFailure`
above) also deletes it best-effort; an `uncertain` outcome deliberately leaves
the object in place — deleting it could orphan a row that actually committed —
logs a `console.error`, and records the incident via `recordError` (content-free,
just the object key and area tag). A failed best-effort cleanup is logged and
never changes the primary result the caller already has.

`lib/images-actions.ts` (`"use server"`) is the thin web shell, mirroring
`lib/files-actions.ts`: **every** action gates with **`requireTeacherUserId()`**
(an *effective* teacher — student mode is denied — plus the session user id);
never `session.user.isTeacher`. It maps the service failures to
`{ ok: false, error }` form messages and revalidates `/images` on success
(`revalidatePath` stays OUT of the service — the bearer route shares it, and
never revalidates).

- `uploadImage(formData)` → gate, parse `file`/`name`/`mime`/`credit` out of the
  `FormData` (every field re-checked — a hand-crafted POST reaches this action
  just as the form does), reject an oversized file before it is streamed
  anywhere, then `createImageForUser`.
- `deleteSelectedImagesAction(names)` → the list's **"Delete Selected"**, the
  **only** delete path (web-only — no bearer delete route); mirrors
  `deleteSelectedFilesAction`.

CSRF and body bounding for the web channel come from the **framework**, not
from code here: Next.js compares `Origin` with `Host` on every server-action
POST, and `serverActions.bodySizeLimit` (25 MB, set in `next.config.ts` for
quiz photos) already admits the request; `MAX_IMAGE_BYTES` (5 MB) is the
image-specific ceiling, checked in the action before the service and again by
the adapter while streaming.

## The upload flow

Both channels stream the bytes THROUGH the app in one request and get back the
confirmed result — no slot, no separate confirm step, no retry-with-backoff wire
contract to reason about.

- **Web:** the form (`upload-image-form.tsx`) infers the MIME from the file's
  extension, pre-checks size/MIME client-side, builds one `FormData` (`file`,
  `name`, `mime`, `credit`), and calls the `uploadImage` **server action**.
- **CLI / bearer API:** ONE `multipart/form-data POST /api/images/<name>`
  (`app/api/images/[name]/route.ts`), gated by `requireBearerTeacher` BEFORE
  any body is read. The route reads the raw request through
  `readBoundedFormData` (`lib/bounded-form.ts`) — a streamed byte counter
  modeled on `lib/bounded-json.ts`'s `readBoundedJson`, capping the WHOLE
  multipart envelope at **6 MiB** and cancelling the stream the instant it is
  crossed (413). A `Content-Length` header over that cap is a fast reject
  BEFORE the body is touched, but the header is never trusted as authoritative
  — a chunked request that omits or understates it is still bounded by the
  counter. Parsing itself is the platform's own `Response.formData()` over the
  bounded buffer, so no multipart dependency is added; `request.formData()`
  (unbounded) is never called anywhere in the app. Fields: `file` (exactly one
  file part), `mime` (exactly one string), `credit` (at most one string).
  `201 { id, name, mimeType, byteSize, credit }` on success; `400`
  (bad body/name/MIME/size), `409` (name taken), `413` (body over 6 MiB), `503`
  (storage unavailable).

Both channels call the identical `createImageForUser` — no deep MIME sniffing
is promised on either. Uploads are **create-only**: a taken name is a
non-retryable `409`; there is no upsert and no PATCH. `GET /api/images` (bearer,
`app/api/images/route.ts`) lists active versions; each row carries the
per-version `id` and an absolute `url` built from `resolveAppOriginOr("")` —
`${origin}/api/image-content/<id>` — which only resolves bytes for a **signed-in
browser session**, so it is not a programmatic download endpoint (`docs/api.md`).

## Read route — `GET /api/image-content/<id>`

The ONE route that serves image bytes: same-origin and **cookie-session**
authenticated, `<id>` the immutable `novedu_images` version row id.

- Sits behind the DEFAULT `proxy.ts` cookie gate with **no matcher exemption**
  (unlike the bearer `/api/images` prefix, which IS excluded so requests
  carrying no session cookie can reach it) — a signed-out browser is bounced to
  `/sign-in` before the handler ever runs. The handler ALSO calls `getSession()`
  (`lib/session.ts`) itself: the proxy gate is a redirect convenience, this
  check is the actual access control. A session lookup that throws is `503`; no
  session is `401`.
- The `id` must match the row-id pattern, else `404` (no query at all — a
  malformed id never reaches the store). `getActiveImageById(id)` re-checks the
  row on **every** request: `undefined` (DB error) → `503`; `null` (closed,
  replaced, or unknown) → `404`.
- **Shared authenticated-asset policy, verbatim from the design**: teacher-hosted
  images are shared authenticated assets, not private per-teacher, per-user, or
  per-code resources. Any signed-in Novedu user who possesses an active row's
  URL may read it, including after the activity code that originally displayed
  it expires — the URL alone is insufficient without a valid session. This
  route therefore runs **NO `checkCode()`**, verifies **NO thread token**, and
  writes **NO user↔code link**; the quiz page still runs `checkCode()` before it
  ever hands out an image URL, and chat/grading/reports keep their own code and
  thread-token rules untouched.
- **Headers.** On `200`: `Content-Type` = the row's stored MIME (never
  sniffed), `Cache-Control: private, no-cache`, `ETag: "<id>"` (a strong ETag
  over the immutable row id — a browser may keep a private copy but must
  revalidate on every use). Next.js strips `Content-Length` from route-handler
  responses, so the body goes out chunked. A conditional request (`If-None-Match` containing that ETag)
  answers `304` with the same headers, **but only after the same session check
  and active-row lookup both pass** — a closed row `404`s a conditional request
  exactly as it `404`s a plain one, and no shared cache may ever store the
  response. `openObject` failures: `missing` → `404`, anything else → `503`.
- **On EVERY response** — 200, 304, and every failure (401/404/503, which are
  JSON with `Cache-Control: no-store`) — the route sends
  `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'`. SVG renders ONLY
  through `<img src>`; these two headers mean a direct navigation to a hosted
  SVG's URL cannot execute script in the application document. The route must
  never inline SVG markup or use `rehype-raw` — `<ContentImage>` remains the
  display component.
- No signature, query token, or expiry exists anywhere in this URL: a browser
  `<img>` sends the same-origin session cookie automatically, which is what
  makes a plain authenticated route sufficient — the only fetcher of a resolved
  image URL is a browser `<img src>` (`components/content-image.tsx`, the
  `/images` list's View button); no server code, prompt builder, transcript, or
  LLM provider ever fetches one.

`/api/image-content` is one of exactly THREE cookie-session API routes in an
otherwise bearer-authenticated API namespace, beside `/api/copilotkit` and the
teacher-only `/api/health` probe — a deliberate exception, not a precedent for
a fourth (`docs/api.md`, `docs/auth.md`).

## Resolution primitive — `ImageRef` → `resolveImageRef` → `ResolvedImage`

A module that wants a content image embeds an **`ImageRef`** (`lib/image-ref.ts`,
**pure / client-safe** — no I/O):

```ts
interface ImageRef { hosted?: boolean; src: string; alt?: string; credit?: string }
```

`resolveImageRef(ref, baseUrl)` (`lib/image-resolve.ts`, server) turns it into a
**`ResolvedImage`** (`{ url, alt?, credit? }`) — handling **three shapes**, leniently
(a missing ref or an unknown/soft-deleted hosted name yields `null`, so the
consumer simply omits the image rather than erroring):

- **`hosted: true`** — `src` is an app-hosted image **name**; the active row's
  `id` is turned into `/api/image-content/<id>` (`imageContentPath`,
  `lib/image-ref.ts` — a pure string builder, root-relative). No adapter call
  happens here and nothing can throw; the resolver only ever reads the store.
- an **absolute** `http(s)` URL — used as-is.
- anything else — a **relative** path resolved against the module's base URL via
  the pure `resolveRelativeUrl` (`lib/relative-url.ts`: standard `URL`
  resolution, so `./` / `../` segments work).

`ImageRef` is intentionally a *projection* type: it carries no secret (unlike a
quiz's `evaluation`), so a module's public projection can pass it to the browser
unchanged and resolve it just before render.

**Content Credentials** (`credit`): an optional attribution shown small below the
image by `<ContentImage>`. For a **hosted** image it defaults to the credit stored
on its `novedu_images` row (set at upload on `/images/new`); a per-ref `credit` on
the `ImageRef` overrides it, and is the only source for absolute/relative refs.

## Display — `<ContentImage>` + `<ImageLightbox>` (client)

The display splits into a **trigger** and the **lightbox**, so the lightbox is one
shared component both content images and the management list open.

- `<ImageLightbox>` (`components/image-lightbox.tsx`) is the lightbox itself: a
  native `<dialog>` showing one image full-window (`image`, controlled `open`, and
  `onClose`). Escape, a Close button, and a backdrop click all route back through
  `onClose`, so the caller stays the single source of open/closed truth; a failed
  `<img>` load swaps in a muted note in place of the image.
- `<ContentImage>` (`components/content-image.tsx`) is the content-image trigger:
  it renders a bounded responsive thumbnail (a real `<button>`) that opens the
  shared `<ImageLightbox>`. A thumbnail that fails to load falls back to a muted
  note. This is what quiz YAML images render as.
- The `/images` list's **"View"** button (`app/images/view-image-button.tsx`) is
  the other trigger — an icon button (no inline preview) opening the same
  `<ImageLightbox>` from the row's `/api/image-content/<id>` URL.

**SVG safety**: images are rendered **ONLY via `<img src>`** — never inline SVG
markup — so a hosted SVG cannot inject script into the page; the read route's
`nosniff` + sandboxing CSP (above) additionally keep a direct navigation to the
URL inert. The `<img>` elements deliberately bypass `next/image` — hosted images
are served through the app's own byte route, not an optimizable public URL the
loader can transform.

## Provisioning

`IMAGE_STORAGE_ROOT` is the one operational setting: `/novedu-files` on both
Azure stages, an explicit directory outside the repo in local
dev, and the harness's own directory in Playwright (below). The app **never**
creates the root, `images/`, or the sentinel — not even as a development
convenience: `npm run images:init-root` (`scripts/init-image-root.mjs` →
`scripts/lib/image-root.mjs`) does that explicitly, idempotently, for whatever
path `IMAGE_STORAGE_ROOT` names (or a positional argument), and refuses `/` and
`/home` outright. Run it once per root before the app first serves image
traffic against it.

On Azure, each stage's container app mounts its own storage account's Azure
Files share `novedu-files` at `/novedu-files`, through an environment storage
definition of the Container Apps environment (`docs/azure-runtime-env.md`). The
mount is SMB, keyed by the storage account key the platform holds in that
storage definition ONLY (never in an app setting or the repository — Azure
Files mounts are key-based by platform necessity, Entra/RBAC is not supported
for them). The app itself holds no storage key or credential of any kind; it
only ever sees a mounted directory through ordinary `node:fs`. The share's root
is provisioned through the storage API, not by the app. An operator confirms
that the container's `nextjs` user (uid 1001) can write `<mount>/images` — the
mounts are world-writable by default, but CIFS ignores `chmod`/`chown`, so this
is a platform check, not something the app can assert for itself.

The root check runs at server startup (`instrumentation.ts`, right after
telemetry init and BEFORE the `DATABASE_URL` bail, so it always logs
independent of the database) — logged, never fatal — and is exposed as the
`images` health probe (`checkImageStorage`, `lib/health.ts`, behind the
teacher-only `GET /api/health?probe=images`). A running server with an unset,
missing, or invalid root keeps serving every other feature; image operations
answer `unavailable` until an operator fixes the mount.

## Tests

The overall approach (layers, the `@live` boundary, the no-infra patterns) is in
**`docs/testing.md`**. Image-specifics:

- `lib/image-fs.unit.test.ts` — the filesystem adapter over real `mkdtemp`
  directories: exact sentinel bytes, no root/marker creation, every key attack,
  exclusive reservation, empty/exactly-5-MiB/over-cap streams, symlink refusal,
  injected failures at each write/sync/close/rename/inspect/open/delete step,
  and a sentinel-parity check against `scripts/lib/image-root.mjs`.
- `lib/db/errors.unit.test.ts` — `sqlState`/`classifyDbFailure` per SQLSTATE
  class, including the "no SQLSTATE at all" and class-`08` uncertain cases.
- `lib/image-store.unit.test.ts` — the temporal transitions, `getActiveImageById`
  (valid/closed/malformed/DB-error), the `outcome` mapping on insert failure,
  and that best-effort object deletion happens only after the row transaction
  commits.
- `lib/bounded-form.unit.test.ts` — real wire-shaped multipart bodies: oversize
  (chunked, no `Content-Length`), truncated boundary, wrong content type, the
  exact-cap boundary.
- `lib/image-service.unit.test.ts` — the shared policy pipeline: the name/MIME
  allowlist, the measured (not claimed) byte length, credit normalization, the
  collision retry, the definite-vs-uncertain cleanup split, and the
  `MAX_IMAGE_BYTES` source-text guard against the form's client copy.
- `lib/images-actions.unit.test.ts` — the web shell: the teacher gate, `FormData`
  parsing, service wiring, the revalidation.
- `app/api/images/route.unit.test.ts`, `app/api/images/[name]/route.unit.test.ts`
  — the bearer routes (real auth gate via a local JWKS, mocked service/store),
  incl. the multipart edge matrix (empty/malformed body, duplicate/missing
  fields, dishonest `Content-Length` both directions, exactly-cap bodies).
- `app/api/image-content/[id]/route.unit.test.ts` — the read route: no session
  → 401 without a store call, a throwing session lookup → 503, malformed id →
  404 without a store call, closed/missing-object → 404, DB/adapter failure →
  503, the exact headers on 200 and on a 304 that only fires after the session
  and row checks, and a source-text assertion that the proxy matcher carries no
  `image-content` exclusion.
- The hermetic `e2e/api-images.spec.ts` proves the bearer routes' 401/403 over
  real HTTP and that the content route redirects a bare request to `/sign-in`
  (no proxy exemption).
- `components/content-image.browser.test.tsx` and
  `app/images/view-image-button.browser.test.tsx` — pure-prop lightbox/trigger
  contracts, no infra.
- `app/images/new/upload-image-form.browser.test.tsx` — client validation, the
  single `FormData` submission to the mocked action, pending/error/success
  states.
- `e2e/image-management.live.spec.ts` (`@live @live-db`) — the real app-HTTP
  lifecycle against a temporary filesystem root and real Postgres, no Azure
  credentials: form upload, bearer API upload, list, the default student
  session opening a quiz and loading the hosted image, a code-expiry case
  proving the shared-authenticated-asset policy (a signed-in holder still
  reads the image after the code expires, no `novedu_user_chats` row is
  created), a signed-out redirect and an invalid-session case, the benign/evil
  SVG regression (a malicious SVG stays inert both inlined and navigated to
  directly), delete, and reuse of a deleted name minting a new, different id.
  The harness provisions its own root (`e2e/image-root.setup.ts`, run by the
  `setup` Playwright project) before the dev server boots against
  it (`playwright.config.ts` passes `IMAGE_STORAGE_ROOT` to the `npm run dev`
  webServer); `e2e/image-root.utils.ts`'s `assertServerImageRoot` fails a spec
  with an actionable message if a reused dev server booted against a different
  root.
- `e2e/image-mount-smoke.live.spec.ts` (`@live @live-storage`) — a manual,
  opt-in smoke test against a REAL mounted Azure Files share
  (`IMAGE_SMOKE_ROOT`, default `/novedu-files`); skips cleanly when unset,
  never runs in CI, and is the only image test that needs real Azure Files.
