// What a person types or pastes as a code — the start page's code field and the
// Moodle code picker (docs/moodle.md) — normalized to the code itself. Pure and
// client-safe.

/**
 * Accepts a bare code OR a pasted activity URL (`https://host/<code>`) and
 * extracts the code — the last non-empty path segment. Lowercased so a code
 * retyped from paper in caps still works. Returns undefined for input that
 * cannot be a code. Mirrors CODE_PATTERN (lib/code-store.ts): 1–32 chars of
 * [a-z0-9-], so future memorable codes are accepted too.
 */
export function extractCode(input: string): string | undefined {
  let candidate = input.trim();
  if (candidate === "") return undefined;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const segments = new URL(candidate).pathname.split("/").filter(Boolean);
      candidate = segments[segments.length - 1] ?? "";
    } catch {
      return undefined;
    }
  }
  candidate = candidate.toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(candidate) ? candidate : undefined;
}
