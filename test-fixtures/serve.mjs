// A tiny static file server for the on-disk test fixtures. Two consumers:
//   - Playwright's `webServer` (run directly: `node test-fixtures/serve.mjs`),
//     so e2e specs fetch activity YAML over HTTP, fully offline.
//   - the CLI integration test, which imports `startFixturesServer` and starts
//     one on an ephemeral port for its "fetch a URL" cases.
//
// Serves flat files under `test-fixtures/activities/<subpath>`; anything that
// resolves outside that root is refused (path-traversal guard). `GET /` is a
// health check. The whole handler is wrapped so a malformed request (e.g. a bad
// %-escape) answers 400 instead of crashing the long-lived shared process.
//
// It ALSO fakes the app's `/api/codes` endpoint (list + mint) so `codes sync`
// can be integration-tested end-to-end offline: same wire shape as
// `app/api/codes/route.ts`, deterministic codes, no YAML validation, and any
// bearer token accepted (the CLI supplies one via NOVEDU_TOKEN). It is a test
// double, never a second implementation — anything policy-relevant belongs in
// the app's route and its own tests.
//
// The same goes for `/api/eval/grade` (`novedu-cli eval`): the fake grader is
// DETERMINISTIC — it answers `correct` unless the answer carries a
// `[grade:<verdict>]` marker, with a plausible `usage` block so token totals are
// exercised — and `options.evalFailures` makes the first N requests answer 504 so
// the CLI's retry path is exercised offline.
//
// `/api/eval/respond` (the TUTOR eval kind's generator) follows the same convention:
// the generated turn is the `[respond:<text>]` marker's payload when the LAST student
// message carries one (so a test decides exactly what the judge then sees — including a
// planted `[judge:<criterion>]` marker), otherwise a canned echo. `options.respondFailures`
// makes the first N requests answer 504, exercising the retry path offline. Two more
// markers drive the `required_tools` check: `[tools:a,b]` reports those tool names as the
// call the generation made (no marker = `toolCalls: []`), and `[no-tool-calls]` OMITS the
// field entirely — the shape of a server too old to report tool calls, which the CLI must
// turn into a loud failure rather than a silent "nothing missing".
//
// `/api/eval/judge` (the judge, shared by both eval kinds) follows the same convention one level up:
// it answers an EMPTY `issues` list unless the request's `subject` carries
// `[judge:<criterion>]` markers — one issue per marker. (The judge's DEGRADE breaker
// is unit-tested in `cli/src/eval-run.unit.test.ts`; exercising it against the built
// binary would mean exhausting real retry backoffs, so there is no judge-failure
// option here.)
//
// It also fakes the public `GET /api/version` build-identity probe, whose
// `cliVersion` `novedu-cli eval` checks against its own before grading
// (`docs/cli-eval.md`). It defaults to the REAL `cli/package.json` version so an
// integration run is warning-free; `options.cliVersion` serves a different one so
// the mismatch warning is testable end to end.
//
// `POST /api/images/<name>` fakes the app's ONE-shot multipart image upload
// (app/api/images/[name]/route.ts): bearer required, exactly one `file` part
// plus a `mime` field (an optional `credit`) parsed the same way the real
// route does — `await new Response(buf, { headers: { "content-type": … }
// }).formData()`, 400 when that throws — then a fixed `201` with a synthetic
// `id`. It does not re-validate name/MIME/size the way the real route does (a
// test double, not a second implementation); every accepted upload is
// captured on the returned `imageUploads` array so a test can inspect the
// exact bytes and fields the CLI sent.

// `GET /api/codes/<code>/conversations` fakes the creator-only conversation export
// (app/api/codes/[code]/conversations/route.ts) for `novedu-cli codes export`: bearer
// required, and fixed codes — `export1` serves two pages (page one hands out the cursor
// `p2`, the page asked for with `after=p2` ends with `nextCursor: null`), `export403`
// answers 403 `{ message }` (someone else's code), anything else 404. Every request's
// `limit`/`after` is captured on the returned `exportRequests` array.

import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTIVITIES_ROOT = fileURLToPath(new URL("./activities/", import.meta.url));

