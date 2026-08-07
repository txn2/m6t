import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Control } from "./Control";

afterEach(cleanup);

const button = () => screen.getByRole("button");

describe("a control that acts", () => {
  it("shows its icon and its label", () => {
    render(<Control icon="plus" label="File" onClick={vi.fn()} />);

    expect(button().textContent).toBe("File");
    expect(button().querySelector("[data-icon=plus]")).not.toBeNull();
  });

  // The distinction the component exists for. A permanent aria-pressed="false"
  // announces a toggle that happens to be off, which is a different control
  // from a button that does something once.
  it("reports no pressed state at all", () => {
    render(<Control icon="plus" label="File" onClick={vi.fn()} />);

    expect(button().hasAttribute("aria-pressed")).toBe(false);
    expect(button().className).not.toContain("control--on");
  });

  it("takes its accessible name from the text on screen", () => {
    render(<Control icon="plus" label="File" onClick={vi.fn()} />);

    // No aria-label to drift from the label beside it.
    expect(button().hasAttribute("aria-label")).toBe(false);
    expect(screen.getByRole("button", { name: "File" })).toBeDefined();
  });

  it("calls back when pressed", () => {
    const onClick = vi.fn();
    render(<Control icon="plus" label="File" onClick={onClick} />);

    fireEvent.click(button());

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("a control that toggles", () => {
  it("reports off without looking pressed", () => {
    render(<Control icon="blame" label="Blame" pressed={false} onClick={vi.fn()} />);

    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().className).not.toContain("control--on");
  });

  it("reports on and looks it", () => {
    render(<Control icon="blame" label="Blame" pressed onClick={vi.fn()} />);

    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().className).toContain("control--on");
  });

  // What the tree's dotfile toggle used to do, and must not: a control whose
  // name changes with its state leaves a user unable to tell whether the words
  // describe where they are or where the click leads (#54).
  it("keeps one name in both states", () => {
    const { rerender } = render(
      <Control icon="hidden" label="Show hidden" pressed={false} onClick={vi.fn()} />,
    );
    const off = button().getAttribute("aria-label") ?? button().textContent;

    rerender(<Control icon="hidden" label="Show hidden" pressed onClick={vi.fn()} />);

    expect(button().getAttribute("aria-label") ?? button().textContent).toBe(off);
  });
});

describe("a compact control", () => {
  it("drops the visible label and keeps the name", () => {
    render(<Control icon="hidden" label="Show hidden" compact pressed={false} onClick={vi.fn()} />);

    expect(button().textContent).toBe("");
    expect(screen.getByRole("button", { name: "Show hidden" })).toBeDefined();
  });

  it("is the same control to a screen reader as the labelled one", () => {
    render(<Control icon="hidden" label="Show hidden" compact onClick={vi.fn()} />);
    const compact = button().getAttribute("aria-label");

    cleanup();
    render(<Control icon="hidden" label="Show hidden" onClick={vi.fn()} />);

    expect(compact).toBe(button().textContent);
  });
});

describe("a control whose label abbreviates its name", () => {
  it("is addressed by the fuller name", () => {
    render(<Control icon="plus" label="File" name="New file" onClick={vi.fn()} />);

    expect(screen.getByRole("button", { name: "New file" })).toBeDefined();
  });

  // WCAG 2.5.3: a user who says what they can read has to reach the control.
  // "File" is inside "New file"; a name that dropped it would not be.
  it("keeps the visible label inside the spoken name", () => {
    render(<Control icon="plus" label="Folder" name="New folder" onClick={vi.fn()} />);

    const spoken = button().getAttribute("aria-label") ?? "";
    expect(spoken.toLowerCase()).toContain("folder");
  });
});
