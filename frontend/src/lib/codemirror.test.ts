import { afterEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import type { DecorationSet } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { blameExtension, blameMarks } from "./blameMarks";
import { languageFor, mountEditor, readOnlyExtension } from "./codemirror";
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

/** What each line of the column says, in line order. */
function labelsIn(container: HTMLElement): string[] {
  return entriesIn(container).map((entry) => entry.textContent ?? "");
}

describe("the blame column", () => {
  it("is absent until it is asked for", () => {
    const { container } = mount({ content: "a: 1\nb: 2\n" });

    expect(container.querySelector(".cm-blame")).toBeNull();
  });

  it("shows an entry per line, attributed to that line's commit", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1]));

    const entries = entriesIn(container);
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toBe("CJ 2026-08-06");
    expect(entries[0].title).toContain("Give editor tabs a context menu");
    expect(entries[1].textContent).toBe("uncommitted");
  });

  it("marks an uncommitted entry, so it is not read as a name", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1]));

    const entries = entriesIn(container);
    expect(entries[0].className).not.toContain("uncommitted");
    expect(entries[1].className).toContain("cm-blame-entry--uncommitted");
  });

  // The dirty-buffer case (#52): the toggle is still on, the line numbers the
  // blame was stated in are no longer the buffer's, and the column holds its
  // place so the code does not shift when the entries go.
  it("keeps the column and drops the entries when there is no blame to show", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1]));

    editor.setBlame(null);

    expect(container.querySelector(".cm-blame")).not.toBeNull();
    expect(entriesIn(container)).toHaveLength(0);
  });

  // Pressing the toggle is never conditional on the state of the buffer: the
  // gutter goes whether or not the file has unsaved edits in it, which an
  // earlier version of this got wrong by folding the toggle and the install
  // into one call.
  it("takes the column away with a blame still installed and the text edited", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));
    viewIn(container).dispatch({ changes: { from: 0, insert: "X" } });
    expect(entriesIn(container)).toHaveLength(2);

    editor.showBlame(false);

    expect(container.querySelector(".cm-blame")).toBeNull();
  });

  // And what it was holding is still there when it comes back, without a
  // re-read: the anchors live outside the compartment the toggle reconfigures.
  it("brings the same entries back when the toggle goes on again", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    editor.showBlame(false);
    editor.showBlame(true);

    expect(labelsIn(container)).toEqual(["CJ 2026-08-06", "CJ 2026-08-06"]);
  });

  it("takes the column away when the toggle goes off", () => {
    const { editor, container } = mount({ content: "a: 1\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0]));

    editor.showBlame(false);

    expect(container.querySelector(".cm-blame")).toBeNull();
  });

  // A buffer longer than the blame — what an external change produces between
  // the reload and the re-read. The surplus lines are not in the blame, so they
  // are not in any commit either, and the column says so rather than trailing
  // off into a gap.
  it("calls a line the blame does not reach uncommitted", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });

    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    expect(labelsIn(container)).toEqual([
      "CJ 2026-08-06",
      "CJ 2026-08-06",
      "uncommitted",
    ]);
  });

  it("does not touch the document, the way every other setter here does not", () => {
    const { editor, container } = mount({ content: "a: 1\n" });

    editor.showBlame(true);
    editor.setBlame(blameOver([0]));

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

    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0, 0]));
    editor.showBlame(false);

    expect(view.state.selection.main.anchor).toBe(3);
    // The edit above is still undoable: a lost history would leave the
    // document as it is.
    undo(view);
    expect(view.state.doc.toString()).toBe("a: 1\nb: 2\n");
  });
});

