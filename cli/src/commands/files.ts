import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { failJson, runApiRequest } from "../api";

// App-hosted YAML file management over the bearer API (docs/api.md): upload is
// an UPSERT (create if the name is free — `--kind` then required — else a new
// version, validated against the stored kind), list mirrors the /files page's
// filters. JSON in/out — see cli/src/api.ts for the output contract.

const SERVER_OPTION = [
  "--server <url>",
  "Novedu server base URL (defaults to the NOVEDU_SERVER env var, then production)",
] as const;

interface UploadOptions {
  server?: string;
  kind?: string;
  file?: string;
}

interface ListOptions {
  server?: string;
  search?: string;
  all?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function registerFiles(program: Command): void {
  const files = program
    .command("files")
    .description("Manage app-hosted YAML files on the Novedu server");

  files
    .command("upload <name>")
    .description(
      "Create or update an app-hosted YAML file from --file or stdin (validated server-side)",
    )
    .option(
      "--kind <kind>",
      "file kind (tutor, fragment, quiz, writing, coding, cloze) — required when creating",
    )
    .option("--file <path>", "read the YAML from this path instead of stdin")
    .option(...SERVER_OPTION)
    .action(async (name: string, options: UploadOptions) => {
      let content: string;
      try {
        content =
          options.file === undefined ? await readStdin() : await readFile(options.file, "utf8");
      } catch (error) {
        failJson({
          message: `Could not read ${options.file}: ${error instanceof Error ? error.message : error}`,
        });
        return;
      }

      await runApiRequest({
        server: options.server,
        path: `/api/files/${encodeURIComponent(name)}`,
        method: "PUT",
        body: {
          ...(options.kind === undefined ? {} : { kind: options.kind }),
          content,
        },
      });
    });

  files
    .command("list")
    .description("List app-hosted YAML files (defaults to only your own, like the web list)")
    .option("--search <q>", "contains-filter over name/title/description")
    .option("--all", "include files last written by other teachers")
    .option(...SERVER_OPTION)
    .action(async (options: ListOptions) => {
      const params = new URLSearchParams();
      if (options.search) params.set("q", options.search);
      if (options.all) params.set("mine", "0");
      const query = params.toString();
      await runApiRequest({
        server: options.server,
        path: `/api/files${query ? `?${query}` : ""}`,
      });
    });
}
