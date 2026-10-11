/**
 * The guide's sections in reading order, mirroring the manifest in
 * `teacher-docs/CHAPTERS.md` — that file stays the information-architecture
 * authority; this is the site's machine-readable copy of it.
 *
 * Both the Starlight sidebar (`astro.config.mjs`) and the llms.txt table of
 * contents derive from this one list, so a new corpus section is declared in a
 * single place. A chapter whose directory is missing here fails the build rather
 * than silently dropping out of the sidebar or the TOC (see `sectionLabel`).
 */
export interface DocsSection {
  /** Corpus directory, which is also the URL segment: "00-introduction". */
  dir: string;
  /** Human label: the sidebar group and the llms.txt `##` heading. */
  label: string;
}

export const SECTIONS: DocsSection[] = [
  { dir: "00-introduction", label: "Introduction" },
  { dir: "10-yaml-for-teachers", label: "YAML for teachers" },
  { dir: "20-building-activities", label: "Building activities" },
  { dir: "30-sharing-activities", label: "Sharing activities" },
  { dir: "40-ai-llms", label: "Working with AI agents" },
  { dir: "50-develop-and-evaluate", label: "Develop and evaluate" },
];

/** Section directory of a chapter id ("00-introduction/01-what-is-novedu"). */
export function sectionDir(chapterId: string): string {
  return chapterId.split("/")[0] ?? "";
}

/** Label for a section directory. Throws — loudly — on an unlisted section. */
export function sectionLabel(dir: string): string {
  const section = SECTIONS.find((candidate) => candidate.dir === dir);
  if (!section) {
    throw new Error(
      `Corpus section "${dir}" is missing from src/lib/sections.ts — add it there (and to teacher-docs/CHAPTERS.md) so it reaches the sidebar and llms.txt.`,
    );
  }
  return section.label;
}