// The bug this suite exists for (#64): every entry in the column vanished as soon as
// the user typed anything, and stayed gone until the file was saved. What
// follows pins the rule that replaced it — an entry stands wherever the line
// still reads as git measured it, and moves with the line when the text above
// it does.
describe("the blame column under an unsaved edit", () => {
  /** Types `text` at `at` in the mounted view, as the user would. */
  function type(container: HTMLElement, at: number, text: string): void {
    viewIn(container).dispatch({ changes: { from: at, insert: text } });
  }

  it("keeps the lines the edit did not touch", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0, 0]));

    // An insertion inside the middle line, the commonest edit there is.
    type(container, 8, "X");

    expect(labelsIn(container).slice(0, 3)).toEqual([
      "CJ 2026-08-06",
      "uncommitted",
      "CJ 2026-08-06",
    ]);
  });

  // The line the user is typing into is theirs and in no commit, which is
  // exactly what git says about a line it finds in the working tree and nowhere
  // else. A blank there would read as the column having broken.
  it("calls the line being edited uncommitted rather than leaving it blank", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    type(container, 0, "X");

    expect(labelsIn(container).slice(0, 2)).toEqual(["uncommitted", "CJ 2026-08-06"]);
  });

  // And it is marked as such, not merely labelled: the entry carries the class
  // the stylesheet colours, so an edited line stands out in the column.
  it("marks the edited line the way it marks git's own uncommitted lines", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    type(container, 0, "X");

    expect(entriesIn(container)[0].className).toContain("cm-blame-entry--uncommitted");
    expect(entriesIn(container)[1].className).not.toContain("cm-blame-entry--uncommitted");
  });

  // The failure the old behaviour was avoiding, and the one this must not
  // reintroduce: a line pushed down by an insertion above it has to take its
  // attribution with it, or the column names the wrong person.
  it("follows a line pushed down by an inserted line above it", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    // Line 1 is the commit, line 2 is uncommitted — two distinguishable
    // entries, so a stale mapping shows up as the wrong text and not merely as
    // the wrong count.
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1]));

    type(container, 0, "new: line\n");

    const view = viewIn(container);
    expect(view.state.doc.line(2).text).toBe("a: 1");
    // The inserted line is nobody's; the two below it kept their own entries
    // and moved down with the text.
    expect(labelsIn(container).slice(0, 3)).toEqual([
      "uncommitted",
      "CJ 2026-08-06",
      "uncommitted",
    ]);
  });

  // The deleted line's entry must not slide onto the line that took its place,
  // which would put a name against text it never described.
  it("does not hand a deleted line's entry to its successor", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });
    // Line 2 is git's own uncommitted line, so a survivor that inherited it
    // would be visible as the wrong label rather than only as a wrong count.
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1, 0]));

    // Remove the middle line whole, newline included.
    viewIn(container).dispatch({ changes: { from: 5, to: 10 } });

    expect(labelsIn(container).slice(0, 2)).toEqual(["CJ 2026-08-06", "CJ 2026-08-06"]);
  });

  // Every well-formed file ends in a newline, and CodeMirror counts what
  // follows it as a line. git does not, and neither does any other editor's
  // gutter: a permanent `uncommitted` against the terminator would be on screen
  // for every file in the repository.
  it("says nothing about the empty line a final newline leaves behind", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    expect(viewIn(container).state.doc.lines).toBe(3);
    expect(labelsIn(container)).toEqual(["CJ 2026-08-06", "CJ 2026-08-06"]);
  });

  it("says nothing about it even once the file has been edited", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));

    type(container, 0, "X");

    expect(labelsIn(container)).toEqual(["uncommitted", "CJ 2026-08-06"]);
  });

  it("calls a line typed at the end of the file uncommitted", () => {
    const { editor, container } = mount({ content: "a: 1\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0]));

    const view = viewIn(container);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "b: 2\n" } });

    expect(labelsIn(container)).toEqual(["CJ 2026-08-06", "uncommitted"]);
  });

  // Undoing back to the text on disk is the same file git measured, so the
  // column comes back whole without a re-read.
  it("comes back when the edit is undone", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0]));
    const view = viewIn(container);

    view.dispatch({ changes: { from: 0, insert: "X" } });
    expect(labelsIn(container)[0]).toBe("uncommitted");
    undo(view);

    expect(labelsIn(container).slice(0, 2)).toEqual(["CJ 2026-08-06", "CJ 2026-08-06"]);
  });
});

/**
 * The band on every line that is in no commit (#64).
 *
 * It is the same fact the column's `uncommitted` entry states, drawn where the
 * question is actually asked — on the code — and it runs independently of the
 * column, because that is the whole reason it exists.
 */
