import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import {
  HighlightStyle,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { history, historyKeymap, indentWithTab, standardKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { EditorTabKind } from "./editorTabs";
import type { Appearance } from "./theme";

/**
 * The editor, and the only module that knows CodeMirror exists.
 *
 * It is deliberately thin, for the reason `lib/xterm.ts` gives about the
 * terminal: constructing a view and wiring its extensions is the part that
 * needs a real document, so keeping the decisions out of here is what lets
 * the tab logic in `editorTabs.ts` be tested without one.
 *
 * The extension set is chosen against DESIGN.md §5's "deliberately light
 * editing": syntax, folding, search, history and line numbers, and
 * pointedly not autocomplete, linting or a language server. Schema
 * diagnostics are #13's, and this file should not grow them by accident.
 */

/** A mounted editor: what the pane drives. */
export interface MountedEditor {
  /** Replaces the document, unless it already holds exactly this text. */
  setContent(content: string): void;
  setTheme(appearance: Appearance): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  dispose(): void;
}

export interface EditorMountOptions {
  readonly content: string;
  readonly kind: EditorTabKind;
  readonly appearance: Appearance;
  readonly readOnly: boolean;
  /** Called with the whole document whenever the user changes it. */
  onChange: (content: string) => void;
  /**
   * Called on the save chord. It is caught here rather than on the pane
   * because CodeMirror handles keys before they bubble, and the webview's
   * own Cmd+S would otherwise reach the browser as well.
   */
  onSave: () => void;
}

/** Builds an editor inside `container` and returns the handle that drives it. */
export function mountEditor(
  container: HTMLElement,
  options: EditorMountOptions,
): MountedEditor {
  const themeSlot = new Compartment();
  const readOnlySlot = new Compartment();

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: options.content,
      extensions: [
        ...baseExtensions(options.onSave),
        ...languageFor(options.kind),
        themeSlot.of(editorTheme(options.appearance)),
        readOnlySlot.of(readOnlyExtension(options.readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            options.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  return {
    // Reconciling React state onto a CodeMirror document has one rule that
    // matters: a dispatch that replaces the doc also moves the cursor, so
    // echoing back the very text the user just typed would drag the caret to
    // the end of the file on every keystroke. Comparing first is what makes
    // this safe to call on every render.
    setContent: (content) => {
      const current = view.state.doc.toString();
      if (current === content) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    },
    setTheme: (appearance) => {
      view.dispatch({ effects: themeSlot.reconfigure(editorTheme(appearance)) });
    },
    setReadOnly: (readOnly) => {
      view.dispatch({
        effects: readOnlySlot.reconfigure(readOnlyExtension(readOnly)),
      });
    },
    focus: () => {
      view.focus();
    },
    dispose: () => {
      view.destroy();
    },
  };
}

/** The extensions every document gets, whatever its language. */
export function baseExtensions(onSave: () => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    drawSelection(),
    bracketMatching(),
    indentOnInput(),
    history(),
    codeFolding(),
    foldGutter(),
    search({ top: true }),
    EditorView.lineWrapping,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSave();
          return true;
        },
      },
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...standardKeymap,
      indentWithTab,
    ]),
  ];
}

/**
 * The language support for a tab's kind.
 *
 * YAML comes from the Lezer grammar rather than a stream parser, which is
 * what makes a multi-document file (`---` separated, the shape half of
 * Kubernetes manifests take) parse and fold as the several documents it
 * actually is instead of one confused one.
 */
export function languageFor(kind: EditorTabKind): Extension[] {
  if (kind === "yaml") {
    return [yaml()];
  }
  if (kind === "markdown") {
    return [markdown()];
  }
  return [];
}

/** The read-only state, as an extension that can be swapped in place. */
export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * The editor's colours for an appearance.
 *
 * These are the same values as `style.css`'s custom properties and
 * `theme.ts`'s terminal palettes, and they are restated here for the reason
 * `theme.ts` already documents about xterm: CodeMirror paints through its own
 * CSS-in-JS layer, so the scheme has to exist as data as well as as a custom
 * property.
 */