/** The real CLI release this checkout ships — the default `/api/version` answer. */
const CLI_PACKAGE_VERSION = JSON.parse(
  await readFile(new URL("../cli/package.json", import.meta.url), "utf8"),
).version;

/**
 * Start the fixtures server on `port` (0 = an ephemeral free port). Resolves to
 * the server handle and its base URL once it is listening; rejects on a listen
 * failure (e.g. EADDRINUSE) instead of leaving the caller hanging.
 *
 * `options.codes` seeds the fake `/api/codes` store (the array is used as-is, so
 * a caller can inspect what a run minted). `options.evalFailures` makes the first
 * N `/api/eval/grade` requests answer 504 and `options.respondFailures` does the same
 * for `/api/eval/respond` (retry testing); every graded request is appended to the
 * returned `evalRequests` array, every generated one to `respondRequests`, and every
 * judged `/api/eval/judge` request to `judgeRequests`, and every accepted
 * `/api/images/<name>` upload to `imageUploads`. `options.cliVersion` overrides the
 * `cliVersion` `/api/version` reports (default: the real `cli/package.json` one), so
 * `eval`'s mismatch warning can be exercised.
 *
 * The typed return is what TypeScript consumers (the CLI integration test) see —
 * `allowJs` picks this JSDoc up straight from the implementation, so there is no
 * separate declaration file to drift.
 *
 * @param {number} [port]
 * @param {{ codes?: Array<Record<string, unknown>>, evalFailures?: number, respondFailures?: number, cliVersion?: string }} [options]
 * @returns {Promise<{ server: import("node:http").Server, baseUrl: string, codes: Array<Record<string, unknown>>, evalRequests: Array<Record<string, unknown>>, respondRequests: Array<Record<string, unknown>>, judgeRequests: Array<Record<string, unknown>>, imageUploads: Array<{ name: string, mime: string, credit: string | null, fileName: string, bytes: Buffer }>, exportRequests: Array<{ code: string, limit: string | null, after: string | null }> }>}
 */
export function startFixturesServer(port = 0, options = {}) {
  const codes = options.codes ?? [];
  let minted = 0;
  /** @type {Array<Record<string, unknown>>} */
  const evalRequests = [];
  /** @type {Array<Record<string, unknown>>} */
  const respondRequests = [];
  /** @type {Array<Record<string, unknown>>} */
  const judgeRequests = [];
  /** @type {Array<{ name: string, mime: string, credit: string | null, fileName: string, bytes: Buffer }>} */
  const imageUploads = [];
  /** @type {Array<{ code: string, limit: string | null, after: string | null }>} */
  const exportRequests = [];
  const evalState = { remainingFailures: options.evalFailures ?? 0 };
  const respondState = { remainingFailures: options.respondFailures ?? 0 };
  const reportedCliVersion = options.cliVersion ?? CLI_PACKAGE_VERSION;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (url.pathname === "/api/version") {
        // Public and unauthenticated, like the real route (app/api/version/route.ts).
        sendJson(res, 200, {
          version: "fixtures",
          gitSha: "fixtures",
          builtAt: "1970-01-01T00:00:00.000Z",
          cliVersion: reportedCliVersion,
        });
        return;
      }
      if (url.pathname === "/api/codes") {
        await handleCodes(req, res, codes, () => `synced${String(++minted).padStart(4, "0")}`);
        return;
      }
      if (url.pathname === "/api/eval/grade") {
        await handleEvalGrade(req, res, evalState, evalRequests);
        return;
      }
      if (url.pathname === "/api/eval/respond") {
        await handleEvalRespond(req, res, respondState, respondRequests);
        return;
      }
      if (url.pathname === "/api/eval/judge") {
        await handleEvalJudge(req, res, judgeRequests);
        return;
      }
      const exportMatch = /^\/api\/codes\/([^/]+)\/conversations$/.exec(url.pathname);
      if (exportMatch) {
        handleConversationExport(
          req,
          res,
          url,
          decodeURIComponent(exportMatch[1] ?? ""),
          exportRequests,
        );
        return;
      }
      if (url.pathname.startsWith("/api/images/")) {
        await handleImageUpload(req, res, url, imageUploads);
        return;
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(ACTIVITIES_ROOT, rel);
      if (!filePath.startsWith(ACTIVITIES_ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": "application/yaml" });
      res.end(body);
    } catch (error) {
      // ENOENT → 404; anything else (malformed %-escape, bad URL) → 400. Never
      // let an exception escape the async handler — it would kill the process.
      if (!res.headersSent) res.writeHead(error?.code === "ENOENT" ? 404 : 400);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        codes,
        evalRequests,
        respondRequests,
        judgeRequests,
        imageUploads,
        exportRequests,
      });
    });
  });
}

