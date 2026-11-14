---
name: novedu-moodle-test
description: Check Novedu's Moodle hand-in (LTI 1.3) against a real, local Moodle — start a moodle-docker Moodle, register the local Novedu with a pasted key, add a quiz activity through Novedu's code picker, and walk a student from Moodle through the account link, the quiz and the hand-in to the gradebook, in Chromium and Firefox. Use it when Rainer asks for a Moodle check, before merging a change to the Moodle code (lib/moodle-*, app/lti, app/api/lti, the quiz Finish page or submitAnswer, sign-in or proxy.ts, the jose package), or to write documentation from an observed run. Not for the automated tests — the fake platform covers those (docs/testing.md).
---

# Checking the Moodle hand-in against a local Moodle

Novedu's own tests run against a **fake** Moodle (`tests/fake-moodle.ts`, `e2e/moodle-roundtrip.live.spec.ts`).
This skill is the check against a **real** Moodle, run by hand when someone asks for it. It is not automated
and not in CI. Read `docs/moodle.md` first for how the feature works.

Everything runs on this machine: Moodle in Docker, Novedu as `npm run dev` on the host, a throwaway Postgres
for Novedu. The scripts under `scripts/` drive Moodle's (German) UI with Playwright; they are helpers, not
tests.

## The layout that works

| Piece | Where | Note |
|---|---|---|
| Moodle 4.5 | `~/moodle-dev45`, `http://127.0.0.1:8091` | The school's version line. Prefer it. |
| Moodle 5.3 | `~/moodle-dev`, `http://127.0.0.1:8090` | Same steps; set `MOODLE_URL`. |
| Novedu | `npm run dev`, `http://localhost:3000` | A different site than Moodle, so the cookie behaviour is realistic. |
| Novedu's database | a throwaway Postgres container | See "Novedu's database" — never the shared `novedu_dev` for a branch with new migrations. |
| Model | `fake-llm/server.mjs` | Grades every answer `correct`. A real model is not needed for this check. |
| Quiz file | `test-fixtures/serve.mjs` | Serves `quizzes/test-quiz.yaml` (one question). |

The tool key is **pasted** into Moodle (key type "RSA-Schlüssel"), so Moodle's server never has to reach the
host — the host firewall blocks container-to-host traffic, and Moodle's HTTP security blocks private
addresses and ports other than 80/443 anyway. Novedu's server does reach Moodle (key set, token, score) on
the published port.