describe("the uncommitted-line highlight", () => {
  /** Which lines carry the band, 1-based. */
  function bandedLines(container: HTMLElement): number[] {
    const lines = [...container.querySelectorAll(".cm-content > .cm-line")];
    return lines
      .map((line, index) => (line.classList.contains("cm-uncommitted-line") ? index + 1 : 0))
      .filter((n) => n > 0);
  }

  it("bands nothing until a blame has been read", () => {
    const { container } = mount({ content: "a: 1\nb: 2\n" });

    expect(bandedLines(container)).toEqual([]);
  });

  it("bands the line git itself reports as uncommitted", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.setBlame(blameOver([0, 1]));

    expect(bandedLines(container)).toEqual([2]);
  });

  it("bands the line the user is editing and leaves the rest alone", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });
    editor.setBlame(blameOver([0, 0, 0]));
    expect(bandedLines(container)).toEqual([]);

    viewIn(container).dispatch({ changes: { from: 8, insert: "X" } });

    expect(bandedLines(container)).toEqual([2]);
  });

  // The case the "has a blame been read" flag exists for. A file nobody has
  // committed yet has no attributed lines at all, so a reader that took an
  // empty anchor set for "nothing was read" would leave the whole file unmarked
  // — the file where the marking matters most.
  it("bands every line of a file that is in no commit at all", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });

    editor.setBlame(blameOver([1, 1]));

    expect(bandedLines(container)).toEqual([1, 2]);
  });

  it("does not band the empty line a final newline leaves behind", () => {
    const { editor, container } = mount({ content: "a: 1\n" });

    editor.setBlame(blameOver([1]));

    expect(viewIn(container).state.doc.lines).toBe(2);
    expect(bandedLines(container)).toEqual([1]);
  });

  // The point of it being a separate extension: the column is fourteen
  // characters the user often wants back, and closing it must not take the
  // answer with it.
  it("stays when the blame column is turned off", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1]));

    editor.showBlame(false);

    expect(container.querySelector(".cm-blame")).toBeNull();
    expect(bandedLines(container)).toEqual([2]);
  });

  it("goes when the blame is cleared", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\n" });
    editor.setBlame(blameOver([0, 1]));

    editor.setBlame(null);

    expect(bandedLines(container)).toEqual([]);
  });
});

/**
 * The invariant the two marks broke on screen: a wrapped file could show
 * `uncommitted` in the column against one line and the band against another,
 * and scrolling put it right.
 *
 * jsdom lays nothing out, so it cannot reproduce the wrapping that exposed it.
 * What it can hold is the property underneath — that both marks are built from
 * one answer, over the same lines, at every point in a session — which is what
 * makes the disagreement impossible rather than merely unobserved.
 */
describe("the column and the band describe the same lines", () => {
  /** The line numbers a range set covers, in order. */
  function linesIn(container: HTMLElement, set: DecorationSet): number[] {
    const doc = viewIn(container).state.doc;
    const covered: number[] = [];
    for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
      covered.push(doc.lineAt(cursor.from).number);
    }
    return covered;
  }

  /** The lines the column calls uncommitted. Every line carries an entry, so
   * the ones comparable with the band are those rendering that label. */
  function columnSaysUncommitted(container: HTMLElement): number[] {
    const view = viewIn(container);
    const doc = view.state.doc;
    const named: number[] = [];
    const cursor = view.state.field(blameMarks).entries.iter();
    for (; cursor.value !== null; cursor.next()) {
      const rendered = cursor.value.toDOM?.(view) as HTMLElement | undefined;
      if (rendered?.textContent === "uncommitted") {
        named.push(doc.lineAt(cursor.from).number);
      }
    }
    return named;
  }

  function agrees(container: HTMLElement, lines: number[]): void {
    expect(columnSaysUncommitted(container)).toEqual(lines);
    expect(linesIn(container, viewIn(container).state.field(blameMarks).bands)).toEqual(lines);
  }

  it("through an edit, a re-read, and a second edit somewhere else", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\nd: 4\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 0, 0, 0]));
    const view = viewIn(container);
    agrees(container, []);

    // Edit line 2.
    view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: "X" } });
    agrees(container, [2]);

    // Save: a fresh blame measured against the text as it now stands.
    editor.setBlame(blameOver([0, 0, 0, 0]));
    agrees(container, []);

    // Edit line 4 — the case the screenshot caught, where the column named the
    // previous edit and the band named this one.
    view.dispatch({ changes: { from: view.state.doc.line(4).from, insert: "Y" } });
    agrees(container, [4]);
  });

  it("through an insertion that moves every line under it", () => {
    const { editor, container } = mount({ content: "a: 1\nb: 2\nc: 3\n" });
    editor.showBlame(true);
    editor.setBlame(blameOver([0, 1, 0]));
    agrees(container, [2]);

    viewIn(container).dispatch({ changes: { from: 0, insert: "new: line\n" } });

    // The inserted line is nobody's, and git's own uncommitted line moved down
    // with its text — both marks say so about both lines.
    agrees(container, [1, 3]);
  });
});

describe("the blame extension", () => {
  it("adds nothing at all when the column is off", () => {
    // Not merely an empty gutter: a file nobody asked to blame should carry no
    // per-line callback for CodeMirror to run on every update.
    expect(blameExtension(false)).toEqual([]);
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
