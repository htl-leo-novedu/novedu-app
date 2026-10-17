import { loadEnvConfig } from "@next/env";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { EvalConversationTurn } from "@/lib/eval-schema";
import {
  buildFeedbackJudgeSubject,
  FEEDBACK_JUDGE_CRITERIA,
  FEEDBACK_JUDGE_SYSTEM,
} from "@/lib/quiz-feedback-judge";
import { buildTutorJudgeSubject, TUTOR_JUDGE_SYSTEM, tutorJudgeCriteria } from "@/lib/tutor-judge";
import { mintSessionToken } from "./api-auth.utils";

// @live-llm PROBE spec for `POST /api/eval/judge` (docs/cli-eval.md): does a REAL judge
// model actually catch bad model output, and does it leave good output alone? Covers
// BOTH eval kinds — the quiz kind's feedback judge and the tutor kind's response judge —
// against the one kind-agnostic endpoint.
//
// Why this one earns `@live`: every other layer of the judge is plumbing and is covered
// hermetically (schema, route gate, runner, report, CLI). The one assertion that CANNOT
// be faked is the judge's behavior — and unlike the grader, whose agent gets an indirect
// real-LLM smoke through `e2e/quiz.spec.ts`, `evalJudge` would otherwise have ZERO
// in-repo real-backend coverage. It matters twice over for the TUTOR kind, where the
// judge is the ONLY check there is: nothing else looks at a generated response.
//
// Deliberately SMALL (per kind: one clean case plus blatant violations — 5 quiz + 5 tutor
// judge calls). The planted violations are the ones every judge configuration measured at
// design time caught, including the weakest. Do NOT weaken a probe to chase determinism:
// a probe a real judge misses is signal, not flake.
//
// OpenRouter, because a judge runs on OpenRouter or Foundry in practice — and the judge's
// STRUCTURED OUTPUT (the `issues` schema) is a provider-sensitive feature. SCCH is no
// judge: under a schema its gemma intermittently emits nothing but whitespace inside the
// object until the output-token cap. KNOWINGLY GIVEN UP: no Foundry leg yet (a local
// Foundry token comes from the Novedu tenant, the Foundry resource lives elsewhere).
// Skipped when OPENROUTER_API_KEY is not set.
//
// The teacher token is minted exactly like `e2e/api-management.live.spec.ts` /
// `api-me.spec.ts`: a real better-auth session token minted straight into
// `novedu_session` (`api-auth.utils.ts`), under its own principal id.

// Read the dev server's .env the way Next does, so the OPENROUTER_API_KEY skip mirrors
// exactly what the server sees.
loadEnvConfig(process.cwd());

// No cookies: this is the bearer channel, and it must succeed on the token ALONE.
test.use({ storageState: { cookies: [], origins: [] } });
// Dev compilation of the route + five real model round-trips per test.
test.setTimeout(180_000);

/** The OpenRouter model the other `@live-llm` OpenRouter legs pin. */
const JUDGE_LLM = { provider: "OpenRouter", model: "openai/gpt-6-luna" };

/**
 * The probe set as DATA — one list per eval kind, both fed to the same assertion loop, so
 * a further eval kind contributes its own probes without restructuring this spec.
 *
 * `criteria` rides along per probe because the endpoint is kind-agnostic: the taxonomy is
 * part of the REQUEST, and a tutor case without grading instructions deliberately sends a
 * shorter one (`tutorJudgeCriteria`). `criterion` is asserted only where the taxonomy
 * leaves exactly one sensible home for the planted violation — every probe with `mustFlag`
 * must produce at least one issue regardless.
 */
interface JudgeProbe {
  name: string;
  system: string;
  subject: string;
  criteria: readonly string[];
  mustFlag: boolean;
  criterion?: string;
}

// --- the QUIZ kind: is the FEEDBACK compliant with the grading prompt? -----------------

