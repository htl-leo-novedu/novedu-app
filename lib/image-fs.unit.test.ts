import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The filesystem adapter over REAL `mkdtemp` roots: the sentinel contract, the
// key-containment rules, the exclusive reservation, the byte cap, and the
// promise that no failure path ever leaves a readable `content`. Only injected
// I/O failures are faked — through a `node:fs/promises` mock that delegates to
// the real module unless a one-shot failure is armed, so every other assertion
// runs against the actual filesystem.

const inject = vi.hoisted(() => ({ fail: new Map<string, Error>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // One-shot: the armed failure fires once, so a cleanup path that repeats the
  // same call still gets the real implementation.
  const armed = (name: string): Error | null => {
    const error = inject.fail.get(name);
    if (!error) return null;
    inject.fail.delete(name);
    return error;
  };
  const guard =
    <A extends unknown[], R>(name: string, original: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const error = armed(name);
      if (error) throw error;
      return original(...args);
    };
  return {
    ...actual,
    mkdir: guard("mkdir", actual.mkdir),
    rename: guard("rename", actual.rename),
    rm: guard("rm", actual.rm),
    lstat: guard("lstat", actual.lstat),
    stat: guard("stat", actual.stat),
    readFile: guard("readFile", actual.readFile),
    access: guard("access", actual.access),
    async open(...args: Parameters<typeof actual.open>) {
      const error = armed("open");
      if (error) throw error;
      const handle = await actual.open(...args);
      // The handle's own methods are armed the same way, so a failing
      // write/sync/close/rename can each be pinned separately.
      return new Proxy(handle, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "write" && prop !== "sync" && prop !== "close") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...callArgs: unknown[]) => {
            const failure = armed(prop);
            if (failure) throw failure;
            return (value as (...a: unknown[]) => unknown).apply(target, callArgs);
          };
        },
      });
    },
  };
});

import {
  deleteObject,
  inspectObject,
  OBJECT_KEY_PATTERN,
  openObject,
  SENTINEL_CONTENT,
  SENTINEL_FILE,
  verifyImageRoot,
  writeNewObject,
} from "@/lib/image-fs";

const MAX = 5 * 1024 * 1024;
const KEY = "11111111-2222-3333-4444-555555555555.png";
const OTHER_KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.svg";

const roots: string[] = [];

/** A provisioned root (directory + `images/` + the exact sentinel bytes). */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "novedu-image-fs-"));
  roots.push(root);
  await mkdir(path.join(root, "images"));
  await writeFile(path.join(root, SENTINEL_FILE), SENTINEL_CONTENT);
  vi.stubEnv("IMAGE_STORAGE_ROOT", root);
  return root;
}

function bytes(source: Uint8Array | string): ReadableStream<Uint8Array> {
  const data = typeof source === "string" ? new TextEncoder().encode(source) : source;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

/** A source that yields one chunk and then fails, like a cut-short upload. */
function failingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("source exploded"));
    },
  });
}

function contentPath(root: string, key: string): string {
  return path.join(root, "images", key, "content");
}

beforeEach(() => {
  inject.fail.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

describe("verifyImageRoot", () => {
  it("accepts a provisioned root", async () => {
    const root = await makeRoot();
    await expect(verifyImageRoot()).resolves.toEqual({ ok: true, root });
  });

  it("reports an unset IMAGE_STORAGE_ROOT without touching the filesystem", async () => {
    vi.stubEnv("IMAGE_STORAGE_ROOT", "");
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "unset" });
  });

  it("reports a missing root, naming the path", async () => {
    const root = await makeRoot();
    await rm(root, { recursive: true, force: true });
    const check = await verifyImageRoot();
    expect(check).toMatchObject({ ok: false, reason: "missing", root });
    if (check.ok) return;
    expect(check.detail).toContain(root);
  });

  it("reports a root that is a file, not a directory", async () => {
    const root = await makeRoot();
    const asFile = path.join(root, "not-a-dir");
    await writeFile(asFile, "x");
    vi.stubEnv("IMAGE_STORAGE_ROOT", asFile);
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "not-directory" });
  });

  it("reports a root without the marker file", async () => {
    const root = await makeRoot();
    await rm(path.join(root, SENTINEL_FILE));
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "no-sentinel" });
  });

  it("requires the marker's exact bytes — a missing trailing LF fails", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, SENTINEL_FILE), "novedu-files-v1");
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "bad-sentinel" });
  });

  it("requires the marker's exact bytes — CRLF fails", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, SENTINEL_FILE), "novedu-files-v1\r\n");
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "bad-sentinel" });
  });

  it("requires the marker's exact bytes — a same-length wrong marker fails", async () => {
    const root = await makeRoot();
    expect(SENTINEL_CONTENT).toHaveLength(16);
    await writeFile(path.join(root, SENTINEL_FILE), "novedu-files-v2\n");
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "bad-sentinel" });
  });

  it("reports a root whose images/ directory is absent as not-writable", async () => {
    const root = await makeRoot();
    await rm(path.join(root, "images"), { recursive: true });
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "not-writable" });
  });

  it("NEVER creates the root, images/ or the marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "novedu-image-fs-bare-"));
    roots.push(root);
    const bare = path.join(root, "nested");
    vi.stubEnv("IMAGE_STORAGE_ROOT", bare);

    await verifyImageRoot();
    await writeNewObject(KEY, bytes("x"), MAX);
    await inspectObject(KEY);
    await openObject(KEY);
    await deleteObject(KEY);

    expect(existsSync(bare)).toBe(false);
    expect(existsSync(path.join(root, "images"))).toBe(false);
    expect(existsSync(path.join(root, SENTINEL_FILE))).toBe(false);
  });

  it("maps an unexpected stat failure to error", async () => {
    await makeRoot();
    inject.fail.set("stat", new Error("io exploded"));
    await expect(verifyImageRoot()).resolves.toMatchObject({ ok: false, reason: "error" });
  });
});

