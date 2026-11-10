// Plain-text descriptions of a board for people: the pane's one-line status
// ("Added 2 parts, highlighted 3 parts"), the image's alt text and the live
// region's announcement. Pure; model text only ever ends up in plain strings.

import type { BoardState } from "./model";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Every drawn part's id (boards, groups, boxes, arrows). */
function partIds(s: BoardState): Set<string> {
  return new Set([...s.boards.keys(), ...s.groups.keys(), ...s.boxes.keys(), ...s.arrows.keys()]);
}

/**
 * What the latest change did, as a short sentence: "Drawn just now" for the
 * first drawing, otherwise e.g. "Added 2 parts, highlighted 3 parts".
 */
export function changeStatus(prev: BoardState | null, next: BoardState): string {
  const before = prev ? partIds(prev) : new Set<string>();
  if (before.size === 0) return "Drawn just now";
  const after = partIds(next);
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  const changed = next.fresh.filter((id) => before.has(id)).length;
  const highlighted = next.highlight.length;
  const bits = [
    added ? `added ${plural(added, "part")}` : "",
    changed ? `changed ${plural(changed, "part")}` : "",
    removed ? `removed ${plural(removed, "part")}` : "",
    highlighted ? `highlighted ${plural(highlighted, "part")}` : "",
  ].filter(Boolean);
  if (!bits.length) return "Updated just now";
  const text = bits.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The image's text alternative: titles, boxes and arrows in drawing order. */
export function describeBoard(s: BoardState): string {
  const sentences: string[] = [];
  for (const b of s.boards.values()) {
    const boxes = [...s.boxes.values()].filter((x) => x.board === b.id).map((x) => x.text);
    const arrows = [...s.arrows.values()]
      .filter((a) => (s.boxes.get(a.from) ?? s.groups.get(a.from))?.board === b.id)
      .map((a) => {
        const from = s.boxes.get(a.from)?.text ?? s.groups.get(a.from)?.text ?? a.from;
        const to = s.boxes.get(a.to)?.text ?? s.groups.get(a.to)?.text ?? a.to;
        return `${from} → ${to}${a.text ? ` (${a.text})` : ""}`;
      });
    sentences.push(`Drawing "${b.title}".`);
    if (boxes.length) sentences.push(`Parts: ${boxes.join(", ")}.`);
    if (arrows.length) sentences.push(`Arrows: ${arrows.join("; ")}.`);
  }
  const lit = s.highlight
    .map((id) => s.boxes.get(id)?.text ?? s.groups.get(id)?.text ?? s.arrows.get(id)?.text)
    .filter((t): t is string => Boolean(t));
  if (lit.length) sentences.push(`Highlighted: ${lit.join(", ")}.`);
  return sentences.join(" ");
}
