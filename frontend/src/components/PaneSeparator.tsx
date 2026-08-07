import { useRef } from "react";
import type { Bounds, Direction, Orientation } from "../lib/panes";
import { nudgeFor, resize } from "../lib/panes";

export interface PaneSeparatorProps {
  /** The separator's own orientation: a divider between a left and a right
   * pane is vertical. */
  readonly orientation: Orientation;
  /** Current size, in pixels, of the pane this separator sizes. */
  readonly size: number;
  /** Whether that pane leads (1) or trails (-1) the separator. */
  readonly direction: Direction;
  /** Bounds to hold the size inside. `total` may be 0 when unmeasured. */
  readonly bounds: Bounds;
  /** What the pane is called, for the separator's accessible name. */
  readonly label: string;
  /**
   * Which grid slot this separator occupies, as a modifier class.
   *
   * The orientation used to be enough, because there was one of each. With the
   * cluster panel (#10) there are two vertical separators in the same grid, and
   * placement is what tells them apart — the stylesheet cannot infer from
   * "vertical" whether a divider belongs to the left edge of the editor or the
   * right.
   */
  readonly area: string;
  readonly onResize: (size: number) => void;
}

/**
 * A draggable divider between two panes (DESIGN.md §5).
 *
 * It is a real focusable control rather than a decorated border: a split a
 * user can only reach with a pointer is one a keyboard user cannot reach at
 * all, and `role="separator"` with a tabindex is the ARIA pattern for exactly
 * this. Arrow keys move it; Shift takes a coarser step.
 *
 * Pointer handling uses pointer capture so a fast drag that outruns the
 * cursor keeps sending events to this element instead of to whatever is
 * underneath — without it, dragging quickly across the editor drops the drag
 * the moment the pointer leaves the four-pixel target.
 */
export function PaneSeparator({
  orientation,
  size,
  direction,
  bounds,
  label,
  area,
  onResize,
}: PaneSeparatorProps) {
  // Where the drag started, and the size it started from. Deltas are measured
  // against the start rather than accumulated per event, so a clamped drag
  // does not lose track of the pointer: pushing past the minimum and coming
  // back returns to where the pointer actually is.
  const drag = useRef<{ origin: number; from: number } | null>(null);

  const axisOf = (event: { clientX: number; clientY: number }) =>
    orientation === "vertical" ? event.clientX : event.clientY;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.total > 0 ? bounds.total - bounds.minOther : undefined}
      tabIndex={0}
      className={`separator separator--${orientation} separator--${area}`}
      onPointerDown={(event) => {
        // Only the primary button starts a drag; a right-click here should
        // reach whatever context menu the app grows later.
        if (event.button !== 0) {
          return;
        }
        drag.current = { origin: axisOf(event), from: size };
        // jsdom implements neither of these, and a test must not depend on
        // them existing.
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const started = drag.current;
        if (!started) {
          return;
        }
        event.preventDefault();
        onResize(resize(started.from, axisOf(event) - started.origin, direction, bounds));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const movement = nudgeFor(event.key, orientation, event.shiftKey);
        if (movement === null) {
          return;
        }
        event.preventDefault();
        onResize(resize(size, movement, direction, bounds));
      }}
    />
  );
}
