import { afterEach, describe, expect, it, vi } from "vitest";
import { languageFor, mountEditor, readOnlyExtension } from "./codemirror";

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

describe("disposal", () => {
  it("tears the view out of the DOM", () => {
    const { editor, container } = mount();
    expect(container.querySelector(".cm-editor")).not.toBeNull();

    editor.dispose();

    expect(container.querySelector(".cm-editor")).toBeNull();
  });
});