/** The fixed export fixture's conversations, one per page. */
const EXPORT_CODE_BLOCK = {
  code: "export1",
  module: "tutor",
  note: "Vektoren",
  fileUrl: "https://example.test/vektoren.yaml",
  anonymous: true,
};
const EXPORT_PAGES = {
  first: [
    {
      threadId: "thread-1",
      startedAt: "2026-10-07T09:00:00.000Z",
      endedAt: "2026-10-07T09:01:00.000Z",
      truncated: false,
      messages: [
        {
          role: "user",
          createdAt: "2026-10-07T09:00:00.000Z",
          content: "Wie berechne ich das Skalarprodukt?",
        },
        {
          role: "assistant",
          createdAt: "2026-10-07T09:01:00.000Z",
          content: [
            { type: "tool", name: "random_number", args: { min: 1, max: 6 }, result: { value: 4 } },
            { type: "text", text: "Komponentenweise multiplizieren und addieren." },
          ],
        },
      ],
    },
  ],
  second: [
    {
      threadId: "thread-2",
      startedAt: "2026-10-07T10:00:00.000Z",
      endedAt: "2026-10-07T10:00:30.000Z",
      truncated: false,
      messages: [
        {
          role: "user",
          createdAt: "2026-10-07T10:00:00.000Z",
          content: [
            { type: "text", text: "Hier mein Versuch:" },
            { type: "image", mimeType: "image/jpeg", bytes: 1834211 },
          ],
        },
        { role: "assistant", createdAt: "2026-10-07T10:00:20.000Z", content: "Fast richtig." },
        { role: "user", createdAt: "2026-10-07T10:00:30.000Z", content: "Danke!" },
      ],
    },
  ],
};

/** The fake `GET /api/codes/<code>/conversations` (see the header comment). */
function handleConversationExport(req, res, url, code, exportRequests) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  const after = url.searchParams.get("after");
  exportRequests.push({ code, limit: url.searchParams.get("limit"), after });
  if (code === "export403") {
    sendJson(res, 403, { message: "Only the code's creator can export its conversations." });
    return;
  }
  if (code !== "export1") {
    sendJson(res, 404, { message: "No code with that name." });
    return;
  }
  if (after === null) {
    sendJson(res, 200, {
      code: EXPORT_CODE_BLOCK,
      conversations: EXPORT_PAGES.first,
      nextCursor: "p2",
    });
  } else if (after === "p2") {
    sendJson(res, 200, {
      code: EXPORT_CODE_BLOCK,
      conversations: EXPORT_PAGES.second,
      nextCursor: null,
    });
  } else {
    sendJson(res, 400, { message: "after is not a valid cursor." });
  }
}

/** JSON reply helper for the fake API. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

/**
 * The fake `GET`/`POST /api/codes`. GET answers the store newest-first; POST
 * appends one row and answers 201 with it. Window bounds are normalized to ISO
 * UTC exactly like the real route, so a registry spelling a moment `+02:00`
 * still matches its stored code on the next run.
 */
/**
 * A window bound as the real route stores it: whole unix seconds (its
 * `isoToUnixSeconds` floors), rendered back as UTC. Keeping the milliseconds here
 * would make the fake more forgiving than production and hide a matching bug.
 */
function wholeSeconds(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(Math.floor(parsed / 1000) * 1000).toISOString();
}

