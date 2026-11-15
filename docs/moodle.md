# Moodle hand-in

Deep reference for **Moodle hand-in**: Novedu is an LTI 1.3 tool with the grade
service (AGS) for one Moodle per Novedu instance. A teacher switches it on for a
quiz code and adds the "Novedu" activity in a Moodle course; a student who opens
that activity links their Moodle account to their Novedu account once, takes the
quiz and hands the result in to Moodle's gradebook with one click on the Finish
page. No Moodle plugin, no Moodle password or API token. The always-on invariants
are summarized in `AGENTS.md`; this file has the full mechanics.

Read it before touching `lib/moodle-*.ts`, the `/lti` pages and route
(`app/lti/**`), the public LTI routes (`app/api/lti/**`), the quiz Finish page's
hand-in box (`app/[code]/_quiz/hand-in.tsx`), receipts in `submitAnswer`
(`lib/quiz-actions.ts`), the code's Moodle switch, or the `api/lti` and
`lti/pick` entries of `proxy.ts`. The teacher-facing description is the teacher
guide's chapters "Handing in quiz results to Moodle" and "Connecting Novedu to
Moodle".

## Availability

The feature is **available** only when all four server variables are set and
the key loads (`moodleAvailable()` in `lib/moodle-config.ts` — the one check
every Moodle path asks):

| Variable | What |
|---|---|
| `MOODLE_LTI_PRIVATE_KEY` | Novedu's RSA private key, PKCS#8 PEM (a one-line value with `\n` escapes works too). A secret: on a stage a Key Vault reference (`docs/azure-runtime-env.md`). |
| `MOODLE_LTI_ISSUER` | Moodle's Plattform-ID, e.g. `https://moodle.example.org`. |
| `MOODLE_LTI_CLIENT_ID` | The Client-ID Moodle shows for the registration. |
| `MOODLE_LTI_DEPLOYMENT_ID` | The Deployment-ID Moodle shows. |

Moodle's three endpoints are derived from the Plattform-ID with Moodle's fixed
paths: `/mod/lti/certs.php` (key set), `/mod/lti/token.php`, `/mod/lti/auth.php`.
One or two of the three connection values set is a configuration error, warned
once by variable name (never a value) and treated as not available. A key that
does not load is reported once without its content and also counts as not
available. The key alone is enough for the public key set, because Moodle's
admin registers Novedu before Moodle's values exist.

Not available: `/api/lti/login`, `/api/lti/launch` and `POST /api/lti/pick`
answer `404`, the code form shows no Moodle checkbox, no receipt is minted, the
Finish page shows no box and the hand-in action refuses. A code's stored switch
stays as it is. `compose.yaml` passes the four variables through, empty by
default, so the demo setup runs without Moodle.

The key: one RSA key, `kid` = its RFC 7638 thumbprint, signing in process with
`jose`. Changing it = replace the secret and restart. Moodle fetches the key set
when Novedu asks for a token, so a registration with the key set URL follows by
itself; a registration with a pasted key needs the new public key pasted.

## Public surface

These routes take **no Novedu session** and never create one (proxy exclusions
`api/lti(?:/|$)` and `lti/pick(?:/|$)`):

| Route | Caller | What it does |
|---|---|---|
| `GET /api/lti/jwks` | Moodle's server | The public key as a JWK set (`404` without a key). |
| `GET`/`POST /api/lti/login` | the browser, sent by Moodle | Checks `iss` and `client_id`, answers `302` to Moodle's authorization endpoint with a signed 10-minute `state` and a `nonce`. |
| `POST /api/lti/launch` | the browser, sent by Moodle | The Tool URL and redirect URI: verifies the state and Moodle's `id_token`, then redirects (below). |
| `GET /lti/pick` | the teacher's browser inside Moodle's dialog | The code picker. |
| `POST /api/lti/pick` | the picker's form | Answers Moodle with the signed deep-linking response. |

No state table and no state cookie: Moodle's launch is a cross-site POST, which a
`SameSite=Lax` cookie does not survive. The `state` is an HS256 token signed with
a key derived from `AUTH_SECRET` under its own label (`lib/moodle-launch.ts`;
the same derivation as the thread tokens). Answers to anything that does not
match the configured connection are plain-text `400`/`401` without detail.
Everything under `/lti` renders without the status bar (`components/app-chrome.tsx`).

## The launch

`POST /api/lti/launch` verifies Moodle's `id_token` with Moodle's key set
(`createRemoteJWKSet`, cached per URL), the issuer, audience = client id, expiry,
the `nonce` of the state, the deployment id and LTI version `1.3.0`
(`readLaunch`), then by message type:

