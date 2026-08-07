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
  GutterMarker,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { BLAME_LABEL_WIDTH, blameLabel, blameTooltip, commitAt } from "./blame";
import type { EditorTabKind } from "./editorTabs";
import type { Blame, BlameCommit } from "./git";
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

/**
 * The editor's monospace stack.
 *
 * Named because two places need it and they must not drift: the content, and
 * the blame column beside it. CodeMirror's gutters inherit the app's UI font
 * unless told otherwise, and a proportional gutter makes `ch` mean something
 * other than a character — which is how a column sized to hold
 * `XX YYYY-MM-DD` ends up truncating it.
 */
const MONO_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** A mounted editor: what the pane drives. */
export interface MountedEditor {
  /** Replaces the document, unless it already holds exactly this text. */
  setContent(content: string): void;
  setTheme(appearance: Appearance): void;
  setReadOnly(readOnly: boolean): void;
  /**
   * Shows, hides or refreshes the blame column (#52).
   *
   * `shown` and `blame` are separate arguments because they are separate
   * states. A column that is shown with no blame to put in it is the tab's
   * dirty case: the toggle is still on, the entries are not trustworthy while
   * the buffer has an unsaved line in it, and the column keeps its width so
   * that typing does not shift the code sideways.
   */
  setBlame(shown: boolean, blame: Blame | null): void;
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
  const blameSlot = new Compartment();

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: options.content,
      extensions: [
        // Ahead of baseExtensions, so the blame column sits to the left of the
        // line numbers rather than between them and the code. Gutters are laid
        // out in the order their extensions appear.
        blameSlot.of([]),
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
    setBlame: (shown, blame) => {
      view.dispatch({
        effects: blameSlot.reconfigure(blameExtension(shown, blame)),
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

/**
 * The blame column (#52), as an extension that can be swapped in place.
 *
 * Nothing is added when the column is off, so a file nobody asked to blame
 * carries no gutter and no per-line callback at all. When it is on with no
 * blame behind it every line's marker is null, which leaves the gutter present
 * and empty — the width comes from CSS, not from its contents, so the code
 * does not move when the entries come and go.
 */
export function blameExtension(shown: boolean, blame: Blame | null): Extension {
  if (!shown) {
    return [];
  }
  return gutter({
    class: "cm-blame",
    lineMarker: (view, line) => {
      if (blame === null) {
        return null;
      }
      const commit = commitAt(blame, view.state.doc.lineAt(line.from).number);
      return commit === null ? null : new BlameEntry(commit);
    },
  });
}

/** One line's entry in the blame column. */
class BlameEntry extends GutterMarker {
  private readonly label: string;
  private readonly tooltip: string;
  private readonly uncommitted: boolean;

  constructor(commit: BlameCommit) {
    super();
    this.label = blameLabel(commit);
    this.tooltip = blameTooltip(commit);
    this.uncommitted = commit.uncommitted;
  }

  // CodeMirror keeps a marker's DOM when the new marker for a line compares
  // equal, so this is what stops every entry in the file being rebuilt on a
  // keystroke. Comparing the rendered strings rather than the commit is
  // deliberate: two entries that say the same thing are the same entry.
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameEntry &&
      other.label === this.label &&
      other.tooltip === this.tooltip
    );
  }

  override toDOM(): Node {
    const entry = document.createElement("span");
    entry.className = this.uncommitted
      ? "cm-blame-entry cm-blame-entry--uncommitted"
      : "cm-blame-entry";
    entry.textContent = this.label;
    entry.title = this.tooltip;
    return entry;
  }
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
        ".cm-content": { caretColor: c.caret, fontFamily: MONO_FAMILY },
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
        // A fixed width, so the column is the same size whether it holds
        // entries or is waiting on a save to get them back — the code to its
        // right must not move when the user starts typing. The label is sized
        // to `XX YYYY-MM-DD`, and anything longer is clipped rather than
        // allowed to widen it.
        ".cm-blame": {
          // Monospace and a width in `ch`, so the width is stated in the unit
          // the label is measured in: every committed entry is exactly
          // `XX YYYY-MM-DD`, and one extra character of slack keeps a subpixel
          // rounding from truncating the last digit of the date.
          //
          // content-box is the load-bearing part. Everything in a CodeMirror
          // view is border-box, under which this width would be the padded box
          // and the text would get whatever was left — about a character less
          // than the label needs, which truncates the date to `2026-01…`. The
          // width has to mean the text, so the padding goes outside it.
          boxSizing: "content-box",
          width: `${String(BLAME_LABEL_WIDTH + 1)}ch`,
          padding: "0 0.5rem 0 0.35rem",
          color: c.gutterFg,
          borderRight: `1px solid ${c.rule}`,
          fontFamily: MONO_FAMILY,
          fontSize: "0.85em",
          // Both spellings, for the reason style.css's `.shell` rule gives at
          // length: unprefixed `user-select` reached WebKit only in Safari 17,
          // and this app's window is a WebKit one.
          WebkitUserSelect: "none",
          userSelect: "none",
        },
        ".cm-blame-entry": {
          display: "block",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        },
        ".cm-blame-entry--uncommitted": { fontStyle: "italic", opacity: "0.7" },
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
  /** A hairline between one gutter and the next — the blame column's edge. */
  readonly rule: string;
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
  rule: "#262a33",
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
  rule: "#e3e5ea",
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
