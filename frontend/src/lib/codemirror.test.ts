import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { blameExtension, languageFor, mountEditor, readOnlyExtension } from "./codemirror";
import type { Blame } from "./git";

const mounted: { dispose: () => void }[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.dispose();
  }
  document.body.innerHTML = "";
});

type Seed = {
  content?: string;
  kind?: "yaml" | "markdown" | "text";
  appearance?: "dark" | "light";
  readOnly?: boolean;
};

/** Mounts an editor into a fresh container, disposed after the test. The
 * callbacks stay typed as mocks so assertions can reach `mockClear`. */
function mount(over: Seed = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = vi.fn();
  const onSave = vi.fn();
  const editor = mountEditor(container, {
    content: "a: 1\n",
    kind: "yaml",
    appearance: "dark",
    readOnly: false,
    ...over,
    onChange,
    onSave,
  });
  mounted.push(editor);
  return { editor, options: { onChange, onSave }, container };
}

/** The live view behind a mounted editor, for the few assertions that are
 * about editor state rather than about what is on screen. */
function viewIn(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container);
  if (view === null) {
    throw new Error("no CodeMirror view in this container");
  }
  return view;
}

/** The document as CodeMirror currently holds it, read off the DOM so the
 * assertion goes through the same rendering the user sees. */
function textOf(container: HTMLElement): string {
  return container.querySelector(".cm-content")?.textContent ?? "";
}