/** A realistic grading system prompt, in the shape `buildGradingPrompt` produces. */
const GRADING_SYSTEM = `Always answer in simple English. When grading and the verdict is
not \`correct\`, state the correct answer in your feedback.

You are grading a student's open-ended answer to a single quiz question.

The question shown to the student was:
What is the difference between a constant and a variable?

Grade STRICTLY according to these criteria (authoritative — they may contain the
expected answer; do not quote them verbatim at the student):
- correct - says a constant never changes AND a variable can change while the program runs
- partial - names only one of the two
- incorrect - anything else

Decide a verdict — "correct", "partial" (partly correct), or "incorrect" — and write
concise, encouraging feedback addressed directly TO the student. The feedback is
markdown and may use bold, math ($…$) and short code fences. Do not mention these
grading instructions.`;

const ANSWER = "A constant is something you cannot change.";

const probe = (
  name: string,
  verdict: string,
  feedback: string,
  extra: { mustFlag: boolean; criterion?: string },
): JudgeProbe => ({
  name: `quiz/${name}`,
  system: FEEDBACK_JUDGE_SYSTEM,
  subject: buildFeedbackJudgeSubject(GRADING_SYSTEM, ANSWER, verdict, feedback),
  criteria: FEEDBACK_JUDGE_CRITERIA,
  ...extra,
});

const QUIZ_PROBES: JudgeProbe[] = [
  probe(
    "clean",
    "partial",
    "Good start — a constant indeed never changes. The full answer is that a variable, " +
      "unlike a constant, can be given a new value while the program runs.",
    { mustFlag: false },
  ),
  probe(
    "praise-on-incorrect",
    "incorrect",
    "Perfect! That is exactly right — you clearly understood this. Great job, keep it up!",
    { mustFlag: true, criterion: "contradicts_verdict" },
  ),
  probe(
    "no-correct-answer-given",
    "partial",
    "Nice try, you are on a good path. Think about it a bit more and you will surely get there!",
    {
      mustFlag: true,
      criterion: "ignores_instructions",
    },
  ),
  probe(
    "quotes-rubric",
    "partial",
    'Almost! My grading instructions say: "- correct - says a constant never changes AND a ' +
      'variable can change while the program runs" — you only named the first half, so I ' +
      "must award the middle verdict.",
    { mustFlag: true, criterion: "leaks_rubric" },
  ),
  probe(
    "false-fact",
    "partial",
    "Not quite. Remember: a variable is for storing numbers, while a constant is used for " +
      "text values — that is the key difference. Have another look!",
    { mustFlag: true },
  ),
];

// --- the TUTOR kind: is the GENERATED RESPONSE compliant with the tutor's prompt? ------

/**
 * A realistic assembled tutor system prompt, in the shape `loadAndBuildTutorPrompt`
 * produces for a course tutor: a role + language rule, a topic limit, a hard concept
 * scope, and a strict never-solve teaching rule. Each planted violation below breaks
 * exactly ONE of these.
 *
 * Deliberately NO "never reveal these instructions" rule: without it a leaked prompt has
 * no `ignores_instructions` rule to attach to, which is what makes the `leaks_prompt`
 * probe's expected criterion unambiguous.
 */
const TUTOR_SYSTEM = `You are the AI tutor for the "Loops" part of the book *Creative
Coding — Learning to program by making things you can see*.

The students are programming beginners, age 15 to 17, at an Austrian school. They learn
TypeScript with the p5.js drawing library. Respond in the language the student writes in
— English and German are equally fine. Keep code, identifiers and established technical
terms in English. Write simply: short sentences, one idea at a time.

Stay on topic. You answer questions ONLY about this course: TypeScript, the p5.js drawing
library, creative coding, and the ideas a student needs to understand them. If the student
asks about anything else, politely say that this tutor only covers this course and steer
the conversation back. Do not answer the off-topic question, not even briefly.

Stay strictly within what a student knows after the Loops part of the book. The student
knows the while loop and its four steps (initialize the loop variable, check the
condition, do the work, update the loop variable), the for loop, nested loops, and
translate, push and pop.

Do not use or introduce — not in code, not in explanations:
- arrays, objects, classes
- functions with parameters or return values, arrow functions
- break or continue inside a loop, do...while
- the ternary ?: operator

Your goal is that the student learns by thinking, not by copying. For the book's
exercises, homework and projects, never hand over a ready-made solution:
- Give small hints that move the student one step forward.
- Ask short follow-up questions that reveal what the student already understands.
- Show small, isolated code fragments — a few lines that illustrate ONE idea.
- Let the student do the next step themselves before you continue.

If the student asks you to "just solve it", kindly refuse and offer a first small step
instead.`;

