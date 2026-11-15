// The code picker's fixed messages (docs/moodle.md), keyed by the error key
// `POST /api/lti/pick` puts in the address. Nothing in them depends on the code.
export const PICK_ERRORS = {
  unknown: "No quiz found for this code.",
  "not-quiz": "This code is not a quiz. Only quizzes can be handed in to Moodle.",
  "not-enabled":
    "This code is not set up for Moodle. Open the code in Novedu, tick 'Students can hand in results to Moodle' and try again.",
  unavailable: "Codes cannot be checked right now. Please try again in a moment.",
} as const;

export type PickError = keyof typeof PICK_ERRORS;

export function isPickError(value: unknown): value is PickError {
  return typeof value === "string" && Object.hasOwn(PICK_ERRORS, value);
}
