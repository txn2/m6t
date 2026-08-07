import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneSeparator } from "./PaneSeparator";

afterEach(cleanup);

/**
 * Dispatches a pointer event React will actually read.
 *
 * This jsdom has no `PointerEvent`, so `fireEvent.pointerDown(el, {clientX})`
 * falls back to a generic `Event` and silently drops `clientX`, `clientY` and
 * `button`. The handler still fires, so a drag test written that way *passes*
 * while asserting on a drag that never happened — the component sees
 * `button === undefined`, refuses to start, and every "must not resize" case
 * goes green for the wrong reason. A real `MouseEvent` under the pointer
 * event's name carries the coordinates through React's native listener.
 */
function pointer(target: Element, type: string, init: MouseEventInit = {}): void {
  fireEvent(target, new MouseEvent(type, { bubbles: true, ...init }));
}

const bounds = { min: 180, minOther: 320, total: 1000 };

function renderSidebar(onResize = vi.fn(), size = 300) {
  render(
    <PaneSeparator
      orientation="vertical"
      area="sidebar"
      size={size}
      direction={1}
      bounds={bounds}
      label="Sidebar width"
      onResize={onResize}
    />,
  );
  return { onResize, separator: screen.getByRole("separator") };
}

describe("the separator as a control", () => {
  it("exposes its orientation, value and range", () => {
    const { separator } = renderSidebar();

    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuenow")).toBe("300");
    expect(separator.getAttribute("aria-valuemin")).toBe("180");
    expect(separator.getAttribute("aria-valuemax")).toBe("680");
  });

  // A split reachable only with a pointer is unreachable for a keyboard user.
  it("is focusable", () => {
    const { separator } = renderSidebar();

    expect(separator.getAttribute("tabindex")).toBe("0");
  });

  // total is 0 before first paint and in every jsdom test; advertising a
  // computed maximum from it would be advertising a wrong number.
  it("omits the maximum while the axis is unmeasured", () => {
    render(
      <PaneSeparator
        orientation="vertical"
      area="sidebar"
        size={300}
        direction={1}
        bounds={{ ...bounds, total: 0 }}
        label="Sidebar width"
        onResize={vi.fn()}
      />,
    );

    expect(screen.getByRole("separator").getAttribute("aria-valuemax")).toBeNull();
  });
});

describe("dragging", () => {
  it("resizes by the distance the pointer moved", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 0, clientX: 300, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 360, clientY: 0 });

    expect(onResize).toHaveBeenCalledWith(360);
  });

  // Deltas are measured from where the drag began, not accumulated per event.
  // Accumulating would drift once a clamp swallowed part of a movement.
  it("measures every move against the start of the drag", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 0, clientX: 300, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 100, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 340, clientY: 0 });

    // Pushed past the minimum and back: the second move lands where the
    // pointer actually is, not at min + 240.
    expect(onResize).toHaveBeenLastCalledWith(340);
  });

  it("does nothing until a drag has started", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointermove", { clientX: 900, clientY: 0 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it("stops resizing after the pointer is released", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 0, clientX: 300, clientY: 0 });
    pointer(separator, "pointerup", { clientX: 300, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 900, clientY: 0 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it("abandons the drag when the pointer is cancelled", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 0, clientX: 300, clientY: 0 });
    pointer(separator, "pointercancel");
    pointer(separator, "pointermove", { clientX: 900, clientY: 0 });

    expect(onResize).not.toHaveBeenCalled();
  });

  // A right-click must not start a drag.
  it("ignores a non-primary button", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 2, clientX: 300, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 400, clientY: 0 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it("clamps a drag that would starve the other pane", () => {
    const { onResize, separator } = renderSidebar();

    pointer(separator, "pointerdown", { button: 0, clientX: 300, clientY: 0 });
    pointer(separator, "pointermove", { clientX: 5000, clientY: 0 });

    expect(onResize).toHaveBeenLastCalledWith(680);
  });

  it("uses the vertical axis for a horizontal separator", () => {
    const onResize = vi.fn();
    render(
      <PaneSeparator
        orientation="horizontal"
      area="terminal"
        size={300}
        direction={1}
        bounds={bounds}
        label="Terminal height"
        onResize={onResize}
      />,
    );
    const separator = screen.getByRole("separator");

    pointer(separator, "pointerdown", { button: 0, clientX: 0, clientY: 300 });
    pointer(separator, "pointermove", { clientX: 9999, clientY: 350 });

    // clientX moved a long way and must be ignored entirely.
    expect(onResize).toHaveBeenCalledWith(350);
  });

  // The terminal trails its separator: dragging down grows the editor above.
  it("shrinks a trailing pane when dragged forward", () => {
    const onResize = vi.fn();
    render(
      <PaneSeparator
        orientation="horizontal"
      area="terminal"
        size={300}
        direction={-1}
        bounds={bounds}
        label="Terminal height"
        onResize={onResize}
      />,
    );
    const separator = screen.getByRole("separator");

    pointer(separator, "pointerdown", { button: 0, clientX: 0, clientY: 300 });
    pointer(separator, "pointermove", { clientX: 0, clientY: 340 });

    expect(onResize).toHaveBeenCalledWith(260);
  });
});

describe("the keyboard", () => {
  it("moves on the arrow keys along its axis", () => {
    const { onResize, separator } = renderSidebar();

    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(onResize).toHaveBeenCalledWith(308);
  });

  it("takes a coarser step with shift held", () => {
    const { onResize, separator } = renderSidebar();

    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });

    expect(onResize).toHaveBeenCalledWith(340);
  });

  it("clamps at the minimum", () => {
    const { onResize, separator } = renderSidebar(vi.fn(), 184);

    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });

    expect(onResize).toHaveBeenCalledWith(180);
  });

  // Off-axis arrows belong to whatever else is listening; swallowing them
  // would break scrolling past the separator.
  it("leaves keys it does not handle alone", () => {
    const { onResize, separator } = renderSidebar();

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    fireEvent.keyDown(separator, { key: "Enter" });

    expect(onResize).not.toHaveBeenCalled();
  });
});
