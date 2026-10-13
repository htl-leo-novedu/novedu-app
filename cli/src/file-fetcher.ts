import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaultFetcher, type Fetcher, type ValidationError } from "@/lib/prompt-fragments";
import { readSessions, SESSIONS_PATH, serverOrigin } from "./auth";
import { resolveServerUrl } from "./server-url";

// A composite `Fetcher` (the tutor core's single network seam): `file://` URLs are
// read from disk, everything else delegates to the app's production fetcher. This
// is all the CLI needs to point the *unchanged* validation pipeline at a local
// tutor YAML — the loader resolves relative `fragment_files` against the tutor's
// `file://` URL, so sibling fragment files are read from the same folder.
//
// A missing/unreadable file is reported as a 404 so it surfaces as the core's
// normal `FETCH_FAILED` error rather than throwing.
//
// Uploaded files (`<server>/api/files/<name>`) are readable only by teachers, so an
// http(s) request to an origin the CLI is signed in to (`novedu-cli login`, the
// session file) carries that session's bearer token. NO other origin ever receives a
// token, and an authenticated request refuses redirects so the token cannot follow
// one to another host. `NOVEDU_TOKEN` (tests/CI, see `getAccessToken`) stands in for
// the session of the resolved server only. A 401/403 from an uploaded-file URL is
// remembered, so the command can tell the teacher to sign in (`signInErrors`).

export interface CliFetcher {
  fetch: Fetcher;
  /** One `FETCH_FAILED` hint per origin whose uploaded files were refused (401/403). */
  signInErrors(): ValidationError[];
}

const UPLOADED_FILE_PATH = /^\/api\/files\//;

export function createCliFetcher(sessionsPath: string = SESSIONS_PATH): CliFetcher {
  const refused = new Set<string>();

  const tokenFor = (origin: string): string | undefined => {
    const override = process.env.NOVEDU_TOKEN?.trim();
    if (override && origin === serverOrigin(resolveServerUrl())) return override;
    return readSessions(sessionsPath)[origin]?.token;
  };

  const fetch: Fetcher = async (url) => {
    if (url.startsWith("file:")) {
      try {
        const text = await readFile(fileURLToPath(url), "utf8");
        return { ok: true, status: 200, text: async () => text };
      } catch {
        return { ok: false, status: 404, text: async () => "" };
      }
    }
    const parsed = new URL(url);
    const token = tokenFor(parsed.origin);
    const res = token
      ? await defaultFetcher(url, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
        })
      : await defaultFetcher(url);
    if ((res.status === 401 || res.status === 403) && UPLOADED_FILE_PATH.test(parsed.pathname)) {
      refused.add(parsed.origin);
    }
    return res;
  };

  const signInErrors = (): ValidationError[] =>
    [...refused].map((origin) => ({
      code: "FETCH_FAILED",
      message: `Uploaded files on ${origin} are readable only by teachers — sign in with "novedu-cli login --server ${origin}" (teacher account).`,
      url: origin,
    }));

  return { fetch, signInErrors };
}

const shared = createCliFetcher();

/** The CLI's fetcher (the default session file). */
export const cliFetcher: Fetcher = shared.fetch;

/** The sign-in hints {@link cliFetcher} collected during this run. */
export function signInErrors(): ValidationError[] {
  return shared.signInErrors();
}
