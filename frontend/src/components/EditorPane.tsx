import { useEffect, useRef } from "react";
import type { MountedEditor } from "../lib/codemirror";
import { mountEditor } from "../lib/codemirror";
import type { EditorTab } from "../lib/editorTabs";
import { readOnlyNotice } from "../lib/editorTabs";
import type { Appearance } from "../lib/theme";
import { MarkdownPreview } from "./MarkdownPreview";

export interface EditorPaneProps {
  readonly tab: EditorTab;
  readonly active: boolean;
  readonly appearance: Appearance;
  onChange: (key: string, content: string) => void;
  onSave: (key: string) => void;
  onKeepMine: (key: string) => void;
  onTakeDisk: (key: string) => void;
  /** Injectable for tests; defaults to the real CodeMirror mount. */
  readonly mount?: typeof mountEditor;
}

/**
 * One open file.
 *
 * Every tab's pane stays mounted for as long as the tab is open, including
 * tabs belonging to a project that is not on screen: an unmounted pane would
 * lose its CodeMirror view and with it the undo history and cursor the user
 * expects to find when they come back — the same reason `TerminalPane` stays
 * mounted, applied to a different kind of state.
 */
export function EditorPane({
  tab,
  active,
  appearance,
  onChange,
  onSave,
  onKeepMine,
  onTakeDisk,
  mount = mountEditor,
}: EditorPaneProps) {
  const preview = tab.kind === "markdown" && tab.mode === "preview";
  const notice = readOnlyNotice(tab);

  return (
    <div
      className={`editor-pane${active ? "" : " editor-pane--hidden"}`}
      role="tabpanel"
      aria-label={tab.path}
      aria-hidden={!active}
    >
      {tab.conflict !== null && (
        <ConflictBar tab={tab} onKeepMine={onKeepMine} onTakeDisk={onTakeDisk} />
      )}

      {notice !== null && (
        <p className="editor-pane__notice" data-testid="readonly-notice">
          {notice}
        </p>
      )}

      {tab.error !== null && (
        <p className="editor-pane__error" role="alert">
          {tab.error}
        </p>
      )}

      {tab.status === "loading" && <p className="placeholder">Opening {tab.title}…</p>}

      {tab.status === "ready" &&
        (preview ? (
          <MarkdownPreview source={tab.content} />
        ) : (
          <CodeMirrorHost
            tab={tab}
            appearance={appearance}
            onChange={onChange}
            onSave={onSave}
            mount={mount}
          />
        ))}
    </div>
  );
}

interface ConflictBarProps {
  readonly tab: EditorTab;
  onKeepMine: (key: string) => void;
  onTakeDisk: (key: string) => void;
}

/**
 * The non-destructive prompt for a file that changed on disk under unsaved
 * edits — most often a `claude` session in the terminal pane writing the same
 * file this tab is holding.
 *
 * Neither choice is preselected and neither happens on a timer: both discard
 * something, so both are the user's to make. Saving is blocked until one of
 * them is taken (`canSave`), which is what stops Cmd+S from resolving the
 * conflict by silently winning it.
 */
function ConflictBar({ tab, onKeepMine, onTakeDisk }: ConflictBarProps) {
  return (
    <div className="editor-pane__conflict" role="alert">
      <span>
        {tab.title} changed on disk while you were editing it.
      </span>
      <button
        type="button"
        onClick={() => {
          onKeepMine(tab.key);
        }}
      >
        Keep my version
      </button>
      <button
        type="button"
        onClick={() => {
          onTakeDisk(tab.key);
        }}
      >
        Use the version on disk
      </button>
    </div>
  );
}

interface CodeMirrorHostProps {
  readonly tab: EditorTab;
  readonly appearance: Appearance;
  onChange: (key: string, content: string) => void;
  onSave: (key: string) => void;
  readonly mount: typeof mountEditor;
}

/**
 * The CodeMirror view's lifetime, kept in its own component so the editor is
 * built once per tab rather than rebuilt whenever the pane re-renders.
 *
 * The callbacks are held in a ref rather than closed over by the mount: the
 * view outlives every render, and a handler captured at mount time would
 * still be calling the first render's `onChange` a hundred keystrokes later.
 */
function CodeMirrorHost({
  tab,
  appearance,
  onChange,
  onSave,
  mount,
}: CodeMirrorHostProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<MountedEditor | null>(null);

  // Everything the mount reads, refreshed every render. The view outlives
  // every render, so a handler captured at mount time would still be calling
  // the first render's `onChange` a hundred keystrokes later — and reading
  // the seed values through the same ref is what lets the mount effect below
  // depend only on what should actually rebuild it.
  const latest = useRef({ tab, appearance, onChange, onSave });
  latest.current = { tab, appearance, onChange, onSave };

  // Mount once per tab. Content, theme and read-only state are pushed in by
  // the effects below rather than by rebuilding the view, which would throw
  // away undo history and the cursor on every change.
  useEffect(() => {
    const container = host.current;
    if (container === null) {
      return;
    }
    const seed = latest.current;
    const mounted = mount(container, {
      content: seed.tab.content,
      kind: seed.tab.kind,
      appearance: seed.appearance,
      readOnly: seed.tab.readOnly,
      onChange: (content) => {
        latest.current.onChange(latest.current.tab.key, content);
      },
      onSave: () => {
        latest.current.onSave(latest.current.tab.key);
      },
    });
    editor.current = mounted;
    return () => {
      mounted.dispose();
      editor.current = null;
    };
  }, [tab.key, tab.kind, mount]);

  // Content flows one way in normal editing — the view reports a change, the
  // hook stores it, and this pushes back the identical string, which
  // `setContent` recognises and ignores. It matters on the paths where the
  // two genuinely differ: an external reload, and take-disk.
  useEffect(() => {
    editor.current?.setContent(tab.content);
  }, [tab.content]);

  useEffect(() => {
    editor.current?.setTheme(appearance);
  }, [appearance]);

  useEffect(() => {
    editor.current?.setReadOnly(tab.readOnly);
  }, [tab.readOnly]);

  return <div className="editor-pane__cm" ref={host} data-testid="codemirror-host" />;
}
