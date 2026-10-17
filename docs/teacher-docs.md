# Teacher docs: the guide corpus & its docs site

One folder, `teacher-docs/`, holds two coupled pieces: the **corpus**
(`teacher-docs/src/content/docs/`) — the teacher-facing guide as hand-maintained
Markdown — and the **site** (the rest of the folder) — an Astro Starlight workspace
that renders it. The corpus is authoritative and site-agnostic: plain Markdown that
would survive any renderer, and the site adapts to its conventions, never the
reverse. Nothing in the Next.js app imports either, and the app does not serve
the guide: it is a separate static site at **https://docs.novedu.at**.

> TL;DR: to change a chapter, edit it in `teacher-docs/src/content/docs/` — by hand or via
> the `novedu-teacher-docs` skill — after reading its entry in
> `docs/teacher-docs-notes.md`. Chapters are kept current by reasoning over the
> git diff of a code change, with `teacher-docs/CHAPTERS.md` as the map from app
> area to chapter. To see the guide, `npm run docs:dev`
> (http://localhost:4321/). In production it ships **publicly at
> https://docs.novedu.at** (an Azure Static Web App, released by `promote.yml`),
> with `/llms.txt` (a table of contents), a `.md` twin of every chapter, and
> `/llms-full.txt` alongside it for AI agents. The corpus-contract unit test and
> the site build (`npm run docs:build`) are the corpus's consistency checks.

## The corpus (`teacher-docs/src/content/docs/`)

The whole corpus is **human-owned**: it is the source of truth, edited
directly — by hand or by an agent running the skill — and reviewed by a human
before it lands. Paths below are relative to `teacher-docs/`.

| Path | Owner | What |
| --- | --- | --- |
| `CHAPTERS.md` | human | chapter manifest = the information architecture authority |
| `style.md` | human | project voice / reading level |
| `src/content/docs/` | human | the Markdown corpus, the source of truth |
| `assets/` | curated | images (currently empty) |

Per-chapter guardrails — each chapter's reader job and the facts that are easy to
get wrong — live beside this doc in **`docs/teacher-docs-notes.md`**; an editor
reads the chapter's entry before changing it.

The maintenance rules (diff-driven patching, frontmatter contract, scope rule)
live in the **`novedu-teacher-docs` skill**. Note: `.claude` is a symlink to
`.agents`, so the skill exists once on disk at
`.agents/skills/novedu-teacher-docs/` and git tracks only that path.

### Chapter file contract

- Frontmatter: `title`, `description`, `sidebar.order`, `audience`, `keywords`,
  `related` (**optional** — content-relative slugs like
  `30-sharing-activities/03-time-limitation`, no leading slash, no extension).
- The body carries **no `#` H1** — the title renders from frontmatter; body
  headings start at `##`. (`# ` lines inside fenced code blocks are code, not
  headings.)
- Technical terms are explained in place, in plain prose — there is no glossary
  and no `[[term]]` marker syntax.

## The site (`teacher-docs/`)

Astro 7 + Starlight + `starlight-theme-rapide`, the `@novedu/teacher-docs` npm
workspace next to `cli`. Root scripts: `docs:dev` / `docs:build` / `docs:preview`.
Ships at the root of **https://docs.novedu.at** — see "Hosting on docs.novedu.at"
below. No custom CSS.

### Content pipeline

- `src/content.config.ts` defines the `docs` collection with Starlight's
  `docsLoader()` reading `src/content/docs`, the collection's default location
  and where the chapters live — so the corpus is read directly with no copy step
  and editing a chapter live-reloads a running dev server. A collection that
  comes up empty would still build green but hollow — which is why the `build`
  script ends with `teacher-docs/scripts/verify-dist.mjs`: a post-build check
  that **every** corpus chapter `<section>/<chapter>.md` produced its
  `dist/<section>/<chapter>/index.html` (so it also catches partial builds),
  that `index.html`, `404.html`, the Pagefind index and the sitemap files
  exist, and that every chapter has its Markdown twin plus an entry in both
  `llms.txt` and `llms-full.txt` (those come from their own `getCollection`
  call in `src/lib/llms.ts`, which could drop chapters while the pages still
  build; titles are not unique across the corpus, so the full-text check also
  counts chapter headings rather than trusting per-title presence alone). It
  fails the build loudly in every pipeline that funnels through
  `npm run docs:build`.
- **The [llms.txt](https://llmstxt.org) surface** is three own routes in
  `src/pages/` over one builder (`src/lib/llms.ts`), not a plugin — see "llms.txt
  and the Markdown twins" below.
- Those routes need Astro's **`site`**, since the table of contents is nothing but
  absolute URLs — the single seam for the guide's origin in `astro.config.mjs`
  (`https://docs.novedu.at`, hardcoded; the root README's "Changing the public
  domain" checklist ties every occurrence together). Knock-on effects to know about:
  Starlight registers `@astrojs/sitemap` on every build, and with a `site` set it
  emits `sitemap-index.xml` + `sitemap-0.xml` into `dist/` (HTML pages only — the
  `.md`/`.txt` routes are not listed), and every page gains a canonical / `og:url` tag pointing at that origin. Both are
  wanted for a public guide and neither is switchable.
- **`src/lib/sections.ts`** holds the sections in reading order, mirroring
  `CHAPTERS.md`. The Starlight `sidebar` config and the llms.txt table of contents
  both derive from it; `sectionLabel()` throws on a corpus directory that is not
  listed, so a new section fails the build rather than silently missing from either.
- The schema extends Starlight's `docsSchema` with the corpus fields; `audience`
  and `keywords` are required, `related` defaults to `[]`. A chapter
  violating the contract fails the build with a zod error naming the file.
- URL slugs keep the numeric prefixes (`/30-sharing-activities/01-creating-codes`)
  so they match `related:` slugs exactly.
- The site is served at the root of its origin (no Astro `base`), so internal
  links are plain root-relative paths (`/<section>/<chapter>/`).

### llms.txt and the Markdown twins

Three `src/pages/` routes over one builder (`src/lib/llms.ts`), deliberately
hand-rolled rather than plugin-driven: the corpus is plain Markdown with no MDX or
components, so the agent-facing output is the corpus **verbatim** — no HTML→Markdown
round trip, and no plugin whose `llms.txt` is only a list of bundle files.
(`starlight-llms-txt` was evaluated and dropped for exactly that reason; the
alternatives fare worse — `@wave-rf/starlight-llm-tools` peer-depends on
`starlight-glossary`, which this site deliberately does not have.)

| Route | Output |
| --- | --- |
| `llms.txt.ts` | `/llms.txt` — the table of contents: title, description, a preamble pointing agents at the `novedu-tutor-cli` skill chapter (the id is pinned as `CLI_CHAPTER_ID` in `src/lib/llms.ts` and build-verified against the corpus), then one `- [Title](absolute .md URL): description` line per chapter under its `## <section>` heading (sections from `sections.ts`, chapters by their frontmatter `sidebar.order` — the same key the Starlight sidebar sorts by). |
| `[...slug].md.ts` | `/<section>/<chapter>.md` — the chapter's **Markdown twin**: `# title`, `> description`, the body verbatim, and a footer linking the HTML page + the index. Pattern ends in `.md`, so it never collides with Starlight's `[...slug]` page catch-all. |
| `llms-full.txt.ts` | `/llms-full.txt` — every chapter concatenated in reading order behind a one-line `<SYSTEM>` header. |

Two consequences worth knowing:

- The only body transform is stripping any leading HTML comment. Twins therefore
  carry the source's straight quotes where the HTML pages show Starlight's
  smart-typographed ones — intended, since the twin is the text a teacher would
  edit.
- Because it is our code, the corpus's own frontmatter carries the TOC: `title` and
  `description` become the link text and its summary, which is why the chapter
  contract requires a `description`.

### Related chapters

`src/components/MarkdownContent.astro` (a Starlight component override) appends a
"Related chapters" `<LinkCard>` grid after the chapter body, resolving each
`related:` slug against the collection by entry id and showing the target's real
title. An unresolvable slug **throws, failing the build** — this is the corpus's
dead-link check.

### Verification

The **corpus contract is pinned by
`teacher-docs/src/lib/corpus-contract.unit.test.ts`** over the real corpus:
required frontmatter, resolvable `related:` slugs, no body H1. It is picked up
by the root vitest `unit` project (`**/*.unit.test.ts`), so it runs in
`npm test` and `qa` with no extra wiring (the file declares the `node` vitest
environment). `npm run docs:build` is the build-level check on top: schema
validation, dead-slug build failure, Pagefind index, and the post-build
`teacher-docs/scripts/verify-dist.mjs` output check (which also covers the llms.txt surface —
every chapter has a Markdown twin and appears in both index and full text). Typechecking follows the `cli` pattern — every
workspace is excluded from the root `tsc` program but gets its own leg in the
root `typecheck` script: `tsc --noEmit` (app) + `tsc -p cli` + `astro check`
(site, via `@astrojs/check`; covers `.astro` files and runs its own content
sync). CI's `npm run typecheck` therefore gates all three workspaces. Biome
needs no per-workspace wiring — the root `biome check .` sweeps everything —
except a `teacher-docs/**/*.astro`-scoped override in `biome.json`
(Biome only parses Astro frontmatter, so template-only imports would
false-positive as unused; the scope keeps the rules live for any future
`.astro` files elsewhere).

## Hosting on docs.novedu.at

The guide is **public for everybody** — deliberately no Entra sign-in in front of
it — and is not served by the Next.js app at all. The moving parts:

- **Azure Static Web App `swa-novedu-docs`** (Free, `rg-novedu-shared`, one
  version for both stages) with the custom domain `docs.novedu.at`
  (CNAME-validated, SWA-managed certificate). Resource, domain and the deploy
  identity's role are in `docs/azure-runtime-env.md`.
- **`teacher-docs/public/staticwebapp.config.json`**, copied into `dist/` by
  Astro (and required by `teacher-docs/scripts/verify-dist.mjs`), holds the only host
  configuration:
  - `.md` is served as `text/markdown; charset=utf-8` with
    `Content-Disposition: inline` (route `/*.md`) — browsers would otherwise
    download the twins instead of showing them. Agents don't care, humans do.
  - `.txt` is served as `text/plain; charset=utf-8`.
  - A 404 rewrites to Starlight's `404.html`.
  Everything else is the host's default: directory `index.html` resolution with
  and without a trailing slash, HTTPS, cache invalidation on deploy.
- **The app's former `/docs` paths** permanently redirect (308) to the same path
  on docs.novedu.at — `next.config.ts` `redirects()`, built from
  `TEACHER_GUIDE_URL` (`lib/teacher-guide.ts`, which the nav menu and the
  environment ribbon link through too). Redirects run before `proxy.ts`, so
  signed-out visitors and agents get them without a matcher exclusion.
- **Release = promotion.** `promote.yml` builds the guide from the commit of the
  image it promotes (the image's `APP_GIT_SHA`), so docs.novedu.at describes the
  app that app.novedu.at runs, and a rollback rolls the guide back too. The build
  writes that commit to `/version.txt`, which the workflow polls after the upload.
  A commit from before this hosting (no `staticwebapp.config.json`) leaves the
  guide as it is. Because the image version is the release unit,
  `docker-publish.yml` still builds an image for a guide-only change.
- **`cookie@2`**: npm cannot hoist every workspace dep to the root — a package
  whose root slot is taken by an incompatible version lands in the workspace's
  own `node_modules`. The site has exactly one such dep (`cookie@2`, shadowed at
  the root by express's `cookie@0.7.2` via `@copilotkit/runtime`), declared in
  `teacher-docs/package.json` and pinned by the root `overrides`. Astro's static
  build resolves it from disk when it imports the prerender entry back out of
  `dist/`, so the docs build needs that workspace tree in place — which a plain
  `npm ci` provides.

### CI/CD

- `qa.yml` runs `npm run docs:build` (and the corpus-contract test rides
  `test:unit`).
- `.github/workflows/docs.yml` is the light, **secret-free** gate for the PRs
  `qa.yml` skips via its `**.md` paths-ignore (docs-only changes): site unit
  tests + workspace typecheck + `docs:build` on `teacher-docs/**` changes.
- `docker-publish.yml` re-includes `teacher-docs/**` in its push paths (last
  matching pattern wins), so a merged corpus change publishes a fresh image
  version — the unit `promote.yml` releases. The image itself does not contain
  the guide.
- `promote.yml` builds the guide in its `docs-build` job, which holds **no**
  `id-token` (npm ci and the Astro build run third-party code), hands `dist/`
  over as an artifact, and the `promote` job (in the `production` environment)
  uploads it with the Static Web App's deployment token, fetched at runtime with
  the prod OIDC identity and never stored in GitHub (`docs/ci-security.md`). The `novedu-publish` skill
  notes this.
