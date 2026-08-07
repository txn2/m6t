/**
 * Split geometry for the workbench's resizable panes (DESIGN.md §5).
 *
 * Everything here is pure arithmetic — the component (`PaneSeparator`) owns
 * the pointer and key events, this owns what a movement means — the same
 * split `lib/tree.ts` and `useFileTree` already use. It is what makes the
 * clamping testable without a layout engine, which matters because jsdom
 * reports every element as zero-sized and a test against a real
 * `getBoundingClientRect` would be a test of nothing.
 */

/** Which way a separator runs. This is the separator's own orientation, which
 * is what `aria-orientation` describes: the divider between a left and a
 * right pane is a vertical line. */
export type Orientation = "vertical" | "horizontal";

/**
 * How a pointer movement maps onto the pane being sized.
 *
 * `1` when the separator's pane is the leading one — the sidebar, where
 * dragging right makes it wider. `-1` when it is the trailing one — the
 * terminal, where dragging down makes it *shorter*, because what grows is the
 * editor above it.
 */
export type Direction = 1 | -1;

/** The bounds a split is held inside. */
export interface Bounds {
  /** Smallest the sized pane may be. */
  readonly min: number;
  /** Smallest the pane on the other side of the separator may be. */
  readonly minOther: number;
  /** The axis's full extent, or 0 when it is not known — see clampSplit. */
  readonly total: number;
}

/**
 * Holds a requested size inside its bounds.
 *
 * A `total` of 0 means "not measured": jsdom has no layout, and a real window
 * reports 0 for a moment before first paint. The upper bound is dropped in
 * that case rather than guessed at, because clamping against a zero-width
 * container would collapse every pane to its minimum — a real, visible bug
 * that would only appear in the first frame and in every test.
 */
export function clampSplit(size: number, bounds: Bounds): number {
  const wanted = Math.round(size);
  if (!Number.isFinite(wanted)) {
    return bounds.min;
  }
  if (bounds.total <= 0) {
    return Math.max(bounds.min, wanted);
  }
  const max = bounds.total - bounds.minOther;
  if (max <= bounds.min) {
    // The window is too small to honour both minimums. The sized pane keeps
    // its floor and the other one is what gives, because the alternative is
    // a pane that silently becomes unusable as the window shrinks.
    return bounds.min;
  }
  return Math.min(max, Math.max(bounds.min, wanted));
}

/** How far one keypress moves a separator, and how far with Shift held. */
export const NUDGE = 8;
export const NUDGE_COARSE = 40;

/**
 * The movement a key means for a separator, or null for a key it does not
 * handle — which the caller must leave alone rather than swallow.
 *
 * Positive is toward the end of the axis (right, or down) regardless of which
 * pane is being sized; `Direction` is what turns that into a size change. That
 * split is deliberate: the arrow key means "move this divider that way" to the
 * user, and it should mean the same thing on both separators even though one
 * of them is sizing the pane on the far side.
 */
export function nudgeFor(
  key: string,
  orientation: Orientation,
  coarse: boolean,
): number | null {
  const step = coarse ? NUDGE_COARSE : NUDGE;
  const [back, forward] =
    orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  if (key === back) {
    return -step;
  }
  if (key === forward) {
    return step;
  }
  return null;
}

/** Applies a movement along the axis to the pane a separator sizes. */
export function resize(
  size: number,
  movement: number,
  direction: Direction,
  bounds: Bounds,
): number {
  return clampSplit(size + movement * direction, bounds);
}

/**
 * The workbench's default and minimum pane sizes, in pixels.
 *
 * The minimums are the point below which a pane stops doing its job rather
 * than round numbers: a file tree narrower than this cannot show a nested
 * path, and a terminal shorter than this cannot hold a shell prompt plus the
 * output of what it just ran.
 */
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 180;
export const EDITOR_MIN_WIDTH = 320;

export const TERMINAL_DEFAULT = 260;
export const TERMINAL_MIN = 120;
export const EDITOR_MIN_HEIGHT = 160;

/**
 * The cluster panel's width (#10). Its minimum is the point below which the
 * context name — the one thing on screen that must never be ambiguous
 * (DESIGN.md §5) — starts wrapping mid-name, which is worse than no panel.
 */
export const CLUSTER_DEFAULT = 280;
export const CLUSTER_MIN = 220;