- `LtiDeepLinkingRequest` → `303` to `/lti/pick?t=<pick token>` (signed, 15
  minutes, carrying Moodle's return URL and opaque `data`). The return URL must lie
  inside the Plattform-ID, else `400`.
- `LtiResourceLinkRequest` → reads `custom.novedu_code` (code pattern, else `/`).
  The code row (the launch's only database read) unknown or not switched on, the
  launcher not a `…/membership#Learner`, or no grade column (`lineitem`) → `303`
  to `/<code>`, nothing stored. A `lineitem` outside the Plattform-ID refuses the
  launch. Otherwise the **arrival cookie** is set and the browser goes to
  `/lti/arrive`.
- Anything else → `400`.

## Carrying the arrival to the signed-in student

A launch reference in the address would be a bearer reference, so nothing
travels in the address. The launch sets `novedu-lti-arrival` (`HttpOnly`,
`SameSite=Lax`, `Path=/lti`, 15 minutes, `Secure` on https): a signed token
with the Moodle user id (`sub`), the name, the username (`ext.user_username`),
the code, the course title and the grade column URL.

`GET /lti/arrive` is a **route handler** (a page cannot delete a cookie while it
renders), gated by the proxy like any page. Without a session the proxy sends
the student to sign-in and back (the cookie waits in the browser). With one it
checks the cookie and both directions of the link (`checkArrival`,
`lib/moodle-arrival.ts`; `decideArrival` in `lib/moodle-launch.ts`):

| Decision | Outcome |
|---|---|
| this Novedu account linked to this Moodle account | store the hand-in target, clear the cookie, `/<code>` |
| no link on either side, a name in the cookie | `/lti/link`, the cookie stays |
| the Moodle account linked to another Novedu account | clear, `/lti/done?state=mismatch-moodle` |
| this Novedu account linked to another Moodle account | clear, `/lti/done?state=mismatch-novedu` |
| no name (Moodle shares none) | clear, `/lti/done?state=no-name` |
| no valid cookie, or the feature not available | clear, `/lti/done?state=expired` |
| the link state could not be read | clear, `/lti/done?state=unavailable` |
| the code deleted or its switch off since the launch | clear, `/<code>`, nothing stored |

`/lti/link` shows both accounts (Novedu name and email, Moodle name and
username) and the course, with the notice of what is stored. Its two buttons are
server actions (`confirmMoodleLink`, `declineMoodleLink` in
`lib/moodle-actions.ts`) that read the **cookie again**, re-run the decision
(including the code row), act on the session user only and clear the cookie.
"Yes" sends only a fingerprint of the cookie the page showed
(`arrivalFingerprint`); if another launch replaced the cookie meanwhile, the
browser goes back through `/lti/arrive` and sees the confirmation for the new
arrival instead of linking an account it never showed. A unique-key clash while
linking is decided again from what is stored (a double submit lands on the quiz,
a race on the fitting refusal).
`/lti/done` only shows the message of its state; the address carries the state
from a fixed list and the pattern-checked code, nothing personal. Accepted gap:
on a shared computer, a cookie left by someone who never signed in to Novedu can
meet the next person on `/lti/link` within 15 minutes; they would see that
Moodle name and would have to confirm to do harm.

## Stored data

| Table | Columns | Notes |
|---|---|---|
| `novedu_moodle_links` | `issuer` + `user_id` (PK), unique (`issuer`, `moodle_user_id`), `linked_at` | One Moodle account per Novedu user per Moodle, and the reverse: the unique index refuses a second Novedu account. |
| `novedu_moodle_targets` | `issuer` + `user_id` + `code` (PK), `lineitem_url`, `arrived_at`, `handed_in_at`; index on `code` | Where a student's hand-in of a code goes: the activity they last arrived from. Overwritten on each arrival; a different grade column clears `handed_in_at`. |
| `novedu_codes.moodle_enabled` | boolean, default `false` | The per-code switch; only a quiz may have it on. |

- This is the **fourth sanctioned user↔code link** (after reports, coding keys
  and saved quiz results), written only after the student confirmed on
  `/lti/link`. `lib/moodle-store.ts` is the only access and has **no teacher
  reader**: every function is keyed by the session user, except
  `deleteTargetsForCode`, which returns nothing. Its importers are fixed by
  `lib/moodle-store-isolation.unit.test.ts`.
- Every statement filters by the **configured issuer**: a local Moodle, the
  e2e fake and a school's Moodle sharing one database never see each other's
  rows. Changing the connection deletes nothing; the old Moodle's rows are
  simply never read.
- Linking is one transaction: insert the link (a unique violation on either key
  = mismatch, nothing stored) and upsert the target.
- The code delete (`deleteCodesAndData`, `lib/code-stats-store.ts`) drops the
  code's targets; unlink (Settings → "Moodle account") drops the user's link and
  all their targets. Nothing is sent to Moodle; grades already there stay.
- Never stored: the Moodle name and username (only in the cookie and on the
  confirmation page), a score, a course or activity title.

## Receipts and the hand-in

The runner's own counts for the personal statistics are unchanged. The Moodle
hand-in counts on the server:

- The quiz page (`app/[code]/render-quiz.tsx`) passes `moodle={{ handedInAt }}` to
  the runner only when the feature is available, the code is switched on and the
  session user has a target for the code. Only then does the runner send
  `attemptId` and `slot` with each answer and keep the receipts; without the prop
  every request and the page are exactly as without Moodle.
- `submitAnswer` mints a **receipt** only when both inputs are valid (a uuid, a
  slot inside the attempt), the code is switched on and the feature is
  available: HMAC-SHA256 over `(code, userId, attemptId, slot, questionId,
  verdict)` with a key derived from `AUTH_SECRET` under its own label
  (`lib/moodle-receipt.ts`, pure, kept real in tests).
- `handInToMoodle({ code, attemptId, receipts })` (`lib/moodle-actions.ts`):
  `verifyAndLoadQuiz`; the feature available, the switch on, a link and a target;
  every receipt verified for this user, code and attempt — the whole call is
  refused (never clamped) on a bad signature, a slot outside the attempt, two
  receipts for one slot, a question no longer in the quiz, or a question counted
  more than `ceil(attemptLength / poolSize)` times; counts; the score posted; on Moodle's
  success `handed_in_at` set. Answers `{ ok, handedInAt, percent }` or
  `{ ok: false, message, retry }` — `retry` only where "Try again" can help
  (Moodle unreachable, the activity gone in Moodle).
- What reaches Moodle: `scoreGiven = correct + 0.5 × partly correct`,
  `scoreMaximum` = the attempt's question count (Moodle scales it to the
  activity's maximum), `activityProgress: "Completed"`,
  `gradingProgress: "FullyGraded"`, and the comment
  `Novedu quiz: 10 questions — 6 correct, 2 partly correct, 1 wrong, 1 not answered.`
  (zero parts left out; `lib/moodle-score.ts`, shared with the box). Never a
  school grade or a pass/fail flag.
- A student can still answer a slot again and keep the better receipt; with
  unlimited retakes that is accepted.
- The box's "Moodle receives" line is computed from the receipts the runner
  holds (an answer graded without one counts as unanswered), so it shows what the
  server will count. The runner starts a new attempt only when the quiz's content
  changes, so a page refresh by a server action (saving the result does one)
  keeps the attempt id and the receipts.

`lib/moodle-ags.ts` talks to Moodle: a token (a JWT signed with the tool key,
`client_credentials` with the single `score` scope, kept in memory until shortly
before it expires, dropped on a `401` with one retry) and
`POST <line item path>/scores` (the suffix goes into the path, before the query
string). Both calls time out after 10 seconds; it never throws and logs only an
HTTP status.

## The picker

`/lti/pick` is one field, "Paste the Novedu code or link of your quiz", taking
what the start page's code field takes (`extractCode`, `lib/code-input.ts`). The
signed pick token rides along as a hidden field. `POST /api/lti/pick` checks the
code exists, is a quiz and has the switch on (not its window) and answers with a
tiny HTML page that posts field `JWT` to the return URL from the token: an
`LtiDeepLinkingResponse` signed with the tool key (`aud` = the Plattform-ID) with
one `ltiResourceLink` — title `Novedu: <note, else code>`, the launch URL,
`custom.novedu_code`, a grade column of maximum 100. A wrong code goes back to the
picker with a fixed error key (`app/lti/pick/pick-errors.ts`); the picker reveals
nothing about a code but its note.

## The switch on codes

`/codes/new` and `/codes/edit/<code>` show "Students can hand in results to
Moodle" for a quiz while the feature is available (`docs/codes.md`). The edit
form sends a marker with the checkbox, so a save while the feature is off keeps
the stored switch. `POST /api/codes` accepts `moodle` (boolean, default `false`;
`true` on another module is a `400`) whether or not a connection exists, and
`GET /api/codes` returns it; `novedu-cli codes create --moodle` and the registry
field `moodle: true` (quizzes only, mint-only like `note`; `docs/registry.md`)
use it. Switching it off hides the box, makes a launch just open the quiz and
refuses a hand-in under way; targets are kept, so switching it on again restores
the box.

## Settings

- **Moodle connection** (effective teachers only, read-only,
  `app/settings/moodle-connection.tsx`): the three addresses for Moodle's admin
  (Tool URL and redirect URI, login URL, key set URL, from `resolveAppOrigin()`)
  and the public key as PEM, each with a copy button; "Connected to
  <Plattform-ID>." or what is missing; the note that Moodle must share the
  user's name. Without a key it only says hand-in is not set up.
- **Moodle account** (only while the session user has a link,
  `app/settings/moodle-account.tsx`): since when, and "Unlink my Moodle account"
  behind a confirmation.

## Telemetry

Content-free events only, each with an outcome code in `novedu.moodle.outcome`:
`moodle.launch`, `moodle.link`, `moodle.handin`, `moodle.pick`. Never a Moodle
user id, name, username, code-and-user pair, token or URL with a query.

## Testing

The fake platform (`tests/fake-moodle.ts`) signs launches for the unit tests and
for `e2e/moodle-roundtrip.live.spec.ts`; the check against a real local Moodle is
the `novedu-moodle-test` skill. Both are described in `docs/testing.md`.