describe("object keys", () => {
  const attacks = [
    "",
    "..",
    "../../etc/passwd",
    "a/b.png",
    "a\\b.png",
    "x\0.png",
    "/etc/passwd",
    "11111111-2222-3333-4444-555555555555.gif",
    "11111111-2222-3333-4444-555555555555",
    "11111111-2222-3333-4444-555555555555.png.png",
    "11111111-2222-3333-4444-555555555555.PNG",
    "11111111-2222-3333-4444-555555555555.png/../../escape.png",
  ];

  it("only accepts a lowercase UUID plus a png/jpg/svg extension", () => {
    expect(OBJECT_KEY_PATTERN.test(KEY)).toBe(true);
    // An UPPERCASE UUID is not a key this server ever generates.
    expect(OBJECT_KEY_PATTERN.test(KEY.toUpperCase())).toBe(false);
  });

  it.each(attacks)("refuses %j on write without creating anything", async (key) => {
    const root = await makeRoot();
    await expect(writeNewObject(key, bytes("x"), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "invalid-key",
    });
    await expect(readdir(path.join(root, "images"))).resolves.toEqual([]);
    expect((await readdir(root)).sort()).toEqual(["images", SENTINEL_FILE].sort());
  });

  it.each(attacks)("refuses %j on inspect/open/delete as an error", async (key) => {
    await makeRoot();
    await expect(inspectObject(key)).resolves.toMatchObject({ ok: false, reason: "error" });
    await expect(openObject(key)).resolves.toMatchObject({ ok: false, reason: "error" });
    await expect(deleteObject(key)).resolves.toMatchObject({ ok: false, reason: "error" });
  });

  it("refuses a symlinked object directory instead of writing or reading through it", async () => {
    const root = await makeRoot();
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "content"), "secret");
    await symlink(elsewhere, path.join(root, "images", KEY));

    await expect(writeNewObject(KEY, bytes("x"), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });
    // The link's target is untouched.
    await expect(readFile(path.join(elsewhere, "content"), "utf8")).resolves.toBe("secret");
  });

  it("refuses a symlinked content file on read", async () => {
    const root = await makeRoot();
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "secret");
    await mkdir(path.join(root, "images", KEY));
    await symlink(secret, contentPath(root, KEY));

    await expect(openObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
    await expect(inspectObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
  });
});

