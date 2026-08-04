import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTab } from "../lib/tabs";
import { TerminalTabs } from "./TerminalTabs";

afterEach(cleanup);

const tabs = [
  newTab("k0", "shell 1", "/w"),
  newTab("k1", "claude 1", "/w", "claude"),
];

function renderStrip(overrides: Partial<Parameters<typeof TerminalTabs>[0]>) {
  const props = {
    tabs,
    activeKey: "k0",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onCreate: vi.fn(),
    onCreateClaude: vi.fn(),
    ...overrides,
  };
  render(<TerminalTabs {...props} />);
  return props;
}

describe("the terminal tab strip", () => {
  it("marks the active tab for assistive technology, not just in colour", () => {
    renderStrip({});

    expect(screen.getByRole("tab", { name: /shell 1/ })).toHaveProperty(
      "ariaSelected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /claude 1/ })).toHaveProperty(
      "ariaSelected",
      "false",
    );
  });

  it("selects a tab when it is clicked", () => {
    const props = renderStrip({});

    fireEvent.click(screen.getByRole("tab", { name: /claude 1/ }));

    expect(props.onSelect).toHaveBeenCalledWith("k1");
  });

  // Closing is the only thing in this strip that ends a PTY, so it must not be
  // reachable by clicking the tab itself.
  it("closes only from the close control", () => {
    const props = renderStrip({});

    fireEvent.click(screen.getByRole("button", { name: "close shell 1" }));

    expect(props.onClose).toHaveBeenCalledWith("k0");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("opens a shell and a Claude Code tab from separate actions", () => {
    const props = renderStrip({});

    fireEvent.click(screen.getByRole("button", { name: "+ shell" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Claude Code" }));

    expect(props.onCreate).toHaveBeenCalledTimes(1);
    expect(props.onCreateClaude).toHaveBeenCalledTimes(1);
  });
});

describe("renaming a tab", () => {
  const startEditing = () => {
    fireEvent.doubleClick(screen.getByRole("tab", { name: /shell 1/ }));
    return screen.getByRole("textbox", { name: "rename shell 1" });
  };

  it("commits the new name on Enter", () => {
    const props = renderStrip({});
    const field = startEditing();

    fireEvent.change(field, { target: { value: "build" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(props.onRename).toHaveBeenCalledWith("k0", "build");
  });

  // Escape restores the old name rather than leaving the field open: the tab
  // strip is not a form, and there is no cancel button to look for.
  it("keeps the old name on Escape", () => {
    const props = renderStrip({});
    const field = startEditing();

    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(props.onRename).toHaveBeenCalledWith("k0", "shell 1");
  });

  it("commits what was typed when focus moves away", () => {
    const props = renderStrip({});
    const field = startEditing();

    fireEvent.change(field, { target: { value: "logs" } });
    fireEvent.blur(field);

    expect(props.onRename).toHaveBeenCalledWith("k0", "logs");
  });
});
