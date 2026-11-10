// The board pane's pure rules (docs/tutor-board.md): the phone sheet's states
// and the camera that frames the highlight. Kept free of React and the DOM so
// they are unit-tested exhaustively (sheet.unit.test.ts).

/** The phone sheet: hidden (no board), peek (60px bar), half (~46% height), full (covers the app). */
export type SheetState = "hidden" | "peek" | "half" | "full";

export interface SheetModel {
  state: SheetState;
  /** The student collapsed it to peek themself: later changes do not reopen it. */
  studentCollapsed: boolean;
  /** Tucked to peek while the message field has focus (not the student's choice). */
  tucked: boolean;
  /** The board changed while the student could not see it (peek, or the laptop rail). */
  unseen: boolean;
}

export const INITIAL_SHEET: SheetModel = {
  state: "hidden",
  studentCollapsed: false,
  tucked: false,
  unseen: false,
};

export type SheetEvent =
  /** A successful board call arrived (or the restored board appeared). */
  | { type: "changed" }
  /** The board is gone (Start over). */
  | { type: "cleared" }
  /** The student collapsed the sheet (grabber, or the hide button). */
  | { type: "collapse" }
  /** The student opened it (show button, the chat pill). */
  | { type: "open" }
  /** The student tapped the drawing or ⤢. */
  | { type: "full" }
  /** The close button of the full view. */
  | { type: "closeFull" }
  /** The message field gained focus (the keyboard takes half the screen). */
  | { type: "inputFocus" }
  /** The message field lost focus, or the message was sent. */
  | { type: "inputBlur" };

/** The next sheet model. */
export function sheetReducer(m: SheetModel, e: SheetEvent): SheetModel {
  switch (e.type) {
    case "changed":
      if (m.state === "hidden") return { ...m, state: "half", unseen: false };
      if (m.state === "peek") {
        // The student's choice wins; a tuck is only the keyboard, so it stays tucked too.
        if (m.studentCollapsed || m.tucked) return { ...m, unseen: true };
        return { ...m, state: "half", unseen: false };
      }
      return m;
    case "cleared":
      return INITIAL_SHEET;
    case "collapse":
      if (m.state === "hidden") return m;
      return { ...m, state: "peek", studentCollapsed: true, tucked: false };
    case "open":
      if (m.state === "hidden") return m;
      return { ...m, state: "half", studentCollapsed: false, tucked: false, unseen: false };
    case "full":
      if (m.state === "hidden") return m;
      return { ...m, state: "full", unseen: false };
    case "closeFull":
      return m.state === "full" ? { ...m, state: "half" } : m;
    case "inputFocus":
      return m.state === "half" ? { ...m, state: "peek", tucked: true } : m;
    case "inputBlur":
      if (!m.tucked) return m;
      return { ...m, state: m.studentCollapsed ? "peek" : "half", tucked: false, unseen: false };
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Where the image sits in its viewport: `transform: translate(x, y) scale(scale)` from the top left. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** The whole image fit into the viewport and centred, never above `maxScale`. */
export function fitCamera(view: Size, image: Size, maxScale = 1): Camera {
  if (image.w <= 0 || image.h <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(maxScale, view.w / image.w, view.h / image.h);
  return { x: (view.w - image.w * scale) / 2, y: (view.h - image.h * scale) / 2, scale };
}

/**
 * Frames `focus` (in image pixels) at a readable scale: as large as fits with a
 * margin, at most `maxScale`, never smaller than the whole-board fit. The image
 * is kept inside the viewport where it is larger than it; a smaller axis is
 * centred.
 */
export function focusCamera(
  view: Size,
  image: Size,
  focus: Rect,
  { maxScale = 1.1, margin = 24 }: { maxScale?: number; margin?: number } = {},
): Camera {
  const fit = fitCamera(view, image, Number.POSITIVE_INFINITY).scale;
  const want = Math.min(
    maxScale,
    (view.w - 2 * margin) / Math.max(1, focus.w),
    (view.h - 2 * margin) / Math.max(1, focus.h),
  );
  const scale = Math.max(Math.min(fit, maxScale), want);
  const axis = (viewLen: number, imageLen: number, start: number, len: number) => {
    const scaled = imageLen * scale;
    if (scaled <= viewLen) return (viewLen - scaled) / 2;
    const centred = viewLen / 2 - (start + len / 2) * scale;
    return Math.min(0, Math.max(viewLen - scaled, centred));
  };
  return {
    x: axis(view.w, image.w, focus.x, focus.w),
    y: axis(view.h, image.h, focus.y, focus.h),
    scale,
  };
}
