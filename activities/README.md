# Activities

Authoring documentation and sample activity YAML for the chat app, with a clear
separation between **schema/docs** (one folder per module) and **examples**
(one folder per topic).

Each module folder holds that module's authoring guide plus a JSON Schema
**generated from the zod schema** (via `npm run generate:schemas`; do not hand-edit)
and referenced by a `# yaml-language-server:` modeline for editor IntelliSense:

| Folder | Module | Guide |
| --- | --- | --- |
| [`tutors/`](tutors/README.md) | AI tutor + fragment libraries | [tutors/README.md](tutors/README.md) |
| [`quizzes/`](quizzes/README.md) | LLM-graded open-ended quiz | [quizzes/README.md](quizzes/README.md) |
| [`writings/`](writings/README.md) | Markdown writing activity | [writings/README.md](writings/README.md) |
| [`coding/`](coding/README.md) | OpenAI-compatible coding endpoint | [coding/README.md](coding/README.md) |
| [`cloze/`](cloze/README.md) | Cloze exercise ("Fill the gaps") — one text with gaps | [cloze/README.md](cloze/README.md) |
| [`fragments/`](fragments/README.md) | Reusable prompt-fragment libraries (cross-cutting) | [fragments/README.md](fragments/README.md) |

Two more folders hold editor schemas without being modules:

- [`registry/`](registry/registry-yaml.schema.json) carries
  `registry-yaml.schema.json` for the **activity registry** — the hand-written file a
  publication keeps in its own repo listing the activities it embeds, reconciled by
  `novedu-cli codes sync`. It is not an activity and has no authoring guide here; the
  format is documented in [`../docs/registry.md`](../docs/registry.md) and
  [`../cli/README.md`](../cli/README.md).
- [`evals/`](evals/README.md) carries `eval-yaml.schema.json` for the three **eval**
  kinds run by `novedu-cli eval`: a **quiz** eval tests a quiz's grading (made-up
  student answers plus the verdict each must get, replayed through the real grader),
  a **tutor** eval replays scripted conversations and has a judge rate the tutor's
  next reply, and a **cloze** eval grades and explains made-up submissions to a cloze
  exercise. Students never
  see it and it never gets a code. Guide: [evals/README.md](evals/README.md),
  engineering reference: [`../docs/cli-eval.md`](../docs/cli-eval.md).

**Prompt fragments are a cross-cutting capability of all five kinds.** A fragment is a
reusable, parameterized prompt piece — a persona, a safety policy, a set of ground
rules — written once in a **fragment library**, declared in an activity under
`fragment_files:`, and placed with inline `{{fragment "alias.id" …}}` markers in the
activity's own host text: the tutor's `tutor_instructions`, writing's and coding's
`instructions`, and a quiz's two optional host texts — the top-level `instructions`
(rendered once and prepended to **both** the grader prompt and the discussion chat)
and `discussion.instructions` (discussion-only). A fragment renders
exactly where its marker sits — there is no ordering or priority concept. The fragment
format, `input_schema`, defaults, and marker syntax are fully documented once in the
tutor guide, [`tutors/README.md`](tutors/README.md); the other guides link back to
it, and the fragment-library **editor schema** lives in
[`fragments/`](fragments/README.md). Fragment libraries reused across kinds live in
[`examples/shared/`](examples/shared/) — e.g.
[`examples/shared/general-fragments.yaml`](examples/shared/general-fragments.yaml).

Complete sample activities live under [`examples/`](examples/), grouped by
**topic**: each topic folder combines all the YAML belonging to one teaching
unit — across modules — so the files that are used together sit together:

| Folder | Topic |
| --- | --- |
| [`examples/sorting-algorithms/`](examples/sorting-algorithms/) | Bubble & Selection Sort in TypeScript + p5.js — tutor, quiz, and coding activity |
| [`examples/review-writing/`](examples/review-writing/) | Writing an English review/critique — tutor, quiz, and writing activity |
| [`examples/future-forms/`](examples/future-forms/) | English future forms — a cloze exercise |
| [`examples/authoring/`](examples/authoring/) | Authoring coaches for teachers ("Tutor Tutor", "Quiz Tutor", …) + their fragment library |
| [`examples/shared/`](examples/shared/) | Fragment libraries reused across topics (referenced as `../shared/<name>.yaml`) |

Validate any file with the `@novedu/cli` (see [`cli/README.md`](../cli/README.md)):

```bash
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-tutor.yaml
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-quiz.yaml --kind quiz
npx @novedu/cli validate ./activities/examples/review-writing/restaurant-review-letter.yaml --kind writing
npx @novedu/cli validate ./activities/examples/sorting-algorithms/sorting-visualizer.yaml --kind coding
npx @novedu/cli validate ./activities/examples/future-forms/sue-fresh-start.yaml --kind cloze
```

Every module's `llm:` block takes the same three fields: a required `model`, an
optional `provider` (`SCCH` when omitted — the school's Austrian LLM hosting
partner; `Azure Foundry` serves the activity from an Azure OpenAI deployment,
with `model` naming the deployment; `OpenRouter` serves it through OpenRouter,
with `model` a namespaced id like `z-ai/glm-5.3-flash`) and an optional
`reasoning` effort (`none`,
`minimal`, `low`, `medium`, `high` or `xhigh`; omitted, the model's own default
applies, and `none` switches thinking off). Which of those levels a model
accepts, and whether the rest change anything at all, varies per model. See each
guide's `llm.provider` and `llm.reasoning` sections. Validate with a current
`@novedu/cli` — the CLI bundles the schemas, so an outdated copy rejects
provider names it does not know (`npx @novedu/cli@latest` bypasses a stale
npx cache).

The `llm:` block is the activity's **default**: when a teacher mints a code for
it, the code's create/edit form can **override the whole block per code**
(provider + model always together, with an optional reasoning level on top and
one-click presets), so the same YAML file can be handed out once on SCCH and once
on another provider without duplicating it.

These files are content only — they are not bundled into the runtime image.
