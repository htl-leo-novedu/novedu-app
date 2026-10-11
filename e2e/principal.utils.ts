import { randomBytes, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import type { BrowserContext } from "@playwright/test";
import { STUDENT_MODE_COOKIE } from "../lib/student-mode-constants";
import { COOKIE_NAME } from "./auth.constants";
import { query } from "./db";
import { sessionCookieValue } from "./session-cookie";

// Minting a signed-in principal: a `novedu_user` row plus a `novedu_session`
// row, and the signed cookie a browser sends (docs/auth.md). Shared by the
// suite's auth setup (the two standing principals) and the specs that need a
// FRESH user — one with no history in any table, which the shared principals
// can never guarantee because other specs write usage for them.
//
// Free of Playwright's `test()`, so setup files and specs may import it.

export const SESSION_DAYS = 1;

export interface Principal {
  id: string;
  name: string;
  email: string;
  /** `novedu_user.given_name`, what the start page greets with; NULL when absent. */
  givenName?: string;
}

/** Creates (or refreshes) the principal's user row and returns a fresh session token. */
export async function mintSession(principal: Principal, isTeacher: boolean): Promise<string> {
  await query(
    `INSERT INTO novedu_user (id, name, email, email_verified, is_teacher, given_name, created_at, updated_at)
     VALUES ($1, $2, $3, true, $4, $5, now(), now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           is_teacher = EXCLUDED.is_teacher,
           given_name = EXCLUDED.given_name,
           updated_at = now()`,
    [principal.id, principal.name, principal.email, isTeacher, principal.givenName ?? null],
  );

  const token = randomBytes(24).toString("base64url"); // 32 chars
  await query(
    `INSERT INTO novedu_session (id, token, user_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, now() + interval '${SESSION_DAYS} day', now(), now())`,
    [randomUUID(), token, principal.id],
  );

  return token;
}

/** AUTH_SECRET, loaded from `.env` exactly as Next does. */
export function authSecret(): string {
  loadEnvConfig(process.cwd());
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is missing — cannot sign an e2e session cookie.");
  return secret;
}

/** The session cookie for a minted token, in Playwright's cookie shape. */
export async function sessionCookie(token: string) {
  return {
    name: COOKIE_NAME,
    value: await sessionCookieValue(token, authSecret()),
    domain: "localhost",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const,
    expires: Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60,
  };
}

/**
 * The student-mode cookie for the session signed in on `context`, as "View as
 * student" would set it: its value is that session's id (docs/auth.md,
 * "Student mode"), looked up from the session token in the context's cookie.
 */
export async function studentModeCookie(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === COOKIE_NAME);
  if (!cookie) throw new Error("No session cookie in this context — sign in first.");
  const token = decodeURIComponent(cookie.value).split(".")[0];
  const [row] = await query<{ id: string }>(`SELECT id FROM novedu_session WHERE token = $1`, [
    token,
  ]);
  if (!row) throw new Error("The context's session cookie names no novedu_session row.");
  return { name: STUDENT_MODE_COOKIE, value: row.id, domain: "localhost", path: "/" };
}

/**
 * A fresh student with no history, signed in on `context`. The id starts with
 * `e2e-` so the auth setup's sweep of dead e2e sessions covers it. Call
 * `deletePrincipal` in a `finally`.
 */
export async function signInFreshStudent(
  context: BrowserContext,
  name: string,
  givenName?: string,
): Promise<Principal> {
  return signInFresh(context, name, givenName, false);
}

/** A fresh teacher with no codes and no history, signed in on `context` — see `signInFreshStudent`. */
export async function signInFreshTeacher(
  context: BrowserContext,
  name: string,
  givenName?: string,
): Promise<Principal> {
  return signInFresh(context, name, givenName, true);
}

async function signInFresh(
  context: BrowserContext,
  name: string,
  givenName: string | undefined,
  isTeacher: boolean,
): Promise<Principal> {
  const id = `e2e-${randomUUID()}`;
  const principal = { id, name, email: `${id}@example.com`, givenName };
  await context.addCookies([await sessionCookie(await mintSession(principal, isTeacher))]);
  return principal;
}

/** Removes a fresh principal's auth rows and the per-user rows its visits may have written. */
export async function deletePrincipal(id: string): Promise<void> {
  await query(`DELETE FROM novedu_user_settings WHERE user_id = $1`, [id]);
  await query(`DELETE FROM novedu_quiz_results WHERE user_id = $1`, [id]);
  await query(`DELETE FROM novedu_achievements WHERE user_id = $1`, [id]);
  await query(`DELETE FROM novedu_session WHERE user_id = $1`, [id]);
  await query(`DELETE FROM novedu_user WHERE id = $1`, [id]);
}
