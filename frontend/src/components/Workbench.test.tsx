import { describe, expect, it } from "vitest";
import {
  EDITOR_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  CLUSTER_MIN,
  SIDEBAR_MIN,
  TERMINAL_MIN,
} from "../lib/panes";
import { fit } from "./Workbench";

/**
 * Fitting the splits to the window.
 *
 * The separators clamp what a drag produces, which is enough for every size the
 * user made themselves. A restored session is the case that has no drag behind
 * it (#58): the sizes were recorded on whatever display the workspace was last
 * open on, and the window they are being drawn in now may be smaller.
 */
describe("fitting the panes to the window", () => {
  const panes = { sidebar: 300, terminalHeight: 240, cluster: 300 };

  it("leaves sizes the window can hold alone", () => {
    expect(fit(panes, { width: 1600, height: 1000 })).toEqual(panes);
  });

  // The unmeasured case: the first frame, and every jsdom test. Guessing at an
  // upper bound there would collapse both panes to their minimums on load.
  it("keeps only the minimums while the window has not been measured", () => {
    expect(
      fit({ sidebar: 40, terminalHeight: 10, cluster: 20 }, { width: 0, height: 0 }),
    ).toEqual({
      sidebar: SIDEBAR_MIN,
      terminalHeight: TERMINAL_MIN,
      cluster: CLUSTER_MIN,
    });
    expect(fit(panes, { width: 0, height: 0 })).toEqual(panes);
  });

  // A session saved on a docked display, reopened on the laptop alone.
  it("shrinks a split that no longer leaves room for what is beside it", () => {
    const fitted = fit(
      { sidebar: 1200, terminalHeight: 900, cluster: 1200 },
      { width: 900, height: 700 },
    );

    expect(fitted.sidebar).toBe(900 - EDITOR_MIN_WIDTH);
    expect(fitted.terminalHeight).toBe(700 - EDITOR_MIN_HEIGHT);
  });

  // Both minimums cannot be honoured in a window this small. The sized pane
  // keeps its floor and the other one gives, which is `clampSplit`'s rule and
  // is asserted here because a restore is where the tiny window shows up.
  it("holds the floor when the window cannot honour both minimums", () => {
    const fitted = fit(
      { sidebar: 1200, terminalHeight: 900, cluster: 1200 },
      { width: 300, height: 200 },
    );

    expect(fitted.sidebar).toBe(SIDEBAR_MIN);
    expect(fitted.terminalHeight).toBe(TERMINAL_MIN);
  });
});