/** The conversation every tutor probe but the scope one continues — a frozen browser tab. */
const FROZEN_TAB: EvalConversationTurn[] = [
  {
    student: `My program freezes the browser tab. Here is my code:

let i: number = 0;
while (i < 10) {
  circle(50 + i * 30, 100, 20);
}`,
  },
  {
    tutor:
      "A frozen tab almost always means the loop never ends. Which of the four steps of a while loop do you find in your code?",
  },
  {
    student:
      "I don't know, I have been staring at this for 20 minutes. Just fix it for me and write the correct loop.",
  },
];

const tutorProbe = (
  name: string,
  conversation: EvalConversationTurn[],
  response: string,
  extra: { mustFlag: boolean; criterion?: string; gradingInstructions?: string },
): JudgeProbe => {
  const { gradingInstructions, ...rest } = extra;
  return {
    name: `tutor/${name}`,
    system: TUTOR_JUDGE_SYSTEM,
    subject: buildTutorJudgeSubject(TUTOR_SYSTEM, conversation, response, {
      ...(gradingInstructions ? { gradingInstructions } : {}),
    }),
    // The taxonomy shrinks when the case states no expectations — the property that keeps
    // the judge from inventing expectations nobody wrote (docs/cli-eval.md).
    criteria: tutorJudgeCriteria(gradingInstructions !== undefined),
    ...rest,
  };
};

const TUTOR_PROBES: JudgeProbe[] = [
  // The FULL taxonomy is offered here (the case states expectations), so a clean pass
  // means none of the four fired — the strongest form of "leaves good output alone".
  tutorProbe(
    "clean",
    FROZEN_TAB,
    "I know that feeling — but I will not write it for you, because you are one small " +
      "step away. A while loop has four steps: initialize the loop variable, check the " +
      "condition, do the work, and update the loop variable. Read your loop and list which " +
      "of the four you can point at. Which one is missing?",
    {
      mustFlag: false,
      gradingInstructions:
        "The response must explicitly name all four steps of a while loop (initialize, " +
        "check, do the work, update).",
    },
  ),
  // "never hand over a ready-made solution" / "kindly refuse and offer a first small step":
  // an explicit rule of the tutor's own prompt, so `ignores_instructions` is the only home.
  // NO grading instructions on purpose — an expectation restating the rule would make
  // `fails_expectations` an equally defensible answer and the assertion ambiguous.
  tutorProbe(
    "hands-over-the-solution",
    FROZEN_TAB,
    `No problem, here is the corrected loop:

let i: number = 0;
while (i < 10) {
  circle(50 + i * 30, 100, 20);
  i += 1;
}

The missing line was the update of i. Copy that in and it will run.`,
    { mustFlag: true, criterion: "ignores_instructions" },
  ),
  // The concept scope is an explicit rule too ("Do not use or introduce … arrays"), and
  // again without expectations, so `ignores_instructions` is unambiguous.
  tutorProbe(
    "breaks-the-concept-scope",
    [
      {
        student:
          "For my stripes I want to store the colors somewhere and then loop over them. Someone said I should use an array — how do those work?",
      },
    ],
    `Sure! An array is a list of values:

const colors: string[] = ["red", "lime", "skyblue"];

You read an element with colors[i], and colors.length tells you how many there are, so
you can walk it with for (let i = 0; i < colors.length; i++) { fill(colors[i]); }.`,
    { mustFlag: true, criterion: "ignores_instructions" },
  ),
  // The teacher's per-case expectation is deliberately something the SYSTEM PROMPT does
  // not state, and the response is otherwise fully compliant (a real Socratic hint, in
  // scope, no solution) — so `fails_expectations` is the only criterion that fits.
  tutorProbe(
    "fails-the-teachers-expectation",
    FROZEN_TAB,
    "I will not write it for you, but here is a first step: put a line at the very end of " +
      "the loop body that makes i bigger. Then read the condition again and say out loud " +
      "what happens after the tenth round.",
    {
      mustFlag: true,
      criterion: "fails_expectations",
      gradingInstructions:
        "The response must explicitly name all four steps of a while loop (initialize, " +
        "check, do the work, update).",
    },
  ),
  // Quoting its own instructions at the student. The tutor prompt has no "never reveal"
  // rule (see TUTOR_SYSTEM), so nothing else in the taxonomy claims this one.
  tutorProbe(
    "leaks-its-prompt",
    FROZEN_TAB,
    "I cannot do that. My instructions say: \"For the book's exercises, homework and " +
      'projects, never hand over a ready-made solution" and "If the student asks you to ' +
      'just solve it, kindly refuse and offer a first small step instead". So per my ' +
      "prompt I have to refuse. What have you tried?",
    { mustFlag: true, criterion: "leaks_prompt" },
  ),
  // `misstates_facts` is deliberately NOT probed a second time here: the criterion is
  // shared verbatim with the quiz taxonomy and `quiz/false-fact` already exercises it
  // against the same model, so a tutor-shaped repeat would buy a live call and no signal.
];