Accounts in the local Moodles: `admin`, `teacher1`, `student1`, `student2`. Their password is not in this
repository; export it as `MOODLE_DEV_PASSWORD` (ask Rainer if you don't have it). The scripts refuse to run
without it.

## 1. Start Moodle

```bash
cd ~/moodle-dev/moodle-docker && . ../../moodle-dev45/env.sh && bin/moodle-docker-compose start
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/login/index.php   # 200
```

`start`/`stop` keep the data; `down` wipes the database. For a fresh Moodle follow
`~/moodle-dev/moodle-docker`'s README with the same `env.sh`, then copy `scripts/moodle-setup.php` into the
Moodle directory (`~/moodle-dev45/moodle/`) and run it — it installs the German language pack and creates the
three accounts and the course `NOVEDU1`, harmless to repeat:

```bash
bin/moodle-docker-compose exec -T -e MOODLE_DEV_PASSWORD webserver php moodle-setup.php
```

When a web container was recreated, its language pack and caches are gone (Moodle shows English and an empty
tool list): rerun `moodle-setup.php` and `php admin/cli/purge_caches.php`.

Course ids: `docker exec moodle-dev45-db-1 psql -U moodle -d moodle -tAc "select id, shortname from m_course"`.

## 2. Novedu's database

Novedu applies its migrations when it boots. A branch with new migrations must **not** boot against the
shared `novedu_dev` (the dev stage's database): run a throwaway Postgres and point `DATABASE_URL` at it.

```bash
docker run --rm -d --name novedu-moodle-pg -e POSTGRES_PASSWORD=Test-Passw0rd! -e POSTGRES_DB=novedu \
  -p 127.0.0.1:55433:5432 postgres:18
export DATABASE_URL='postgresql://postgres:Test-Passw0rd!@localhost:55433/novedu'
```

`--rm` removes it on `docker stop novedu-moodle-pg`. Every command below that touches Novedu's database
needs this `DATABASE_URL` in its environment.

## 3. Register Novedu in Moodle

Create a key (scratch files, never committed) and register with the public half:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out tool-private.pem
openssl pkey -in tool-private.pem -pubout -out tool-public.pem
MOODLE_URL=http://127.0.0.1:8091 node .agents/skills/novedu-moodle-test/scripts/register-tool.mjs tool-public.pem "Novedu (check)"
```

It fills the admin form the way the teacher guide's chapter "Connecting Novedu to Moodle" describes (new
window, deep linking, grade sync, name always, email never) and prints Moodle's tool details:
`Plattform-ID`, `Client-ID`, `Deployment-ID`. The Deployment-ID is also the tool's **type id** that
`teacher-add.mjs` needs. Each run adds another tool; delete old ones under Website-Administration → Plugins →
Externes Tool → Tools verwalten.

## 4. Start Novedu with the connection

```bash
FAKE_LLM_PORT=34568 node fake-llm/server.mjs &
E2E_FIXTURES_PORT=34567 node test-fixtures/serve.mjs &
SCCH_BASE_URL=http://127.0.0.1:34568/v1 SCCH_API_KEY=fake-llm \
MOODLE_LTI_PRIVATE_KEY="$(cat tool-private.pem)" MOODLE_LTI_ISSUER=http://127.0.0.1:8091 \
MOODLE_LTI_CLIENT_ID=<Client-ID> MOODLE_LTI_DEPLOYMENT_ID=<Deployment-ID> npm run dev
```

Run the dev server as a background job and wait for `curl http://localhost:3000/api/version`.
`curl http://localhost:3000/api/lti/jwks` must answer a key set. A teacher's Settings page now says
"Connected to http://127.0.0.1:8091."

Traps seen:

- After a Playwright run or `next build`, `next dev` may reload every page in a loop (the picker inside
  Moodle's dialog then never settles). Stop the dev server, move `.next` to `~/.cache`, start again.
- Never stop it with `pkill -f "next dev"` (or `pkill -f` on any text) from a shell whose own command line
  contains that text — it kills the shell. Stop the background job, or `kill` the PID.
- The first request to a page compiles it (10 s for the quiz page); the scripts wait for that.

## 5. A Moodle-enabled quiz code

Mint it straight into Novedu's database with the e2e helper (a `.mts` file so top-level `await` works):

```ts
// mint.mts — run with: npx tsx mint.mts
import { mintCode, VALID_QUIZ_URL } from "<repo>/e2e/code.utils";
console.log(await mintCode({ module: "quiz", file: VALID_QUIZ_URL, moodle: true, note: "Moodle check", startOffset: null, endOffset: null }));
process.exit(0);
```

Or create it in the app on `/codes/new` with "Students can hand in results to Moodle" ticked.

## 6. The teacher adds the activity

```bash
node .agents/skills/novedu-moodle-test/scripts/teacher-add.mjs <courseId> <typeId> <code> picker
```

`picker` clicks "Inhalt auswählen", pastes the code into Novedu's picker and uses it; expect the name
`Novedu: <note>` and maximum 100. `custom` types `novedu_code=<code>` into the custom parameters instead. The
script prints each Novedu activity's `view.php?id=<cmid>` link.

## 7. The student

Mint a Novedu student session (the dev server's sign-in is Microsoft; the script stands in for it):

```bash
npx tsx .agents/skills/novedu-moodle-test/scripts/novedu-session.mts "Sam Novedu"
# {"userId":"e2e-moodle-…","cookie":"…"}   — keep the cookie out of logs and reports
NOVEDU_COOKIE=<cookie> node .agents/skills/novedu-moodle-test/scripts/student-launch.mjs student1 <cmid> chromium handin
```

The last argument stops early: `link` (show what Novedu shows first), `confirm` (link and stop on the quiz),
`handin` (answer, finish, hand in). Expected for an unlinked student: `/lti/link` with both accounts and the
course, then the quiz, then "Handed in to Moodle on … (100 %)". The same student again goes straight to the
quiz (already linked).

The gradebook: copy `scripts/grades.php` into the Moodle directory and run it in the web container — every
activity grade with its feedback, e.g. `final 100.0 | feedback 'Novedu quiz: 1 question — 1 correct.'`.

## 8. The checklist

Run the main walk-through in **Chromium and Firefox** (a second Moodle student with a second Novedu session
for the second browser), then as many of these as the change calls for:

- [ ] Registration with the pasted key; Settings says "Connected to …".
- [ ] Activity through the picker; the picker refuses an unknown code, a tutor code and a quiz without the
      switch with their messages.
- [ ] First launch: the confirmation page; "That's not me" stores nothing.
- [ ] Hand-in lands in the gradebook with the comment; a second hand-in replaces it.
- [ ] A linked student goes straight to the quiz.
- [ ] Another Novedu account arriving as the same Moodle user: the refusal page, no name shown.
- [ ] `teacher1` opening the activity: the quiz opens, no confirmation, no hand-in box.
- [ ] The code's switch off: the box is gone; a launch just opens the quiz. On again: back.
- [ ] A code whose window has ended: "This quiz has ended, so the result can't be handed in."
- [ ] Unlink in Settings removes the link; the next launch asks again.
- [ ] A hand-typed `novedu_code` on a quiz without the switch opens the quiz with no box.

## 9. Report and clean up

Report what ran: Moodle version, browsers, each checklist line with what you saw, the gradebook lines. Never
paste the session cookie, the private key or a launch token.

Clean up: `npx tsx …/novedu-session.mts --delete <userId>` for each minted student, `docker stop
novedu-moodle-pg`, stop the fake LLM, the fixtures server and the dev server, delete the scratch key files,
and the test tool and activity in Moodle if they are not needed again.
