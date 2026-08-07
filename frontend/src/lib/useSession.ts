import { useCallback, useEffect, useRef, useState } from "react";
import { CLUSTER_DEFAULT, SIDEBAR_DEFAULT, TERMINAL_DEFAULT } from "./panes";
import type { Session, SessionStore } from "./session";
import {
  emptySession,
  nextSession,
  projectSession,
  restoredEditors,
  restoredTerminals,
  restoredTree,
  restoredWorkspace,
  sameSession,
  wailsSession,
} from "./session";
import { DEFAULT_FONT_SIZE } from "./theme";
import type { EditorTabs } from "./useEditorTabs";
import type { FileTreeController } from "./useFileTree";
import type { Projects } from "./useProjects";
import type { Terminals } from "./useTerminals";

/**
 * How long the workspace must sit still before it is written, in
 * milliseconds.
 *
 * There is no write on shutdown to fall back on: the Wails runtime ends the
 * process from the Go side, and a webview is not guaranteed to run a JavaScript
 * handler on the way out — a save wired to one would be a save that works in
 * development and quietly does not on a user's machine. So the debounce is the
 * whole mechanism, and it is short enough that the window between the last
 * change and a quit is smaller than the pause that precedes reaching for the
 * menu.
 */
export const SAVE_DELAY = 500;

/** The window-wide settings the session owns on the workbench's behalf. */
export interface WorkspaceSettings {
  readonly fontSize: number;
  readonly sidebar: number;
  readonly terminalHeight: number;
  readonly cluster: number;
}

/**
 * The live state a session is restored into and recorded from.
 *
 * The hooks arrive as one object rather than a parameter each for the reason
 * `App`'s `Backend` gives: the list grows with the workspace, and a defaulted
 * parameter apiece is a decision point apiece.
 */
export interface SessionWiring {
  readonly projects: Projects;
  readonly editors: EditorTabs;
  readonly terminals: Terminals;
  readonly tree: FileTreeController;
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  readonly store?: SessionStore;
}

export interface SessionController {
  readonly workspace: WorkspaceSettings;
  /** Records a change to the window-wide settings; the write follows. */
  readonly setWorkspace: (patch: Partial<WorkspaceSettings>) => void;
}

/** The window-wide settings before a session has been read. */
const defaults: WorkspaceSettings = {
  fontSize: DEFAULT_FONT_SIZE,
  sidebar: SIDEBAR_DEFAULT,
  terminalHeight: TERMINAL_DEFAULT,
  cluster: CLUSTER_DEFAULT,
};

/**
 * Resuming the workspace m6t was closed in, and recording the one it is in now
 * (#58).
 *
 * Restoring is per project and lazy: the window-wide settings come back at
 * launch, and a project's tabs, terminals and tree come back the first time
 * that project is the one on screen. Restoring every project's at launch would
 * spawn a shell and read a file for each tab of each registered repository
 * before the user had asked for any of it — the same reason the panes for an
 * inactive project stay mounted rather than being rebuilt, read in the other
 * direction.
 *
 * The tree follows that rule rather than being the exception it used to be
 * (#59). While the tree hook reset itself on every project switch, the saved
 * record was the only thing that remembered a tree's shape, so this had to put
 * it back on every activation; now the hook retains it, and this seeds it once.
 */