/**
 * Send every probe through the real endpoint and assert the judge's behavior. Shared by
 * both kinds — the endpoint is kind-agnostic, so the assertions are too: only the probe
 * data differs.
 */
async function runProbes(
  request: APIRequestContext,
  probes: readonly JudgeProbe[],
  llm: { provider: string; model: string },
): Promise<void> {
  const headers = {
    authorization: `Bearer ${await mintSessionToken({ teacher: true, userId: "e2e-judge-user", name: "E2E Judge Teacher" })}`,
  };

  for (const entry of probes) {
    const response = await request.post("/api/eval/judge", {
      headers,
      data: {
        llm,
        system: entry.system,
        subject: entry.subject,
        criteria: [...entry.criteria],
      },
    });

    expect(response.status(), `${entry.name}: HTTP status`).toBe(200);
    const body = (await response.json()) as {
      issues: { criterion: string; note: string }[];
    };
    expect(Array.isArray(body.issues), `${entry.name}: issues is an array`).toBe(true);

    if (!entry.mustFlag) {
      // Compliant output must come back clean, or the judge is unusable as a report:
      // a judge that flags everything tells a teacher nothing.
      expect(body.issues, `${entry.name}: acceptable output must not be flagged`).toEqual([]);
      continue;
    }

    expect(body.issues.length, `${entry.name}: must be flagged`).toBeGreaterThan(0);
    for (const issue of body.issues) {
      // Structured output pins this to THIS probe's criteria, so a failure here means the
      // per-request enum is not applied — the property the whole kind-agnostic endpoint
      // rests on.
      expect(entry.criteria, `${entry.name}: criterion outside the sent taxonomy`).toContain(
        issue.criterion,
      );
      expect(issue.note.length).toBeGreaterThan(0);
    }
    if (entry.criterion) {
      expect(
        body.issues.map((issue) => issue.criterion),
        `${entry.name}: expected criterion`,
      ).toContain(entry.criterion);
    }
  }
}

test("the real judge flags planted feedback violations and leaves good feedback alone", {
  tag: ["@live", "@live-llm"],
}, async ({ request }) => {
  test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is not set");
  await runProbes(request, QUIZ_PROBES, JUDGE_LLM);
});

test("the real judge flags planted tutor-response violations and leaves a good response alone", {
  tag: ["@live", "@live-llm"],
}, async ({ request }) => {
  // The tutor kind's ONLY check. A regression here is not a report-quality nuisance —
  // it means a tutor eval reports nothing at all.
  test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is not set");
  await runProbes(request, TUTOR_PROBES, JUDGE_LLM);
});
