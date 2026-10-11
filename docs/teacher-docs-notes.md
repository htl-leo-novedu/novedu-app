# Teacher-guide chapter notes

Guardrails for editing the teacher guide in `teacher-docs/src/content/docs/`. Each entry
holds only what a chapter does **not** say plainly itself: facts that are easy to
get wrong, things a chapter must not claim, and scope boundaries between
chapters. Voice and audience rules live in `teacher-docs/style.md` and the
`novedu-teacher-docs` skill, not here.

Most chapters have no entry. That is not an omission: it means the chapter's own
prose carries everything an editor needs.

## Rules that span chapters

- **No version numbers and no release history**, for the app, the CLI, or the
  skills tool. The app is under heavy development, so a version is stale within
  weeks. Describe how things behave now.
- **SCCH is a PARTNER the school buys hosting from**, not hardware the school
  owns: never "the school's own server", "self-hosted", or "in-house". Expand it
  once as "the school's Austrian LLM hosting partner"; later mentions are "SCCH"
  or "the school's hosting partner".
- The **`00-introduction/**` chapters are concept level**: no YAML field names
  and no configuration steps, those belong to the later chapters.

## 50-develop-and-evaluate (both chapters)

- Readers: an evaluator (a teacher or school IT person trying Novedu before a
  school sets it up) and a contributor working on the code. They run commands,
  so commands, settings, and file names are in scope, unlike the rest of the
  guide. Each chapter is still self-contained and in the guide's voice.
- Test every command before changing it: the chapters are step-by-step and a
  reader copies them verbatim. Both chapters were written against a fresh clone
  with no `.env`.
- The local Novedu is ALWAYS the demo login: anyone who reaches it signs in as
  anyone. Never suggest exposing it beyond the reader's own computer, and never
  suggest real student data.
- One database per sign-in mode: the Compose database is a demo database. The
  Entra-mode e2e suite needs a second database (placeholders for the Entra
  settings, sessions minted in the database, no real Entra).
- The fake model answers every model id, lists itself as `novedu-fake`, and
  grades every quiz answer as correct. OpenRouter is the only real-model path
  offered here (an env passthrough); SCCH is geo-blocked and Foundry needs an
  Azure identity.
- No OpenRouter prices or minimums as facts: OpenRouter changes them. Name
  concepts (credit, a per-key credit limit, `:free` variants with a daily cap).

## 00-introduction/03-tutors-overview

- "Start over" clears the student's conversation, it does not delete it. The
  earlier conversation stays visible to the teacher under the code, and a report
  already filed on it still reaches them. Never let the chapter imply the student
  can erase anything.
- A restart makes a SECOND conversation. A student who chats before and after
  counts twice in the code's statistics, so the number of conversations is not the
  number of students. A restart with nothing typed into it does not count at all.
- Only the tutor chat has the button. Do not generalise it to quizzes or writing
  activities.
- A reload brings the current conversation back only in the SAME browser tab and
  only while its last message is less than one hour old. Closing the tab, another
  tab or another device, and signing out all start fresh. Never call the
  conversation "saved" for this: nothing new is stored, and a resumed conversation
  adds nothing to the statistics.
- Reopening earlier conversations exists ONLY in per-user tutors, and only within
  the same tutor (code): a student never sees another code's conversations or
  anyone else's. Reopening adds no conversation to the statistics.

## 00-introduction/07-environments

- Reader: a teacher deciding where to build, test, and run an activity, and one
  with prototype-era codes asking where they went.
- The "What we had during the prototype phase" section is a DELIBERATE exception
  to the no-history rule, requested by the project lead because the move affects
  every existing user. Keep it to that one section; no dates, no versions.
- DEV has NO availability guarantee and its data is kept without a guarantee.
  Never let the chapter suggest DEV for regular class use; ongoing
  prototype-era activities may continue there.
- What moved from the prototype to DEV: everything except chat messages and
  sign-in credentials (sessions, CLI sessions, coding API keys). Quiz answers are
  not stored anywhere, so never list them as moved or kept. `novedu.at` forwards
  to PROD, where prototype codes do not exist.
- Codes, uploaded files, and images are per environment; only the school account
  is shared. The CLI's default is PROD.