describe("writeNewObject", () => {
  it("publishes the exact bytes and reports the measured length", async () => {
    const root = await makeRoot();
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(writeNewObject(KEY, bytes(payload), MAX)).resolves.toEqual({
      ok: true,
      byteLength: 8,
    });
    expect(new Uint8Array(await readFile(contentPath(root, KEY)))).toEqual(payload);
  });

  it("leaves no temporary file beside the published content", async () => {
    const root = await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(path.join(root, "images", KEY))).resolves.toEqual(["content"]);
  });

  it("reserves the key exclusively — a second write reports exists and keeps the first object", async () => {
    const root = await makeRoot();
    await writeNewObject(KEY, bytes("first"), MAX);
    await expect(writeNewObject(KEY, bytes("second"), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "exists",
    });
    await expect(readFile(contentPath(root, KEY), "utf8")).resolves.toBe("first");
  });

  it("refuses an empty source and leaves nothing behind", async () => {
    const root = await makeRoot();
    await expect(writeNewObject(KEY, bytes(new Uint8Array()), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(existsSync(path.join(root, "images", KEY))).toBe(false);
  });

  it("accepts exactly the cap", async () => {
    const root = await makeRoot();
    await expect(writeNewObject(KEY, bytes(new Uint8Array(MAX)), MAX)).resolves.toEqual({
      ok: true,
      byteLength: MAX,
    });
    expect(existsSync(contentPath(root, KEY))).toBe(true);
  });

  it("refuses one byte over the cap and leaves nothing behind", async () => {
    const root = await makeRoot();
    await expect(writeNewObject(KEY, bytes(new Uint8Array(MAX + 1)), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "too-large",
    });
    expect(existsSync(path.join(root, "images", KEY))).toBe(false);
  });

  it("reports a failing source and leaves no temp file or object directory", async () => {
    const root = await makeRoot();
    await expect(writeNewObject(KEY, failingStream(), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "source",
    });
    expect(existsSync(path.join(root, "images", KEY))).toBe(false);
  });

  it("reports an unavailable root when it disappears between operations", async () => {
    const root = await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    await rm(root, { recursive: true, force: true });

    await expect(writeNewObject(OTHER_KEY, bytes("x"), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(inspectObject(KEY)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(openObject(KEY)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(deleteObject(KEY)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it.each(["open", "write", "sync", "close", "rename"])(
    "reports a failing %s and publishes no content",
    async (step) => {
      const root = await makeRoot();
      inject.fail.set(step, new Error(`${step} exploded`));
      await expect(writeNewObject(KEY, bytes("hello"), MAX)).resolves.toMatchObject({
        ok: false,
        reason: "error",
      });
      expect(existsSync(contentPath(root, KEY))).toBe(false);
      expect(existsSync(path.join(root, "images", KEY))).toBe(false);
    },
  );

  it("reports a failing mkdir that is not a collision as an error", async () => {
    await makeRoot();
    inject.fail.set("mkdir", Object.assign(new Error("no space"), { code: "ENOSPC" }));
    await expect(writeNewObject(KEY, bytes("hello"), MAX)).resolves.toMatchObject({
      ok: false,
      reason: "error",
    });
  });
});

describe("inspectObject / openObject", () => {
  it("reports an absent object as data, not an error", async () => {
    await makeRoot();
    await expect(inspectObject(KEY)).resolves.toEqual({ ok: true, exists: false });
    await expect(openObject(KEY)).resolves.toEqual({ ok: true, missing: true });
  });

  it("round-trips the exact bytes with their length", async () => {
    await makeRoot();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    await writeNewObject(KEY, bytes(payload), MAX);

    await expect(inspectObject(KEY)).resolves.toEqual({ ok: true, exists: true, byteLength: 5 });
    const opened = await openObject(KEY);
    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok || !("stream" in opened)) throw new Error("expected a stream");
    const read = new Uint8Array(await new Response(opened.stream).arrayBuffer());
    expect(read).toEqual(payload);
  });

  // Running as root ignores the mode bits, so this case only proves anything for
  // an ordinary user.
  it.skipIf(process.getuid?.() === 0)(
    "reports an unreadable object as an error, never as absence",
    async () => {
      const root = await makeRoot();
      await writeNewObject(KEY, bytes("hello"), MAX);
      await chmod(path.join(root, "images", KEY), 0o000);
      try {
        await expect(inspectObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
        await expect(openObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
      } finally {
        await chmod(path.join(root, "images", KEY), 0o700);
      }
    },
  );

  it("maps an injected lstat failure to an error", async () => {
    await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    inject.fail.set("lstat", new Error("io exploded"));
    await expect(inspectObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
  });
});

describe("deleteObject", () => {
  it("removes the object and reports that it existed", async () => {
    const root = await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    await expect(deleteObject(KEY)).resolves.toEqual({ ok: true, existed: true });
    expect(existsSync(path.join(root, "images", KEY))).toBe(false);
  });

  it("is idempotent — a second delete reports existed: false", async () => {
    await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    await deleteObject(KEY);
    await expect(deleteObject(KEY)).resolves.toEqual({ ok: true, existed: false });
  });

  it("maps an injected removal failure to an error", async () => {
    await makeRoot();
    await writeNewObject(KEY, bytes("hello"), MAX);
    inject.fail.set("rm", new Error("io exploded"));
    await expect(deleteObject(KEY)).resolves.toMatchObject({ ok: false, reason: "error" });
  });
});

// The provisioning helper and the adapter must agree on the marker byte-for-byte
// or a freshly initialized root would fail its own verification. The helper is
// plain ESM under scripts/, loaded by path so this file compiles without it.
const helperPath = path.resolve(process.cwd(), "scripts/lib/image-root.mjs");

describe.skipIf(!existsSync(helperPath))("sentinel parity with scripts/lib/image-root.mjs", () => {
  it("uses the same marker file name and bytes", async () => {
    const helper = await import(pathToFileURL(helperPath).href);
    expect(helper.SENTINEL_FILE).toBe(SENTINEL_FILE);
    expect(helper.SENTINEL_CONTENT).toBe(SENTINEL_CONTENT);
  });
});
