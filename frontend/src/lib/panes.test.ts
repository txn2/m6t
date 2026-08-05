import { describe, expect, it } from "vitest";
import {
  NUDGE,
  NUDGE_COARSE,
  clampSplit,
  nudgeFor,
  resize,
} from "./panes";

const bounds = { min: 180, minOther: 320, total: 1000 };

describe("clamping a split", () => {
  it("leaves a size inside its bounds alone", () => {
    expect(clampSplit(400, bounds)).toBe(400);
  });

  it("holds the sized pane at its minimum", () => {
    expect(clampSplit(20, bounds)).toBe(180);
  });

  it("stops the sized pane from starving the other one", () => {
    // 1000 total, 320 reserved for the other pane.
    expect(clampSplit(900, bounds)).toBe(680);
  });

  it("rounds to whole pixels", () => {
    expect(clampSplit(400.6, bounds)).toBe(401);
  });

  // jsdom has no layout and a real window reports 0 before first paint.
  // Clamping against that would collapse every pane to its minimum.
  it("drops the upper bound when the axis is not measured", () => {
    expect(clampSplit(900, { ...bounds, total: 0 })).toBe(900);
  });

  it("still applies the lower bound when the axis is not measured", () => {
    expect(clampSplit(10, { ...bounds, total: 0 })).toBe(180);
  });

  // A window too small for both minimums: the sized pane keeps its floor
  // rather than both panes shrinking into uselessness.
  it("keeps the sized pane's floor when the window cannot fit both", () => {
    expect(clampSplit(400, { min: 180, minOther: 320, total: 400 })).toBe(180);
  });

  it("refuses a size that is not a number", () => {
    expect(clampSplit(Number.NaN, bounds)).toBe(180);
  });
});

describe("what a key means for a separator", () => {
  it.each([
    ["ArrowLeft", -NUDGE],
    ["ArrowRight", NUDGE],
  ])("moves a vertical separator on %s", (key, want) => {
    expect(nudgeFor(key, "vertical", false)).toBe(want);
  });

  it.each([
    ["ArrowUp", -NUDGE],
    ["ArrowDown", NUDGE],
  ])("moves a horizontal separator on %s", (key, want) => {
    expect(nudgeFor(key, "horizontal", false)).toBe(want);
  });

  it("takes a coarser step with shift held", () => {
    expect(nudgeFor("ArrowRight", "vertical", true)).toBe(NUDGE_COARSE);
  });

  // The off-axis arrows belong to whatever else is listening — a separator
  // that swallowed them would break scrolling past it.
  it.each([
    ["ArrowUp", "vertical"],
    ["ArrowDown", "vertical"],
    ["ArrowLeft", "horizontal"],
    ["ArrowRight", "horizontal"],
    ["Enter", "vertical"],
    ["a", "vertical"],
  ])("ignores %s on a %s separator", (key, orientation) => {
    expect(nudgeFor(key, orientation as "vertical" | "horizontal", false)).toBeNull();
  });
});

describe("applying a movement", () => {
  // The sidebar is the leading pane: dragging right makes it wider.
  it("grows a leading pane when the separator moves forward", () => {
    expect(resize(300, 40, 1, bounds)).toBe(340);
  });

  // The terminal is the trailing pane: dragging down makes it SHORTER,
  // because what grows is the editor above it.
  it("shrinks a trailing pane when the separator moves forward", () => {
    expect(resize(300, 40, -1, bounds)).toBe(260);
  });

  it("clamps the result rather than the movement", () => {
    expect(resize(200, -100, 1, bounds)).toBe(180);
  });
});
