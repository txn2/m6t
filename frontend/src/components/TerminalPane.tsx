import { useEffect, useRef, useState } from "react";
import { OpenTerminal } from "../../wailsjs/go/app/App";
import type { Endpoint } from "../lib/stream";
import { openTerminalSocket } from "../lib/stream";
import type { TerminalTab } from "../lib/tabs";
import { exitDescription } from "../lib/tabs";
import type { SessionStatus } from "../lib/terminalSession";
import { TerminalSession } from "../lib/terminalSession";
import type { Appearance } from "../lib/theme";
import { terminalPalette } from "../lib/theme";
import type { MountedTerminal } from "../lib/xterm";
import { mountTerminal } from "../lib/xterm";
import { SearchBar } from "./SearchBar";

/**
 * One terminal tab's pane: a mounted terminal, the session behind it, and the
 * states a tab can be in other than running.
 *
 * The pane is mounted for the life of the tab, visible or not. Hiding it with
 * CSS instead of unmounting is what makes "switch away mid-claude-session and
 * back" lose nothing: the scrollback, the selection and the viewport are all
 * still there, and the PTY never noticed.
 */
export interface TerminalPaneProps {
  readonly tab: TerminalTab;
  readonly endpoint: Endpoint;
  readonly active: boolean;
  readonly fontSize: number;
  readonly appearance: Appearance;
  onStatus: (key: string, status: SessionStatus) => void;
  onRestart: (key: string) => void;
  /**
   * Hands the live session up. The strip needs it to end a PTY the user
   * closed, because unmounting this pane deliberately only detaches.
   */
  onAttach: (key: string, session: TerminalSession) => void;
  /**
   * Takes it back. It carries the session rather than just the key so the
   * holder can tell this pane's session from its replacement's — a restart
   * mounts the new pane and unmounts the old one, and the order is React's to
   * choose.
   */
  onDetach: (key: string, session: TerminalSession) => void;
  /** Injectable for tests and harnesses; defaults to the real renderer. */
  mount?: typeof mountTerminal;
  /** Injectable for tests; defaults to the Wails binding. */
  open?: typeof OpenTerminal;
}

export function TerminalPane({
  tab,
  endpoint,
  active,
  fontSize,
  appearance,
  onStatus,
  onRestart,
  onAttach,
  onDetach,
  mount = mountTerminal,
  open = OpenTerminal,
}: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<MountedTerminal | null>(null);
  const [searching, setSearching] = useState(false);

  // Mount-time settings only. Held in a ref so that changing the font size
  // adjusts the live terminal (below) instead of rebuilding it — a rebuild
  // would drop the scrollback and the running program's screen with it.
  const initial = useRef({ fontSize, appearance }).current;

  useEffect(() => {
    const container = host.current;
    if (!container) {
      return;
    }

    const view = mount(container, {
      fontSize: initial.fontSize,
      palette: terminalPalette(initial.appearance),
      appleKeys: isApple(),
      onFind: () => {
        setSearching(true);
      },
    });
    terminal.current = view;

    const session = new TerminalSession({
      terminal: view,
      open: (cols, rows) => open(tab.cwd, cols, rows),
      connect: (sessionID) => openTerminalSocket(endpoint, sessionID),
      autorun: tab.autorun,
      onStatus: (status) => {
        onStatus(tab.key, status);
      },
    });
    onAttach(tab.key, session);
    void session.start();

    // The pane resizes with the window and with the panel divider, and the
    // child has to be told or it keeps drawing at the old width.
    const observer = new ResizeObserver(() => {
      session.resize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      onDetach(tab.key, session);
      // Detach, do not close: the session outlives the pane on purpose, so a
      // remount after a hot reload finds the shell where it left it.
      session.dispose();
      terminal.current = null;
    };
  }, [
    tab.key,
    tab.generation,
    tab.cwd,
    tab.autorun,
    endpoint,
    onStatus,
    onAttach,
    onDetach,
    open,
    mount,
    initial,
  ]);

  useEffect(() => {
    terminal.current?.setFontSize(fontSize);
  }, [fontSize]);

  useEffect(() => {
    terminal.current?.setPalette(terminalPalette(appearance));
  }, [appearance]);

  useEffect(() => {
    if (active && tab.status === "running") {
      terminal.current?.focus();
    }
  }, [active, tab.status]);

  const ended = tab.status === "exited" || tab.status === "failed";

  return (
    <section
      className={`pane${active ? " pane--active" : ""}`}
      aria-hidden={!active}
      data-testid={`pane-${tab.key}`}
    >
      {searching && (
        <SearchBar
          onFind={(query, direction) =>
            terminal.current?.find(query, direction) ?? false
          }
          onClose={() => {
            terminal.current?.clearSearch();
            setSearching(false);
            terminal.current?.focus();
          }}
        />
      )}
      <div className="pane__terminal" ref={host} />
      {ended && (
        <div className="pane__ended" role="status">
          <span className="pane__ended-text">
            {tab.title} — {exitDescription(tab)}
          </span>
          <button
            type="button"
            onClick={() => {
              onRestart(tab.key);
            }}
          >
            Restart
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Whether this platform's copy/paste and find chords are Cmd-based.
 *
 * `navigator.platform` is deprecated but is what the WKWebView reports
 * reliably; the userAgent check covers the runtimes that have dropped it.
 */
function isApple(): boolean {
  const nav: Navigator | undefined =
    typeof navigator === "undefined" ? undefined : navigator;
  if (!nav) {
    return false;
  }
  return /mac|iphone|ipad/i.test(nav.platform || nav.userAgent);
}
