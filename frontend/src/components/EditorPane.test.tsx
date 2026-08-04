import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MountedEditor } from "../lib/codemirror";
import type { EditorTab, EditorTabKind } from "../lib/editorTabs";
import { newTab, withExternalChange, withLoaded } from "../lib/editorTabs";
import type { FileContent } from "../lib/files";
import { EditorPane } from "./EditorPane";

afterEach(cleanup);

const file = (content: string, over: Partial<FileContent> = {}): FileContent =>
  ({ content, crlf: false, mixedEol: false, readOnly: false, size: content.length, ...over }) as FileContent;

const ready = (
  content = "a: 1\n",
  kind: EditorTabKind = "yaml",
  over: Partial<FileContent> = {},
): EditorTab =>
  withLoaded(newTab("k0", "infra", "/w/infra", "deploy.yaml", kind), file(content, over));

const markdown = (content = "# Title\n"): EditorTab =>
  withLoaded(newTab("k0", "infra", "/w/infra", "README.md", "markdown"), file(content));

function fakeEditor(): MountedEditor {
  return {
    setContent: vi.fn(),
    setTheme: vi.fn(),
    setReadOnly: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
}

function renderPane(tab: EditorTab, over: Partial<Parameters<typeof EditorPane>[0]> = {}) {
  const editor = fakeEditor();
  const mount = vi.fn().mockReturnValue(editor);
  const props = {
    tab,
    active: true,
    appearance: "dark" as const,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onKeepMine: vi.fn(),
    onTakeDisk: vi.fn(),
    mount,
    ...over,
  };
  const { rerender } = render(<EditorPane {...props} />);
  return {
    props,
    editor,
    mount,
    rerender: (next: Partial<Parameters<typeof EditorPane>[0]>) => {
      rerender(<EditorPane {...props} {...next} />);
    },
  };
}

describe("mounting an editor", () => {
  it("builds one with the tab's content, kind and theme", () => {
    const { mount } = renderPane(ready("kind: Service\n"));

    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][1]).toMatchObject({
      content: "kind: Service\n",
      kind: "yaml",
      appearance: "dark",
      readOnly: false,
    });
  });

  it("reports an edit against the tab it belongs to", () => {
    const { props, mount } = renderPane(ready());

    mount.mock.calls[0][1].onChange("a: 2\n");

    expect(props.onChange).toHaveBeenCalledWith("k0", "a: 2\n");
  });

  it("reports the save chord against the tab it belongs to", () => {
    const { props, mount } = renderPane(ready());

    mount.mock.calls[0][1].onSave();

    expect(props.onSave).toHaveBeenCalledWith("k0");
  });

  // Rebuilding the view on every keystroke would discard undo history and
  // move the cursor; the content is pushed into the existing one instead.
  it("does not rebuild the view when the content changes", () => {
    const tab = ready("a: 1\n");
    const { mount, editor, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, content: "a: 2\n" } });

    expect(mount).toHaveBeenCalledTimes(1);
    expect(editor.setContent).toHaveBeenLastCalledWith("a: 2\n");
  });

  it("pushes a theme change into the existing view rather than rebuilding it", () => {
    const { mount, editor, rerender } = renderPane(ready());

    rerender({ appearance: "light" });

    expect(mount).toHaveBeenCalledTimes(1);
    expect(editor.setTheme).toHaveBeenCalledWith("light");
  });

  it("pushes a read-only change into the existing view", () => {
    const tab = ready();
    const { editor, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, readOnly: true } });

    expect(editor.setReadOnly).toHaveBeenCalledWith(true);
  });

  // A stale handler would report a later tab's keystrokes against the key the
  // view was mounted with.
  it("reports edits against the current tab key after a re-render", () => {
    const tab = ready();
    const { props, mount, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, content: "a: 2\n" } });
    mount.mock.calls[0][1].onChange("a: 3\n");

    expect(props.onChange).toHaveBeenLastCalledWith("k0", "a: 3\n");
  });

  it("tears the view down when the pane unmounts", () => {
    const { editor } = renderPane(ready());

    cleanup();

    expect(editor.dispose).toHaveBeenCalled();
  });
});

describe("markdown", () => {
  it("opens in rendered preview rather than in CodeMirror", () => {
    const { mount } = renderPane(markdown());

    expect(screen.getByTestId("markdown-preview").querySelector("h1")?.textContent).toBe("Title");
    expect(screen.queryByTestId("codemirror-host")).toBeNull();
    expect(mount).not.toHaveBeenCalled();
  });

  it("mounts CodeMirror once switched to edit mode", () => {
    const tab = markdown();
    const { mount, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, mode: "edit" } });

    expect(mount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("codemirror-host")).toBeDefined();
  });
});

describe("the read-only notice", () => {
  it("explains a file that is too large", () => {
    renderPane(ready("x", "yaml", { readOnly: true, size: 4 * 1024 * 1024 }));

    expect(screen.getByTestId("readonly-notice").textContent).toContain("4.0 MB");
  });

  it("explains mixed line endings in terms of what a save would do", () => {
    renderPane(ready("a\n", "yaml", { readOnly: true, mixedEol: true }));

    expect(screen.getByTestId("readonly-notice").textContent).toContain("rewrite every line");
  });

  it("shows nothing for an editable file", () => {
    renderPane(ready());

    expect(screen.queryByTestId("readonly-notice")).toBeNull();
  });
});

describe("the conflict prompt", () => {
  const conflicted = (): EditorTab =>
    withExternalChange({ ...ready("a: 1\n"), content: "a: 2\n" }, file("a: 99\n"));

  it("offers both resolutions, neither preselected", () => {
    renderPane(conflicted());

    expect(screen.getByRole("alert").textContent).toContain("changed on disk");
    expect(screen.getByRole("button", { name: "Keep my version" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Use the version on disk" })).toBeDefined();
  });

  it("keeps the user's version on request", () => {
    const { props } = renderPane(conflicted());

    fireEvent.click(screen.getByRole("button", { name: "Keep my version" }));

    expect(props.onKeepMine).toHaveBeenCalledWith("k0");
  });

  it("takes the disk version on request", () => {
    const { props } = renderPane(conflicted());

    fireEvent.click(screen.getByRole("button", { name: "Use the version on disk" }));

    expect(props.onTakeDisk).toHaveBeenCalledWith("k0");
  });

  it("shows nothing when there is no conflict", () => {
    renderPane(ready());

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("visibility", () => {
  // Every tab's pane stays mounted, including other projects': unmounting
  // would drop the CodeMirror view and the undo history behind unsaved work.
  it("hides an inactive pane rather than unmounting it", () => {
    const { mount } = renderPane(ready(), { active: false });

    expect(mount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tabpanel", { hidden: true })).toBeDefined();
  });
});
