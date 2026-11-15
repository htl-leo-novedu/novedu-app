import type { MoodleConnection } from "@/lib/moodle-config";
import { signWithToolKey } from "@/lib/moodle-config";
import { recordError } from "@/lib/telemetry";

// Talking to Moodle's grade service (LTI AGS, docs/moodle.md). Server-only,
// no `"use server"`, imported only by the hand-in action. Two calls:
//   - a token: a JWT signed with the tool key, posted to Moodle's token URL as
//     `client_credentials` with the single `score` scope, kept in this
//     process's memory until shortly before it expires, dropped on a 401;
//   - the score: `POST <line item path>/scores` (the path gets `/scores` BEFORE
//     the query string).
// Both time out after 10 seconds. Never throws; URLs, tokens and bodies are
// never logged — only the HTTP status.

const SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const TIMEOUT_MS = 10_000;
const EARLY_EXPIRY_MS = 60_000;

export type ScoreResult = "ok" | "not-found" | "failed";

export interface Score {
  /** The linked Moodle user id. */
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  comment: string;
}

let cachedToken: { key: string; token: string; expiresAt: number } | undefined;

/** Appends `suffix` to the URL's PATH, keeping its query string after it. */
export function withPath(url: string, suffix: string): string {
  const target = new URL(url);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${suffix}`;
  return target.toString();
}

function failure(op: string, status: number | string): void {
  const error = new Error(`moodle-ags: ${op} failed`);
  console.error(error.message, { status });
  recordError(error, { op: `moodle-${op}`, status: String(status) });
}

async function accessToken(connection: MoodleConnection, now: number): Promise<string | undefined> {
  const key = `${connection.tokenUrl} ${connection.clientId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt - EARLY_EXPIRY_MS > now) {
    return cachedToken.token;
  }
  cachedToken = undefined;
  try {
    const assertion = await signWithToolKey(
      { iss: connection.clientId, sub: connection.clientId },
      connection.tokenUrl,
    );
    const response = await fetch(connection.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope: SCORE_SCOPE,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      failure("token", response.status);
      return undefined;
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      failure("token", "no-token");
      return undefined;
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
    cachedToken = { key, token: body.access_token, expiresAt: now + lifetime * 1000 };
    return body.access_token;
  } catch {
    failure("token", "network");
    return undefined;
  }
}

/** Posts one score to the line item. A 401 drops the token and tries once more. */
export async function postScore(
  connection: MoodleConnection,
  lineitemUrl: string,
  score: Score,
  now: Date = new Date(),
): Promise<ScoreResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(connection, now.getTime());
    if (!token) return "failed";
    try {
      const response = await fetch(withPath(lineitemUrl, "/scores"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/vnd.ims.lis.v1.score+json",
        },
        body: JSON.stringify({
          userId: score.userId,
          scoreGiven: score.scoreGiven,
          scoreMaximum: score.scoreMaximum,
          comment: score.comment,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp: now.toISOString(),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return "ok";
      if (response.status === 401 && attempt === 0) {
        cachedToken = undefined;
        continue;
      }
      if (response.status === 404) return "not-found";
      failure("score", response.status);
      return "failed";
    } catch {
      failure("score", "network");
      return "failed";
    }
  }
  return "failed";
}

/** Drops the cached token — for unit tests only. */
export function resetAgsForTests(): void {
  cachedToken = undefined;
}