export function editorTheme(appearance: Appearance): Extension {
  const c = appearance === "light" ? LIGHT : DARK;
  return [
    EditorView.theme(
      {
        "&": { color: c.fg, backgroundColor: c.bg, height: "100%" },
        ".cm-content": {
          caretColor: c.caret,
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.caret },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          { backgroundColor: c.selection },
        ".cm-activeLine": { backgroundColor: c.activeLine },
        ".cm-gutters": {
          backgroundColor: c.gutterBg,
          color: c.gutterFg,
          border: "none",
        },
        ".cm-activeLineGutter": { backgroundColor: c.activeLine, color: c.fg },
        ".cm-panels": { backgroundColor: c.gutterBg, color: c.fg },
        ".cm-searchMatch": { backgroundColor: c.searchMatch },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: c.searchMatchActive,
        },
        ".cm-foldPlaceholder": {
          backgroundColor: c.gutterBg,
          border: "none",
          color: c.gutterFg,
        },
      },
      { dark: appearance === "dark" },
    ),
    syntaxHighlighting(highlightStyleFor(c)),
  ];
}

/** One appearance's colours, as the theme builder consumes them. */
interface EditorPalette {
  readonly bg: string;
  readonly fg: string;
  readonly caret: string;
  readonly selection: string;
  readonly activeLine: string;
  readonly gutterBg: string;
  readonly gutterFg: string;
  readonly searchMatch: string;
  readonly searchMatchActive: string;
  readonly key: string;
  readonly string: string;
  readonly number: string;
  readonly comment: string;
  readonly keyword: string;
  readonly heading: string;
  readonly link: string;
}

const DARK: EditorPalette = {
  bg: "#16181d",
  fg: "#e6e8ee",
  caret: "#e6e8ee",
  selection: "#33405c",
  activeLine: "#1c1f26",
  gutterBg: "#16181d",
  gutterFg: "#5c6370",
  searchMatch: "#3a4a6b",
  searchMatchActive: "#61afef",
  key: "#61afef",
  string: "#8cc265",
  number: "#d5b06b",
  comment: "#5c6370",
  keyword: "#c678dd",
  heading: "#61afef",
  link: "#56b6c2",
};

const LIGHT: EditorPalette = {
  bg: "#fbfbfd",
  fg: "#22252d",
  caret: "#22252d",
  selection: "#c9daf5",
  activeLine: "#f0f1f5",
  gutterBg: "#fbfbfd",
  gutterFg: "#6b7280",
  searchMatch: "#d6e4fb",
  searchMatchActive: "#2f6fd0",
  key: "#2f6fd0",
  string: "#4d8f2f",
  number: "#9a6f10",
  comment: "#6b7280",
  keyword: "#9b45bc",
  heading: "#2f6fd0",
  link: "#2f8b96",
};

/** The token colours, shared by both languages: a YAML key and a markdown
 * heading are the same `propertyName`/`heading` tags whichever file they are
 * in, so one style covers both. */
function highlightStyleFor(c: EditorPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: c.key },
    { tag: [tags.string, tags.special(tags.string)], color: c.string },
    { tag: [tags.number, tags.bool, tags.null], color: c.number },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.comment, fontStyle: "italic" },
    { tag: [tags.keyword, tags.operator, tags.meta], color: c.keyword },
    { tag: [tags.heading], color: c.heading, fontWeight: "bold" },
    { tag: [tags.link, tags.url], color: c.link, textDecoration: "underline" },
    { tag: [tags.emphasis], fontStyle: "italic" },
    { tag: [tags.strong], fontWeight: "bold" },
    { tag: [tags.monospace], color: c.string },
    { tag: [tags.invalid], color: "#e06c75" },
  ]);
}