async function handleCodes(req, res, codes, nextCode) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  const origin = `http://${req.headers.host ?? "127.0.0.1"}`;

  if (req.method === "GET") {
    sendJson(res, 200, [...codes].reverse());
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method not allowed" });
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { message: "The request body must be JSON." });
    return;
  }
  if (!body?.module || !body?.fileUrl) {
    sendJson(res, 400, { message: "module and fileUrl are required." });
    return;
  }

  const code = nextCode();
  const entry = {
    code,
    url: `${origin}/${code}`,
    module: body.module,
    note: body.note ?? "",
    fileUrl: new URL(body.fileUrl).href,
    anonymous: true,
    validFrom: wholeSeconds(body.validFrom),
    validUntil: wholeSeconds(body.validUntil),
    llm: body.llm ?? null,
    createdBy: "fixtures-teacher",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, codes.length)).toISOString(),
  };
  codes.push(entry);
  sendJson(res, 201, entry);
}

/** Read a request body as JSON, or `undefined` when it is not parseable. */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The fake `POST /api/eval/grade` (app/api/eval/grade/route.ts): bearer required,
 * POST only, the same required fields — then a DETERMINISTIC verdict so an
 * integration test can assert exact counts: `correct` unless the answer carries a
 * `[grade:partial]` / `[grade:incorrect]` / `[grade:correct]` marker. The first
 * `evalFailures` requests answer 504 instead, exercising the CLI's retry path.
 */
async function handleEvalGrade(req, res, state, requests) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method not allowed" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { message: "The request body must be JSON." });
    return;
  }
  if (!body?.llm?.model || !body?.system || !body?.answer) {
    sendJson(res, 400, { message: "llm.model, system and answer are required." });
    return;
  }

  if (state.remainingFailures > 0) {
    state.remainingFailures -= 1;
    sendJson(res, 504, { message: "Gateway timeout" });
    return;
  }

  requests.push(body);
  const marker = /\[grade:(correct|partial|incorrect)\]/.exec(String(body.answer));
  const result = marker ? marker[1] : "correct";
  // A plausible, DETERMINISTIC `usage` block (same wire shape as the real route's
  // optional one), so the CLI's token aggregation is exercised end to end offline.
  const usage = {
    input: 1000 + String(body.system).length,
    cachedInput: 256,
    output: 40 + String(body.answer).length,
  };
  sendJson(res, 200, { result, feedback: `fixtures grader says ${result}`, usage });
}

/**
 * The fake `POST /api/eval/respond` (app/api/eval/respond/route.ts): bearer required,
 * POST only, the same required fields — then a DETERMINISTIC generated turn. The LAST
 * message decides: a `[respond:<text>]` marker makes `<text>` the answer (so a fixture
 * can plant a `[judge:<criterion>]` marker INSIDE the generated response and prove it
 * reaches the judge's subject), otherwise a canned echo. The first `respondFailures`
 * requests answer 504 instead, exercising the CLI's retry path.
 */
async function handleEvalRespond(req, res, state, requests) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method not allowed" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { message: "The request body must be JSON." });
    return;
  }
  if (
    !body?.llm?.model ||
    !body?.system ||
    !Array.isArray(body?.messages) ||
    !body.messages.length
  ) {
    sendJson(res, 400, { message: "llm.model, system and messages are required." });
    return;
  }
  if (!Array.isArray(body?.tools)) {
    sendJson(res, 400, { message: "tools must be a list." });
    return;
  }

  if (state.remainingFailures > 0) {
    state.remainingFailures -= 1;
    sendJson(res, 504, { message: "Gateway timeout" });
    return;
  }

  requests.push(body);
  const last = String(body.messages.at(-1)?.text ?? "");
  // Greedy up to the FINAL bracket, so a marker payload may itself contain brackets
  // (e.g. a nested `[judge:…]` marker).
  const marker = /\[respond:([\s\S]*)\]/.exec(last);
  const text = marker ? marker[1] : `fixtures tutor replies to: ${last}`;
  const usage = {
    input: 800 + String(body.system).length,
    cachedInput: 64,
    output: 30 + text.length,
  };
  // `[no-tool-calls]` fakes a server too OLD to report tool calls: the field is absent
  // entirely, which a CLI must never read as "the tutor called nothing".
  if (/\[no-tool-calls\]/.test(last)) {
    sendJson(res, 200, { text, usage });
    return;
  }
  // `[tools:a,b]` reports those tool names, in that order; no marker means none ran.
  const toolMarker = /\[tools:([^\]]*)\]/.exec(last);
  const toolCalls = toolMarker
    ? String(toolMarker[1])
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
  sendJson(res, 200, { text, toolCalls, usage });
}

