import { describe, expect, it } from "vitest";
import {
  fitCamera,
  focusCamera,
  INITIAL_SHEET,
  type SheetEvent,
  type SheetModel,
  sheetReducer,
} from "./sheet";

const run = (...events: SheetEvent["type"][]): SheetModel =>
  events.reduce((m, type) => sheetReducer(m, { type } as SheetEvent), INITIAL_SHEET);

describe("the phone sheet", () => {
  it("stays hidden until the first board and then opens half", () => {
    expect(run().state).toBe("hidden");
    expect(run("open", "collapse", "full", "inputFocus").state).toBe("hidden");
    expect(run("changed").state).toBe("half");
  });

  it("keeps the student's collapse across later changes, with the unseen dot", () => {
    const m = run("changed", "collapse", "changed");
    expect(m).toMatchObject({ state: "peek", studentCollapsed: true, unseen: true });
    expect(sheetReducer(m, { type: "open" })).toMatchObject({
      state: "half",
      studentCollapsed: false,
      unseen: false,
    });
  });

  it("tucks to peek while the message field has focus and comes back after", () => {
    const tucked = run("changed", "inputFocus");
    expect(tucked).toMatchObject({ state: "peek", tucked: true, studentCollapsed: false });
    expect(sheetReducer(tucked, { type: "inputBlur" })).toMatchObject({
      state: "half",
      tucked: false,
    });
  });

  it("a change while tucked waits for the keyboard, then shows without the dot", () => {
    const m = run("changed", "inputFocus", "changed");
    expect(m).toMatchObject({ state: "peek", unseen: true });
    expect(sheetReducer(m, { type: "inputBlur" })).toMatchObject({ state: "half", unseen: false });
  });

  it("a message-field focus before any board does not affect the first board", () => {
    // The tuck only applies to half; a focus before any board is a no-op.
    expect(run("inputFocus", "changed").state).toBe("half");
  });

  it("the keyboard does not undo the student's collapse", () => {
    const m = run("changed", "collapse", "inputFocus", "inputBlur");
    expect(m.state).toBe("peek");
  });

  it("opens full from half or peek and closes back to half", () => {
    expect(run("changed", "full").state).toBe("full");
    expect(run("changed", "collapse", "full", "closeFull").state).toBe("half");
    expect(run("changed", "full", "inputFocus").state).toBe("full");
  });

  it("Start over clears everything", () => {
    expect(run("changed", "collapse", "changed", "cleared")).toEqual(INITIAL_SHEET);
  });
});

describe("the camera", () => {
  const view = { w: 360, h: 300 };
  const image = { w: 1200, h: 600 };

  it("fits the whole board, centred, never above the cap", () => {
    expect(fitCamera(view, image)).toEqual({ x: 0, y: 60, scale: 0.3 });
    expect(fitCamera({ w: 2000, h: 2000 }, { w: 100, h: 100 })).toEqual({
      x: 950,
      y: 950,
      scale: 1,
    });
    expect(fitCamera(view, { w: 0, h: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("frames a small highlighted part at the readable cap (1.1)", () => {
    const cam = focusCamera(view, image, { x: 500, y: 250, w: 100, h: 50 });
    expect(cam.scale).toBe(1.1);
    // the part's centre (550, 275) lands in the middle of the view
    expect(550 * cam.scale + cam.x).toBeCloseTo(180);
    expect(275 * cam.scale + cam.y).toBeCloseTo(150);
  });

  it("zooms out to fit a wide highlight, but never below the whole-board fit", () => {
    const wide = focusCamera(view, image, { x: 0, y: 0, w: 1200, h: 100 });
    expect(wide.scale).toBeCloseTo(0.3);
    const medium = focusCamera(view, image, { x: 100, y: 100, w: 624, h: 100 });
    expect(medium.scale).toBeCloseTo((360 - 48) / 624);
  });

  it("keeps the image inside the view at the edges", () => {
    const cam = focusCamera(view, image, { x: 0, y: 0, w: 60, h: 40 });
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
    const end = focusCamera(view, image, { x: 1150, y: 560, w: 50, h: 40 });
    expect(image.w * end.scale + end.x).toBeCloseTo(view.w);
    expect(image.h * end.scale + end.y).toBeCloseTo(view.h);
  });
});
