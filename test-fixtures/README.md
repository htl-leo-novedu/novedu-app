# Test fixtures

Frozen, **synthetic** activity YAML authored purely for the automated tests —
**not** demos. They are intentionally minimal and built from explicit `MARKER`
strings so it is obvious they are test scaffolding. Keep them **content-stable**:
tests assert on their exact ids, markers, and error shapes.

Nothing here depends on the repo's [`activities/`](../activities) folder (which
holds real demo content, free to restructure). These files exist because two
layers genuinely need a real file/URL:

- **CLI** — `@novedu/cli validate <path>` reads a file, so the CLI tests point at
  `test-fixtures/activities/…`.
- **e2e** — the app fetches an activity YAML by URL server-side; `serve.mjs`
  serves this tree over HTTP as a second Playwright `webServer` (see
  `playwright.config.ts`), so specs run fully offline.

`serve.mjs` additionally fakes a few app endpoints so the CLI's integration
tests run end to end offline (any bearer accepted). Each is a test double, never
a second implementation — anything policy-relevant belongs in the real route and
its own tests:

- `GET /api/version` — the build-identity probe, with a configurable CLI version.
- `GET`/`POST /api/codes` — list and mint (in-memory store, deterministic
  `synced0001…` codes) for `codes sync` (`docs/registry.md`).
- `POST /api/eval/grade`, `/api/eval/respond`, `/api/eval/judge` — a deterministic
  grader, tutor and judge for `eval`, steered by markers in the fixtures and with
  injectable failures for the retry paths (`docs/cli-eval.md`).
- `POST /api/images/<name>` — the one-shot multipart image upload for `images upload`.

The `lib/tutors` unit tests need no files at all — their synthetic tutor/fragment
fixtures live in-code in `lib/tutors/test-fixtures.ts`.

## Models

Hermetic fixtures use a fake `model: test-model` (nothing calls an LLM). The seven
LLM-backed fixtures carry a **real** model id: `tutors/live-tutor.yaml`,
`tutors/live-tools-tutor.yaml`, `tutors/vision-tutor.yaml`,
`quizzes/vision-quiz.yaml`, `writings/test-writing.yaml`,
`coding/live-coding.yaml` and `cloze/live-cloze.yaml`. The vision pair and
`live-cloze.yaml` serve only `@live-llm` specs (the live SCCH endpoint); the others also back CI specs that run against the fake LLM, which
answers whatever model id it is asked for (`docs/testing.md`, "Fake LLM").

## Layout

```
activities/
  tutors/    test-tutor.yaml (→ test-fragments-a.yaml), test-fragments-a.yaml,
             broken-tutor.yaml (→ broken-fragments.yaml), broken-fragments.yaml,
             broken-template-fragments.yaml, tools-tutor.yaml,
             broken-tools-tutor.yaml, eval-tutor.yaml (the tutor evals' target),
             live-tutor.yaml, live-tools-tutor.yaml, vision-tutor.yaml [real model id]
  quizzes/   test-quiz.yaml, broken-quiz.yaml, fragments-quiz.yaml,
             vision-quiz.yaml [real model id]
  writings/  test-writing.yaml [real model id], broken-writing.yaml, fragments-writing.yaml
  coding/    test-coding.yaml, broken-coding.yaml, fragments-coding.yaml,
             live-coding.yaml [real model id]
  cloze/     test-cloze.yaml, broken-cloze.yaml (schema-valid, broken gaps),
             live-cloze.yaml [real model id]
  evals/     quiz evals (→ quizzes/test-quiz.yaml): test-eval.yaml, mismatch-eval.yaml,
             judge-eval.yaml, broken-eval.yaml;
             tutor evals: tutor-eval.yaml, tutor-judge-eval.yaml, broken-tutor-eval.yaml
             (→ tutors/eval-tutor.yaml), tutor-tools-eval.yaml,
             tutor-old-server-eval.yaml (→ tutors/tools-tutor.yaml)
  registry/  broken-activities.yaml  (an INVALID activity registry — the valid
             one is written to a temp dir by the test, its base-url carries the
             fixtures server's ephemeral port)
```

The `fragments-*.yaml` files exercise the shared fragment pipeline for every kind
(→ `tutors/test-fragments-a.yaml`).
