// The board's renderer: board state → Excalidraw elements → a PNG (never SVG,
// docs/tutor-board.md "Rendering"). Excalidraw is loaded with a dynamic import
// on the first board, so a tutor that never draws never loads it. Its fonts
// come from Excalidraw's default CDN; text must only be measured once they are
// loaded, or labels overflow their boxes — hence the one-time warm-up export.
//
// The export's origin is `getCommonBounds(elements) − padding` (Excalidraw's
// `exportToCanvas`), so part bounds land on the image's pixels; pinned by
// tests/component/tutor-board.browser.test.tsx.

import { type BoardState, finish, layout, markedIds } from "@/lib/board";
import type { Rect } from "./sheet";

/** Empty space around the drawing in the image, in drawing pixels. */
export const EXPORT_PADDING = 24;
/** The largest canvas we ask for (iOS Safari refuses canvases above ~16.7 M pixels). */
const MAX_CANVAS_PIXELS = 16_000_000;

type Excalidraw = typeof import("@excalidraw/excalidraw");
/** An Excalidraw element (its export typings resolve loosely, so name it via a typed function). */
type ExcalidrawElement = Parameters<Excalidraw["getCommonBounds"]>[0][number];

let excalidraw: Promise<Excalidraw> | null = null;

/** Loads Excalidraw and its fonts once per page. */
function loadExcalidraw(): Promise<Excalidraw> {
  excalidraw ??= (async () => {
    const lib = await import("@excalidraw/excalidraw");
    // Warm-up: the first export loads Excalifont; text converted before that is
    // measured with a fallback font and overflows its box.
    const warm = lib.convertToExcalidrawElements(
      [{ type: "text", x: 0, y: 0, text: "Warm-up", fontSize: 20 }],
      { regenerateIds: false },
    );
    await lib.exportToCanvas({ elements: warm, files: null });
    await document.fonts.ready;
    return lib;
  })().catch((error: unknown) => {
    excalidraw = null; // a later board tries again
    throw error;
  });
  return excalidraw;
}

export interface RenderedBoard {
  blob: Blob;
  /** The image's size in drawing pixels (CSS pixels at zoom 1). */
  width: number;
  height: number;
  /** The highlighted parts' bounds in drawing pixels, or null without a highlight. */
  focus: Rect | null;
}

/** The bounds of each part, by id (boxes, arrows with their label, group frames). */
type Bounds = [number, number, number, number];

/** Renders the board as a PNG at `scale` (device pixels per drawing pixel). */
export async function renderBoard(state: BoardState, scale: number): Promise<RenderedBoard> {
  const lib = await loadExcalidraw();
  const converted = lib.convertToExcalidrawElements(
    layout(state) as unknown as Parameters<Excalidraw["convertToExcalidrawElements"]>[0],
    { regenerateIds: false },
  );
  // `finish` writes label positions and arrow points into the fresh elements.
  const elements = finish(
    converted as unknown as Parameters<typeof finish>[0],
  ) as unknown as ExcalidrawElement[];
  const [minX, minY, maxX, maxY] = lib.getCommonBounds(elements);
  const width = maxX - minX + 2 * EXPORT_PADDING;
  const height = maxY - minY + 2 * EXPORT_PADDING;
  const pixelScale = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const canvas: HTMLCanvasElement = await lib.exportToCanvas({
    elements,
    files: null,
    exportPadding: EXPORT_PADDING,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
    getDimensions: (w: number, h: number) => ({
      width: Math.round(w * pixelScale),
      height: Math.round(h * pixelScale),
      scale: pixelScale,
    }),
  });
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b: Blob | null) => (b ? resolve(b) : reject(new Error("board export failed"))),
      "image/png",
    ),
  );

  const byId = new Map(elements.map((e): [string, ExcalidrawElement] => [e.id, e]));
  const bounds = (id: string): Bounds | null => {
    const e = byId.get(id);
    if (!e) return null;
    const [x1, y1, x2, y2] = lib.getCommonBounds([e]);
    return [x1, y1, x2, y2];
  };
  let focus: Bounds | null = null;
  for (const id of markedIds(state)) {
    for (const part of [bounds(id), bounds(`${id}:label`)]) {
      if (!part) continue;
      focus = focus
        ? [
            Math.min(focus[0], part[0]),
            Math.min(focus[1], part[1]),
            Math.max(focus[2], part[2]),
            Math.max(focus[3], part[3]),
          ]
        : part;
    }
  }
  const ox = EXPORT_PADDING - minX;
  const oy = EXPORT_PADDING - minY;
  return {
    blob,
    width,
    height,
    focus: focus
      ? { x: focus[0] + ox, y: focus[1] + oy, w: focus[2] - focus[0], h: focus[3] - focus[1] }
      : null,
  };
}