describe("mounting", () => {
  it("renders the content it was given", () => {
    const { container } = mount({ content: "kind: Deployment\n" });

    expect(textOf(container)).toContain("kind: Deployment");
  });

  it("shows line numbers", () => {
    const { container } = mount({ content: "a: 1\nb: 2\n" });

    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  it("offers a fold gutter, so a long manifest can be collapsed", () => {
    const { container } = mount({ content: "a:\n  b: 1\n" });

    expect(container.querySelector(".cm-foldGutter")).not.toBeNull();
  });
});

describe("reconciling content from React", () => {
  it("replaces the document when the incoming content differs", () => {
    const { editor, container } = mount({ content: "a: 1\n" });

    editor.setContent("a: 2\n");

    expect(textOf(container)).toContain("a: 2");
  });

  // The classic CodeMirror-in-React defect: the component echoes state back
  // on every render, each echo dispatches a full-document replacement, the
  // change listener fires, and state updates again — a loop that also drags
  // the caret to the end of the file on every keystroke. Comparing before
  // dispatching is what prevents it.
  //
  // Asserting on the change listener rather than on the text is what makes
  // this discriminating: a blind replacement leaves the text identical, so
  // only the absence of a change event distinguishes the two.
  it("dispatches nothing when the content already matches", () => {
    const { editor, options } = mount({ content: "a: 1\nb: 2\n" });
    options.onChange.mockClear();

    editor.setContent("a: 1\nb: 2\n");

    expect(options.onChange).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  it("reports the whole document on a change", () => {
    const { editor, options, container } = mount({ content: "a: 1\n" });

    editor.setContent("a: 1\nb: 2\n");

    expect(options.onChange).toHaveBeenCalledWith("a: 1\nb: 2\n");
    expect(textOf(container)).toContain("b: 2");
  });

  it("refuses edits while read-only", () => {
    const { editor, container } = mount({ content: "a: 1\n", readOnly: true });

    // A read-only view must not be contenteditable: this is what stops the
    // user typing into a file the backend will not let us write back.
    const content = container.querySelector(".cm-content");
    expect(content?.getAttribute("contenteditable")).toBe("false");

    editor.setReadOnly(false);
    expect(content?.getAttribute("contenteditable")).toBe("true");
  });
});

describe("theming", () => {
  it("swaps the theme in place without rebuilding the document", () => {
    const { editor, container } = mount({ content: "a: 1\n", appearance: "dark" });
    const before = textOf(container);

    editor.setTheme("light");

    expect(textOf(container)).toBe(before);
  });
});

describe("language selection", () => {
  it("gives yaml and markdown their own support and text none", () => {
    expect(languageFor("yaml")).toHaveLength(1);
    expect(languageFor("markdown")).toHaveLength(1);
    expect(languageFor("text")).toHaveLength(0);
  });

  // Half of Kubernetes manifests are multi-document. A parser that treated
  // `---` as ordinary content would highlight and fold the whole file as one
  // confused document.
  it("parses a multi-document yaml file without collapsing it into one", () => {
    const { container } = mount({
      content: "kind: Service\n---\nkind: Deployment\n",
    });

    expect(textOf(container)).toContain("kind: Service");
    expect(textOf(container)).toContain("kind: Deployment");
  });
});

describe("the read-only extension", () => {
  it("produces both halves of the guard, so neither state nor view accepts input", () => {
    // Two extensions: EditorState.readOnly (which blocks transactions) and
    // EditorView.editable (which blocks the DOM). Dropping either one leaves
    // a file the user can appear to type into.
    expect(readOnlyExtension(true)).toHaveLength(2);
  });
});

/** A blame attributing every line to one of two commits, by index. */
function blameOver(lines: number[]): Blame {
  return {
    commits: [
      {
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        author: "Craig Johnston",
        authorTime: Math.floor(new Date(2026, 7, 6, 9, 30).getTime() / 1000),
        summary: "Give editor tabs a context menu",
        uncommitted: false,
      },
      {
        sha: "0000000000000000000000000000000000000000",
        author: "Not Committed Yet",
        authorTime: 0,
        summary: "",
        uncommitted: true,
      },
    ],
    lines,
  };
}

/** The blame column's rendered entries, in line order. */
function entriesIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".cm-blame .cm-blame-entry")];
}

describe("the blame column", () => {
  it("is absent until it is asked for", () => {
    const { container } = mount({ content: "a: 1\nb: 2\n" });

    expect(container.querySelector(".cm-blame")).toBeNull();
  });

  it("shows an entry per line, attributed to that line's commit", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.setBlame(true, blameOver([0, 1]));

    const entries = entriesIn(container);
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toBe("CJ 2026-08-06");
    expect(entries[0].title).toContain("Give editor tabs a context menu");
    expect(entries[1].textContent).toBe("uncommitted");
  });

  it("marks an uncommitted entry, so it is not read as a name", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.setBlame(true, blameOver([0, 1]));

    const entries = entriesIn(container);
    expect(entries[0].className).not.toContain("uncommitted");
    expect(entries[1].className).toContain("cm-blame-entry--uncommitted");
  });

  // The dirty-buffer case (#52): the toggle is still on, the line numbers the
  // blame was stated in are no longer the buffer's, and the column holds its
  // place so the code does not shift when the entries go.
  it("keeps the column and drops the entries when there is no blame to show", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.setBlame(true, blameOver([0, 1]));

    editor.setBlame(true, null);

    expect(container.querySelector(".cm-blame")).not.toBeNull();
    expect(entriesIn(container)).toHaveLength(0);
  });

  it("takes the column away when the toggle goes off", () => {
    const { editor, container } = mount({ content: "a: 1\n" });
    editor.setBlame(true, blameOver([0]));

    editor.setBlame(false, null);

    expect(container.querySelector(".cm-blame")).toBeNull();
  });

  it("leaves a line the blame does not reach without an entry", () => {
    // A buffer longer than the blame — what an external change produces
    // between the reload and the re-read.
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });

    editor.setBlame(true, blameOver([0, 0]));

    expect(entriesIn(container)).toHaveLength(2);
  });

  it("does not touch the document, the way every other setter here does not", () => {
    const { editor, container } = mount({ content: "a: 1\n" });

    editor.setBlame(true, blameOver([0]));

    expect(textOf(container)).toContain("a: 1");
  });

  // The column is a view, not an edit. Turning it on must cost the user
  // nothing they were in the middle of — a reconfiguration that moved the
  // caret or emptied the undo stack would make the toggle unusable while
  // working, which is the only time anyone reaches for it.
  it("leaves the selection and the undo history alone", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.setContent("a: 1\nb: 2\nc: 3\n");
    const view = viewIn(container);
    view.dispatch({ selection: { anchor: 3 } });

    editor.setBlame(true, blameOver([0, 0, 0]));
    editor.setBlame(false, null);

    expect(view.state.selection.main.anchor).toBe(3);
    // The edit above is still undoable: a lost history would leave the
    // document as it is.
    undo(view);
    expect(view.state.doc.toString()).toBe("a: 1\nb: 2\n");
  });
});

describe("the blame extension", () => {
  it("adds nothing at all when the column is off", () => {
    // Not merely an empty gutter: a file nobody asked to blame should carry no
    // per-line callback for CodeMirror to run on every update.
    expect(blameExtension(false, blameOver([0]))).toEqual([]);
  });
});

describe("disposal", () => {
  it("tears the view out of the DOM", () => {
    const { editor, container } = mount();
    expect(container.querySelector(".cm-editor")).not.toBeNull();

    editor.dispose();

    expect(container.querySelector(".cm-editor")).toBeNull();
  });
});
