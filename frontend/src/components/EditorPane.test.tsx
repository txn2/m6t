import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MountedEditor } from "../lib/codemirror";
import type { EditorTab, EditorTabKind } from "../lib/editorTabs";
import { newTab, withExternalChange, withLoaded } from "../lib/editorTabs";
import type { FileContent } from "../lib/files";
import type { Blame } from "../lib/git";
import { NO_BLAME } from "../lib/useBlame";
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
    showBlame: vi.fn(),
    setBlame: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  };
}

/** A one-line blame, for the pane's own wiring — what it says is
 * `blame.test.ts`'s subject, not this file's. */
const someBlame: Blame = {
  commits: [
    { sha: "a1b2c3d", author: "Craig Johnston", authorTime: 1, summary: "x", uncommitted: false },
  ],
  lines: [0],
};

function renderPane(tab: EditorTab, over: Partial<Parameters<typeof EditorPane>[0]> = {}) {
  const editor = fakeEditor();
  const mount = vi.fn().mockReturnValue(editor);
  const props = {
    tab,
    active: true,
    appearance: "dark" as const,
    blame: NO_BLAME,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onKeepMine: vi.fn(),
    onTakeDisk: vi.fn(),
    mount,
    ...over,
  };
  const { rerender, container } = render(<EditorPane {...props} />);
  return {
    props,
    editor,
    mount,
    container,
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

  it("pushes the blame column into the existing view rather than rebuilding it", () => {
    const tab = ready();
    const { mount, editor, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, blame: true }, blame: { blame: someBlame, error: null } });

    expect(mount).toHaveBeenCalledTimes(1);
    expect(editor.showBlame).toHaveBeenLastCalledWith(true);
    expect(editor.setBlame).toHaveBeenLastCalledWith(someBlame);
  });

  // The regression this pair exists for: the toggle and the install used to be
  // one call, so the guard that stops a blame being installed against unsaved
  // text also swallowed the button — the column could not be turned off while a
  // file had edits in it. Pressing it is the user's decision and is never
  // conditional on anything.
  it("turns the column off while the buffer has unsaved edits", () => {
    const tab = { ...ready(), blame: true };
    const { editor, rerender } = renderPane(tab, {
      blame: { blame: someBlame, error: null },
    });

    const dirty = { ...tab, content: "a: 2\n" };
    rerender({ tab: dirty });
    rerender({ tab: { ...dirty, blame: false } });

    expect(editor.showBlame).toHaveBeenLastCalledWith(false);
  });

  it("turns the column back on while the buffer has unsaved edits", () => {
    const tab = { ...ready(), content: "a: 2\n" };
    const { editor, rerender } = renderPane(tab);

    rerender({ tab: { ...tab, blame: true } });

    expect(editor.showBlame).toHaveBeenLastCalledWith(true);
  });

  // The dirty case (#52), and the bug it used to produce (#64). A blame is anchored
  // to the document it was measured against, so it is not installed against a
  // buffer git has not read — but the pane also does not tear the column down,
  // which is what emptied it on the first keystroke. The entries already in the
  // gutter follow the edits themselves.
  it("installs no blame while the buffer differs from disk, and clears none", () => {
    const tab = { ...ready(), blame: true };
    const { editor, rerender } = renderPane(tab, {
      blame: { blame: someBlame, error: null },
    });
    editor.setBlame = vi.fn();

    rerender({ tab: { ...tab, content: "a: 2\n" } });

    expect(editor.setBlame).not.toHaveBeenCalled();
  });

  // And the column itself is untouched by that guard, which is the half the
  // regression above got wrong.
  it("leaves the column shown when the buffer goes dirty", () => {
    const tab = { ...ready(), blame: true };
    const { editor, rerender } = renderPane(tab, {
      blame: { blame: someBlame, error: null },
    });
    editor.showBlame = vi.fn();

    rerender({ tab: { ...tab, content: "a: 2\n" } });

    expect(editor.showBlame).not.toHaveBeenCalledWith(false);
  });

  // Coming back clean reinstalls, which is what puts the column right after a
  // save and after a read that landed while the user was typing.
  it("installs the blame again once the buffer matches disk", () => {
    const tab = { ...ready(), blame: true };
    const { editor, rerender } = renderPane(tab, {
      blame: { blame: someBlame, error: null },
    });

    rerender({ tab: { ...tab, content: "a: 2\n" } });
    rerender({ tab: { ...tab, content: "a: 2\n", baseline: "a: 2\n" } });

    expect(editor.setBlame).toHaveBeenLastCalledWith(someBlame);
  });

  it("keeps the column shown with no entries when there is no blame to show", () => {
    const tab = { ...ready(), blame: true };
    const { editor, rerender } = renderPane(tab, {
      blame: { blame: someBlame, error: null },
    });

    rerender({ blame: NO_BLAME });

    expect(editor.showBlame).toHaveBeenLastCalledWith(true);
    expect(editor.setBlame).toHaveBeenLastCalledWith(null);
  });

  it("shows git's own words when a blame fails", () => {
    renderPane({ ...ready(), blame: true }, {
      blame: { blame: null, error: "fatal: no such path 'x.yaml' in HEAD" },
    });

    expect(screen.getByRole("alert").textContent).toContain("no such path");
  });

  // The blame is read for every file now, because the uncommitted-line
  // highlight needs it too (#64). A file git cannot blame is an ordinary file
  // to edit, so the refusal is not worth an alert until the user asks for the
  // column that shows it.
  it("says nothing about a failed blame while the column is off", () => {
    renderPane(ready(), {
      blame: { blame: null, error: "fatal: no such path 'x.yaml' in HEAD" },
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The blame failed, not the file. Replacing the buffer with a message would
  // cost the user the editor over a column they can turn off.
  it("keeps the file on screen when its blame fails", () => {
    const { container } = renderPane(ready("a: 1\n"), {
      blame: { blame: null, error: "fatal: nope" },
    });

    expect(container.querySelector("[data-testid=codemirror-host]")).not.toBeNull();
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