- The environment strip under the top bar: green = PROD, yellow = DEV (a violet
  LOCAL one exists only on a developer's machine; leave it out). Its × hides it
  for the browser tab's session, not permanently and not per account. The guide
  itself (docs.novedu.at, one version for both stages) shows no strip.

## 10-yaml-for-teachers/06-testing-the-grader

- Never state a rate, a per-answer time or a total for a whole-course run: speed
  depends on the model and how busy it is, it changes over time, and a concrete
  number would read as a promise. "Up to several hours" is as precise as it gets.
- Flagged feedback is reported, never a failure. Do not let the chapter suggest a
  run can fail because of it, and do not present the judge as a second opinion on
  the MARK — it only ever looks at the wording.
- A passing run certifies the file on the teacher's own machine. If the quiz is
  hosted in the app, the same file still has to be uploaded afterwards, or the
  shared code keeps serving the old criteria. The most important caveat in the
  chapter; the same holds for a tutor eval.
- Nothing is stored in Novedu: no eval file, no answer, no mark and no judgment is
  saved in the app. The only files a run writes are local reports the teacher asks
  for (`--report`, `--out`). Same for tutor evals.

## 10-yaml-for-teachers/07-testing-a-tutor

- Nothing gates. A flagged response and a missing tool call are both notes. The
  exit code reflects run health only: an invalid file, a call that errored, a case
  the run never reached.

## 20-building-activities/02-available-llms

- The per-code override's provider and model are both-or-nothing, and a reasoning
  level only works alongside them. The override replaces the WHOLE `llm:` block,
  so an override that names no reasoning level also drops the one in the YAML.
- Do not print a fixed list of model names; they are school-set and change. Naming
  a model when describing how it handles reasoning levels is fine, that is a
  measured observation, but frame it as an example of the three behaviours rather
  than a catalogue.
- Do not invent prices, rates, or budgets; there are none in the sources. Say
  which side costs money per use and let the teacher act on it.
- This chapter sits closest to internals: describe the teacher's choice and its
  effect, never how a provider connects or authenticates.

## 20-building-activities/04-quizzes

- Skips live only in the student's browser for one attempt: nothing is stored,
  and teachers see nothing about them (no statistics, no transcript).

- In a compound quiz, `instructions` is the ONE thing that is not ignored, and it
  must NOT be described as "ignored": the chapter quiz's top-level `instructions:`
  text TRAVELS with its questions, but for GRADING only, and it is ADDITIVE — the
  final quiz's own `instructions` apply first, then the chapter's on top. Do NOT
  claim an imported question is graded identically to how its chapter quiz grades
  it.
- `question_count` bounds one attempt only, in the student's browser: it is not a
  server-enforced exam limit, nothing stops a reload starting a fresh attempt, and
  a repeated question is simply graded again.
- Do NOT state a per-photo size limit. There are two different ones (what a
  student may pick, and what is sent after the browser prepares the photo), and
  quoting either invites a teacher to tell students a phone photo is too big when
  it is not. The count (three per answer) is the only number worth giving.
- Photo preparation happens in the STUDENT's browser, so describe it as something
  that just happens, never as a step anyone configures. HEIC is the one format
  worth naming: it is an iPhone default and the only common case that can fail
  outright.
- The live hint while typing is **never the grade**, and the chapter must never let
  it read as one: it is one icon plus a tooltip, it produces no written feedback,
  nothing about it is stored, and the verdict still comes from `evaluation` on
  Submit. It also reads only the typed text, so it says nothing about a photo.
- Never name the classifier behind the hint, the AI service it runs on, or the
  server setting that enables it. A teacher's whole view of the switch is "your
  school's server has this turned on, or it doesn't"; `immediate_feedback` only
  ever turns it off for one quiz, it can never turn it on.

## 20-building-activities/07-fragments

- There is no `priority` and no separate `fragments:` list; order is simply where
  you place the marker. Do not describe priority ordering.
- Keep this the one deep fragment chapter: the tutors, quiz, writing and coding
  chapters cover placing fragments from the consumer side and should stay lighter.

## 30-sharing-activities/04-anonymous-vs-per-user

- Tutor history follows the mode: in an anonymous tutor students cannot return to
  an earlier conversation (a reload in the same tab keeps the current one for up to
  an hour after its last message; never call that "saved"); in a per-user tutor
  they can reopen their own earlier conversations with that one tutor, never
  another tutor's or another student's.
- The history appears only while the code is per-user AND its file still says so.
  If a teacher edits the file's mode after creating the code, students get no
  history; that edge case belongs in the engineer docs, not in the guide (the
  guide promises the mode is fixed at creation).

## 30-sharing-activities/01-creating-codes

- Ownership rules differ per object and must not be mixed up: a **code's** owner
  is the teacher who created it and never changes hands, while a hosted **file's**
  or **image's** owner is whoever saved it LAST.

## 30-sharing-activities/02-viewing-usage

- An orientation, not a full dashboard manual. Keep it short.

## 30-sharing-activities/09-your-start-page

- The teacher start page covers ONLY the codes the reading teacher created, and
  shows counts, never a student's name. Do not suggest it shows the whole school.
- "Identified students" undercounts by design: anonymous activities can't be
  counted, and a coding key proves the student opened the activity, not that they
  used it.
- School hours are Monday to Friday, 8:00 up to 17:00 Austrian time; weekends are
  outside all day; holidays are not known.
- A teacher in "view as student" mode sees the student start page, built from
  their own use, not the dashboard.
- Teacher badges have no XP and none is hidden. Crowd counts identified students
  on ONE activity (never summed across activities); Listener counts reports the
  teacher resolved on ANY code; Iterator counts versions the teacher saved of one
  file. A stored badge is never taken back. Badges are private to the teacher.

## 30-sharing-activities/06-coding-special-case

- Sharing a coding code is NOT special: it gets the same share link as every
  other kind of activity. What is still special is what a student does
  after opening it (sign in, then get a personal connection key) — do not revive
  "the code is the key" framing.
- A student's personal key is stable: the same key comes back on every visit,
  from any device. It is never rotated or reissued on demand.
- Closing a code's availability window disables every key issued for that code
  at once. Reopening or extending the window brings the SAME keys back to life;
  nobody has to reconnect their tool or get a new key. Only deleting the code
  destroys the keys for good.
- Key issuance (who requested a key, and when) is attributed to the requester.
  The coding conversations that follow through that key are never stored and
  never attributed to anyone; do not blur the two into "coding is per-user now".
- The teacher's own key is behind a **button** on the code's page, and the
  issued-keys list is a list of USERS, not only students — a teacher who presses
  it appears in it. Never write that the page shows the teacher's key
  automatically: opening a coding code's page records nothing.
- The activity code string itself still grants nothing on its own: a bare code
  pasted into a coding tool does not work, only a personal key does, and getting
  one requires signing in.

## 30-sharing-activities/08-activity-registry

- Do not describe matching as a lookup by name: the app knows nothing about the
  registry, and the names live only in the two files in the repository.

## 30-sharing-activities/10-exporting-conversations

- Reader: a teacher who wants a code's conversations as one file, usually to hand
  to an AI assistant. The how-to-analyse part lives in 40-ai-llms/03; keep this
  chapter to what the file holds and how to get it.
- Only the teacher who CREATED the code can export it. Other teachers can still read
  the conversations on the code's page, but the export refuses them. Do not soften
  this to "teachers can export".
- The file never names a student, for ANY code, per-user ones included: no name,
  no id, no pseudonym. But message text is exported as typed, so do not promise
  that nobody can be identified: a student may have written identifying details.
- It never contains photos (only "a photo of this type and size was here"). Saved
  writing texts are not exported as records of their own, but a writing feedback
  chat can contain draft passages (the AI reads the draft and may quote it).
- "The same conversations as the code's page" holds for tutor and quiz codes only;
  a per-user writing code's page lists savers, not chats.
- A coding code exports nothing but the header line: coding conversations are never
  stored.
- Only conversations in which a student wrote at least one message count, the same
  rule as the code's page. A very long conversation keeps only its last 500 messages
  and is marked as shortened.
- The export is CLI-only (no button in the web app). Without `--out` a failed export
  leaves the lines it already wrote in the redirected file; with `--out` the partial
  file is removed.

## 40-ai-llms/03-learning-from-conversations

- Reader: a teacher who wants to improve an activity from how students actually
  used it, with an AI assistant doing the reading. Process chapter; the export
  itself is 30-sharing-activities/10.
- The data-protection note is mandatory: the file has no names, but it holds what
  students wrote, which can include personal details they typed themselves. The
  teacher decides, under the school's rules, which assistant may see it.
- Don't promise what any specific assistant can do (same rule as 40-ai-llms/02);
  name products only as examples. The assistant's findings are suggestions the
  teacher checks against the transcripts.
- The loop ends where the existing tools are: change the YAML, check it with the
  CLI, test it with an eval when the grading or tutor rules changed, then publish
  the new version.

## 40-ai-llms/01-novedu-cli

- Keep the CLI part at overview level. Do not duplicate the validate, prompts,
  eval, or codes chapters; name what the CLI can do and let the later chapters
  teach the commands.

## 40-ai-llms/02-llms-txt

- Don't promise what any specific assistant can do. Phrase abilities as "an
  assistant that can fetch web pages", and name products only as examples, never
  as a complete or guaranteed list.
