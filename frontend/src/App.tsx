import { useCallback, useEffect, useRef, useState } from "react";
import { StreamEndpoint } from "../wailsjs/go/app/App";
import { TerminalPane } from "./components/TerminalPane";
import { TerminalTabs } from "./components/TerminalTabs";
import { Toolbar } from "./components/Toolbar";
import { type BuildStatus, detachedBuild, loadBuild } from "./lib/build";
import type { Endpoint } from "./lib/stream";
import type { TerminalTab } from "./lib/tabs";
import {
  endingClosesTheTab,
  newTab,
  nextTitle,
  patchTab,
  removeTab,
  renameTab,
  restartTab,
  selectionAfterClose,
  statusPatch,
} from "./lib/tabs";
import type { SessionStatus, TerminalSession } from "./lib/terminalSession";
import type { Appearance } from "./lib/theme";
import {
  DEFAULT_FONT_SIZE,
  clampFontSize,
  preferredAppearance,
} from "./lib/theme";

const initialStatus: BuildStatus = { info: detachedBuild, attached: false };

/** The line typed into a fresh shell by the "Claude Code" action. */
const CLAUDE_COMMAND = "claude";

export interface AppProps {
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  load?: typeof loadBuild;
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  endpoint?: () => Promise<Endpoint>;
}

/**
 * The dev layout for issue #4: a terminal tab strip over a terminal pane.
 *
 * This is the spike-exit shell, not the workbench. The three-pane project
 * layout in DESIGN.md §5 arrives with projects (#5); what has to be true here
 * is that a full-screen TUI in one of these tabs feels like a terminal.
 */
export default function App({
  load = loadBuild,
  endpoint = StreamEndpoint,
}: AppProps) {
  const [build, setBuild] = useState<BuildStatus>(initialStatus);
  const [stream, setStream] = useState<Endpoint | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [cwd, setCwd] = useState("");
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [appearance, setAppearance] = useState<Appearance>(preferredAppearance);

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Tab keys are never reused: a key that came back would let React match a new
  // tab's pane to a dead one's terminal.
  const keys = useRef(0);
  // The live sessions, by tab key. They are the panes' to own and the strip's
  // to end — closing a tab has to kill its PTY, and unmounting deliberately
  // does not (PROTOCOL.md §4).
  const sessions = useRef(new Map<string, TerminalSession>());

  useEffect(() => {
    let current = true;
    void load().then((next) => {
      if (current) {
        setBuild(next);
      }
    });
    return () => {
      current = false;
    };
  }, [load]);

  useEffect(() => {
    let current = true;
    // An async body rather than .then: the generated binding throws
    // synchronously when there is no Wails runtime behind it, and a UI with no
    // terminals has to say why rather than take the whole render down.
    void (async () => {
      try {
        const next = await endpoint();
        if (current) {
          setStream(next);
        }
      } catch (error: unknown) {
        if (current) {
          setStreamError(describe(error));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [endpoint]);

  const handleAttach = useCallback((key: string, session: TerminalSession) => {
    sessions.current.set(key, session);
  }, []);

  // Only the session that is actually registered is removed: a restart mounts
  // the replacement pane and unmounts the old one, and a blind delete would
  // drop the new session on the old one's way out — leaving the tab's shell
  // with nothing able to kill it.
  const handleDetach = useCallback((key: string, session: TerminalSession) => {
    if (sessions.current.get(key) === session) {
      sessions.current.delete(key);
    }
  }, []);

  // The current strip, for the handlers that must stay stable across renders:
  // a pane holds its callbacks for the life of its session, so a handler that
  // changed identity would rebuild the terminal underneath a running program.
  const strip = useRef<TerminalTab[]>([]);
  useEffect(() => {
    strip.current = tabs;
  }, [tabs]);

  const dropTab = useCallback((key: string) => {
    setActiveKey((active) => selectionAfterClose(strip.current, key, active));
    setTabs((current) => removeTab(current, key));
  }, []);

  const handleStatus = useCallback(
    (key: string, status: SessionStatus) => {
      if (endingClosesTheTab(status)) {
        dropTab(key);
        return;
      }
      setTabs((current) => patchTab(current, key, statusPatch(status)));
    },
    [dropTab],
  );

  const create = useCallback(
    (autorun: string | null) => {
      keys.current += 1;
      const key = `tab-${String(keys.current)}`;
      setTabs((current) => [
        ...current,
        newTab(key, nextTitle(current, autorun ?? "shell"), cwd, autorun),
      ]);
      setActiveKey(key);
    },
    [cwd],
  );

  const handleClose = useCallback(
    (key: string) => {
      // Ending the session is the point of closing a tab. Unmounting the pane
      // only detaches, so without this the shell would run on unreachable.
      sessions.current.get(key)?.close();
      dropTab(key);
    },
    [dropTab],
  );

  const handleRestart = useCallback((key: string) => {
    setTabs((current) => restartTab(current, key));
  }, []);

  const handleRename = useCallback((key: string, title: string) => {
    setTabs((current) => renameTab(current, key, title));
  }, []);

  return (
    <main className={`shell shell--${appearance}`}>
      <Toolbar
        cwd={cwd}
        onCwd={setCwd}
        fontSize={fontSize}
        onFontSize={(px) => {
          setFontSize(clampFontSize(px));
        }}
        appearance={appearance}
        onAppearance={setAppearance}
      />

      <TerminalTabs
        tabs={tabs}
        activeKey={activeKey}
        onSelect={setActiveKey}
        onClose={handleClose}
        onRename={handleRename}
        onCreate={() => {
          create(null);
        }}
        onCreateClaude={() => {
          create(CLAUDE_COMMAND);
        }}
      />

      <div className="panes">
        {stream === null ? (
          <p className="panes__empty" data-testid="stream-status">
            {streamError ?? "connecting to the terminal backend…"}
          </p>
        ) : (
          tabs.map((tab) => (
            <TerminalPane
              key={`${tab.key}:${String(tab.generation)}`}
              tab={tab}
              endpoint={stream}
              active={tab.key === activeKey}
              fontSize={fontSize}
              appearance={appearance}
              onStatus={handleStatus}
              onRestart={handleRestart}
              onAttach={handleAttach}
              onDetach={handleDetach}
            />
          ))
        )}
        {stream !== null && tabs.length === 0 && (
          <p className="panes__empty">
            No terminals open. Set a working directory above, then open a shell.
          </p>
        )}
      </div>

      <footer className="statusbar">
        <span data-testid="build-version">{build.info.version}</span>
        <span data-testid="build-commit">{build.info.commit}</span>
        <span data-testid="build-date">{build.info.date}</span>
        <span data-testid="bridge-status">
          {build.attached
            ? "connected to the Wails backend"
            : "detached — no Wails runtime"}
        </span>
      </footer>
    </main>
  );
}

/** Renders a rejected binding call as a sentence the status line can show. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string"
    ? error
    : "the terminal backend is not reachable";
}