/**
 * The fake `POST /api/eval/judge` (app/api/eval/judge/route.ts): bearer required,
 * POST only, the same required fields — then a DETERMINISTIC judgment following the
 * grader's marker convention one level up. The feedback is acceptable (an EMPTY
 * `issues` list) unless the `subject` carries `[judge:<criterion>]` markers; each
 * marker becomes one issue with fixed note text, so an integration test can assert
 * exact flag counts.
 */
async function handleEvalJudge(req, res, requests) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method not allowed" });
    return;
  }
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { message: "The request body must be JSON." });
    return;
  }
  if (!body?.llm?.model || !body?.system || !body?.subject || !Array.isArray(body?.criteria)) {
    sendJson(res, 400, { message: "llm.model, system, subject and criteria are required." });
    return;
  }

  requests.push(body);
  const subject = String(body.subject);
  const issues = [...subject.matchAll(/\[judge:([a-z_]+)\]/g)]
    // Constrained to the caller's taxonomy, exactly like the real route's structured
    // output — a marker naming something else must not become an issue.
    .filter((match) => body.criteria.includes(match[1]))
    .map((match) => ({ criterion: match[1], note: `fixtures judge flagged ${match[1]}` }));
  const usage = {
    input: 500 + subject.length,
    cachedInput: 128,
    output: 20 + issues.length,
  };
  sendJson(res, 200, { issues, usage });
}

/**
 * The fake `POST /api/images/<name>` (app/api/images/[name]/route.ts): bearer
 * required, POST only, ONE multipart/form-data body — parsed the same way the
 * real route does, `await new Response(buf, { headers: { "content-type": … }
 * }).formData()`, 400 when that throws (a bad/missing boundary). Requires
 * exactly one `file` part and a `mime` field; `credit` is optional. Every
 * accepted upload is captured on `imageUploads` (name, mime, credit, the
 * file's own name, and its raw bytes) so a test can assert exactly what the
 * CLI sent, then answered with a synthetic `id` — this fake does not
 * re-validate name/MIME/size or reject a repeat name the way the real route
 * does.
 */
async function handleImageUpload(req, res, url, imageUploads) {
  if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
    sendJson(res, 401, { message: "Unauthorized" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method not allowed" });
    return;
  }

  const name = decodeURIComponent(url.pathname.slice("/api/images/".length));

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  let form;
  try {
    form = await new Response(buf, {
      headers: { "content-type": req.headers["content-type"] ?? "" },
    }).formData();
  } catch {
    sendJson(res, 400, { message: "The request body is not valid multipart/form-data." });
    return;
  }

  const fileParts = form.getAll("file");
  const mimeParts = form.getAll("mime");
  if (fileParts.length !== 1 || typeof fileParts[0] === "string" || mimeParts.length !== 1) {
    sendJson(res, 400, {
      message: "file must be sent exactly once as a file part, and mime exactly once.",
    });
    return;
  }
  const file = fileParts[0];
  const mime = String(mimeParts[0]);
  const creditParts = form.getAll("credit");
  const credit = creditParts.length ? String(creditParts[0]) : null;
  const bytes = Buffer.from(await file.arrayBuffer());

  imageUploads.push({ name, mime, credit, fileName: file.name, bytes });

  const id = `fixture-${imageUploads.length}`;
  sendJson(res, 201, { id, name, mimeType: mime, byteSize: bytes.length, credit });
}

// Run directly (Playwright webServer): listen on a fixed port and stay up.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.E2E_FIXTURES_PORT ?? 34567);
  const { baseUrl } = await startFixturesServer(port);
  console.log(`[fixtures] serving ${ACTIVITIES_ROOT} at ${baseUrl}`);
}