export function useSession({
  projects,
  editors,
  terminals,
  tree,
  store = wailsSession,
}: SessionWiring): SessionController {
  const [workspace, setSettings] = useState<WorkspaceSettings>(defaults);

  // The session that was on disk at launch, or null until the read answers.
  // Every effect below waits for it: acting sooner would mean restoring from a
  // session nobody has read, and recording over one.
  const [loaded, setLoaded] = useState<Session | null>(null);

  // Bumped when a project finishes hydrating, so that a restore which changed
  // nothing live — every saved file gone, say — still gets recorded. Without
  // it, that project's dead tab list would be rewritten unchanged on every
  // launch and retried forever.
  const [hydrations, setHydrations] = useState(0);

  // The session as it will next be written, and as it was last written. The
  // pair is what makes the write conditional: the workspace is recomputed on
  // every render, and almost every render leaves it identical.
  const current = useRef<Session>(emptySession());
  const written = useRef<Session>(emptySession());

  // The projects whose saved tabs have already been put back this session. It
  // is what stops the recording below from reading a project's empty strips as
  // fact in the moment before they are filled.
  const hydrated = useRef(new Set<string>());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The live hooks, for the effects that must not re-run when a render rebuilds
  // them: each controller is a fresh object every render, so an effect that
  // depended on one would restore the workspace on every keystroke. Declared
  // first so that in any commit this is assigned before the effects that read
  // it run.
  const wiring = useRef({ editors, terminals, tree });
  useEffect(() => {
    wiring.current = { editors, terminals, tree };
  });

  useEffect(() => {
    let reading = true;
    // An async body rather than .then: the generated binding throws
    // synchronously when there is no Wails runtime behind it, and a workbench
    // with no session to restore has to start at its defaults rather than take
    // the render down.
    void (async () => {
      let state = emptySession();
      try {
        state = await store.load();
      } catch {
        // No session, then. The defaults are what a first launch shows and are
        // the only sensible answer to a session that cannot be read.
      }
      if (!reading) {
        return;
      }
      current.current = state;
      written.current = state;
      const restored = restoredWorkspace(state);
      setSettings({
        fontSize: restored.fontSize,
        sidebar: restored.sidebar,
        terminalHeight: restored.terminalHeight,
        cluster: restored.cluster,
      });
      setLoaded(state);
    })();
    return () => {
      reading = false;
    };
  }, [store]);

  // True until the saved project has been selected — or found to be gone. It
  // is state rather than a ref because the hydration below waits on it: the
  // registry picks the first project the moment it answers, and hydrating that
  // one before the saved selection lands would open a repository's files and
  // start its shells on the way past it.
  const [restoring, setRestoring] = useState(true);

  const { list, select } = projects;
  useEffect(() => {
    if (loaded === null || !restoring || list.length === 0) {
      return;
    }
    setRestoring(false);
    const name = restoredWorkspace(loaded).activeProject;
    if (name !== null && list.some((project) => project.name === name)) {
      select(name);
    }
  }, [loaded, restoring, list, select]);

  // By name and path rather than by the project object: the registry replaces
  // its list on every reload, so a restore keyed on identity would put the tree
  // back — and re-list every open directory — each time a project was added,
  // renamed or reordered.
  const activeName = projects.activeName;
  const activePath = projects.active?.path ?? null;
  useEffect(() => {
    if (loaded === null || restoring || activeName === null || activePath === null) {
      return;
    }
    if (hydrated.current.has(activeName)) {
      return;
    }
    const record = projectSession(current.current, activeName);
    // Synchronously, ahead of the reads below: the tree's shape is state rather
    // than content, so there is nothing to wait for, and the rows it asks for
    // are on their way before the first file is opened.
    wiring.current.tree.restore(
      restoredTree(record, restoredWorkspace(current.current).changedOnly),
    );
    // Marked hydrated only once the files have been read, not when the restore
    // starts: a project recorded mid-restore would be recorded with the tabs
    // that had opened so far and lose the rest.
    void (async () => {
      await wiring.current.editors.restore(
        activeName,
        activePath,
        restoredEditors(record),
      );
      wiring.current.terminals.restore(
        activeName,
        restoredTerminals(record, activePath),
      );
      hydrated.current.add(activeName);
      setHydrations((count) => count + 1);
    })();
  }, [loaded, restoring, activeName, activePath]);

  // Recording. Every render recomputes the session; a write is scheduled only
  // when it would change the file.
  //
  // `tree.state` is the active project's from the first render of a switch, so
  // there is no window in which this records one project's tree against
  // another's name — the hook reads its entry during render rather than
  // replacing it in an effect afterwards (#59).
  useEffect(() => {
    if (loaded === null) {
      return;
    }
    const next = nextSession(
      current.current,
      {
        activeProject: projects.activeName,
        fontSize: workspace.fontSize,
        sidebar: workspace.sidebar,
        terminalHeight: workspace.terminalHeight,
        cluster: workspace.cluster,
        editors: editors.visible,
        activeEditor: editors.activeKey,
        terminals: terminals.visible,
        activeTerminal: terminals.activeKey,
        tree: tree.state,
      },
      hydrated.current,
      list.map((project) => project.name),
    );
    current.current = next;

    if (sameSession(next, written.current)) {
      return;
    }
    // A trailing edge, not a restarting debounce, and this is the difference
    // between a session that is written and one that never is. The workbench
    // re-renders continuously — the git status the watcher drives is enough on
    // its own — so a timer cancelled and re-armed on every render that found a
    // change would be pushed past its deadline forever, and the file would only
    // ever appear if the user stopped touching the app for longer than the app
    // stops re-rendering. Which it does not.
    //
    // So the first change arms the timer and nothing re-arms it: what lands is
    // `current.current` as it stands when it fires, which is the newest
    // workspace and not the one that happened to trip the timer.
    if (timer.current !== null) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      written.current = current.current;
      // An async body rather than a promise chain, and the reason is the one
      // every binding call in this codebase carries: the generated binding
      // throws synchronously when there is no Wails runtime behind it, and a
      // throw inside a timer has nowhere to land.
      //
      // The failure is then swallowed, deliberately and for the reason the file
      // tree's classification failures are: there is no user-facing action
      // behind "your pane layout could not be saved", and an app that
      // interrupted work to say so would be worse than one that quietly comes
      // back at its defaults. The binding reports the failure so that the
      // contract is honest; this is the caller deciding what to do with it.
      void (async () => {
        try {
          await store.save(current.current);
        } catch {
          // Not written. The next change tries again.
        }
      })();
    }, SAVE_DELAY);
  }, [
    loaded,
    hydrations,
    workspace,
    projects.activeName,
    list,
    editors.visible,
    editors.activeKey,
    terminals.visible,
    terminals.activeKey,
    tree.state,
    store,
  ]);

  // A pending write must not outlive the workbench. Its own effect rather than
  // a cleanup on the one above, which re-runs on every render: cancelling there
  // would reset the debounce on renders that changed nothing and, while the
  // user types, mean it never fired at all.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const setWorkspace = useCallback((patch: Partial<WorkspaceSettings>) => {
    setSettings((settings) => ({ ...settings, ...patch }));
  }, []);

  return { workspace, setWorkspace };
}
