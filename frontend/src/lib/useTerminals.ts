import { useCallback, useEffect, useRef, useState } from "react";
import type { RestoredTerminals } from "./session";
import type { SessionStatus, TerminalSession } from "./terminalSession";
import type { TerminalTab } from "./tabs";
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
  tabsForProject,
} from "./tabs";

/**
 * The terminal strip's state, owned above the project tabs.
 *
 * It is one flat list for every project rather than one list per project,
 * because the panes are rendered from this list and a pane that unmounted would
 * detach a running shell. Switching projects filters what the strip shows; it
 * does not change what is mounted (#4's rule, applied across a second axis).
 *
 * The selection is per project: coming back to a project should land on the tab
 * you left, not on whatever the last project's index happened to be.
 */
export interface Terminals {
  readonly tabs: TerminalTab[];
  readonly visible: TerminalTab[];
  readonly activeKey: string | null;
  readonly select: (key: string) => void;
  readonly create: (
    project: string,
    cwd: string,
    autorun: string | null,
  ) => void;
  /** Reopens the terminal tabs a session recorded for a project (#58). */
  readonly restore: (project: string, saved: RestoredTerminals) => void;
  readonly close: (key: string) => void;
  readonly closeProject: (project: string) => void;
  readonly rename: (key: string, title: string) => void;
  readonly restart: (key: string) => void;
  readonly onStatus: (key: string, status: SessionStatus) => void;
  readonly onAttach: (key: string, session: TerminalSession) => void;
  readonly onDetach: (key: string, session: TerminalSession) => void;
}

export function useTerminals(activeProject: string | null): Terminals {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeByProject, setActiveByProject] = useState<
    Record<string, string | null>
  >({});

  // Tab keys are never reused: a key that came back would let React match a new
  // tab's pane to a dead one's terminal.
  const keys = useRef(0);
  // The live sessions, by tab key. Closing a tab has to kill its PTY, and
  // unmounting deliberately does not (PROTOCOL.md §4).
  const sessions = useRef(new Map<string, TerminalSession>());

  // The current strip, for handlers that must stay stable across renders: a
  // pane holds its callbacks for the life of its session, so a handler that
  // changed identity would rebuild the terminal underneath a running program.
  const strip = useRef<TerminalTab[]>([]);
  useEffect(() => {
    strip.current = tabs;
  }, [tabs]);

  const activeKey = activeProject === null ? null : (activeByProject[activeProject] ?? null);

  const select = useCallback(
    (key: string) => {
      setActiveByProject((current) =>
        activeProject === null ? current : { ...current, [activeProject]: key },
      );
    },
    [activeProject],
  );

  const dropTab = useCallback((key: string) => {
    const closing = strip.current.find((tab) => tab.key === key);
    if (closing) {
      const siblings = tabsForProject(strip.current, closing.project);
      setActiveByProject((current) => ({
        ...current,
        [closing.project]: selectionAfterClose(
          siblings,
          key,
          current[closing.project] ?? null,
        ),
      }));
    }
    setTabs((current) => removeTab(current, key));
  }, []);

  const onStatus = useCallback(
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
    (project: string, cwd: string, autorun: string | null) => {
      keys.current += 1;
      const key = `tab-${String(keys.current)}`;
      setTabs((current) => [
        ...current,
        newTab(
          key,
          project,
          nextTitle(tabsForProject(current, project), autorun ?? "shell"),
          cwd,
          autorun,
        ),
      ]);
      setActiveByProject((current) => ({ ...current, [project]: key }));
    },
    [],
  );

  /**
   * Reopens the tabs a session recorded for a project (#58).
   *
   * A shell does not survive the app closing, so what comes back is the strip
   * and not the session: the same titles in the same order, each starting a
   * fresh shell in the directory it was started in before. Nothing autoruns —
   * the tab that was running `claude` comes back as the shell it was launched
   * as, because re-running a command the user did not ask for at startup is a
   * side effect, not a restore.
   *
   * The titles are taken as recorded rather than renumbered through
   * `nextTitle`: a tab the user named is the one thing about a terminal worth
   * keeping, and a strip that came back as "shell 1, shell 2" would have
   * quietly discarded it.
   */
  const restore = useCallback((project: string, saved: RestoredTerminals) => {
    if (saved.tabs.length === 0) {
      return;
    }
    const restored = saved.tabs.map((tab) => {
      keys.current += 1;
      return newTab(`tab-${String(keys.current)}`, project, tab.title, tab.cwd, null);
    });
    setTabs((current) => [...current, ...restored]);

    const focus = restored[saved.active] ?? restored[0];
    setActiveByProject((current) => ({ ...current, [project]: focus.key }));
  }, []);

  const close = useCallback(
    (key: string) => {
      // Ending the session is the point of closing a tab. Unmounting the pane
      // only detaches, so without this the shell would run on unreachable.
      sessions.current.get(key)?.close();
      dropTab(key);
    },
    [dropTab],
  );

  // Removing a project has to end its terminals. A pane stays mounted for the
  // life of the app, so tabs left behind by a project that is no longer in the
  // strip would be shells running with nothing able to reach or close them —
  // the exact leak `close` exists to prevent, one level up.
  //
  // This ends sessions; it does not touch the repository on disk, which is what
  // "remove" promises.
  const closeProject = useCallback((project: string) => {
    for (const tab of tabsForProject(strip.current, project)) {
      sessions.current.get(tab.key)?.close();
    }
    setTabs((current) => current.filter((tab) => tab.project !== project));
    setActiveByProject((current) => {
      const { [project]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const rename = useCallback((key: string, title: string) => {
    setTabs((current) => renameTab(current, key, title));
  }, []);

  const restart = useCallback((key: string) => {
    setTabs((current) => restartTab(current, key));
  }, []);

  const onAttach = useCallback((key: string, session: TerminalSession) => {
    sessions.current.set(key, session);
  }, []);

  // Only the session that is actually registered is removed: a restart mounts
  // the replacement pane and unmounts the old one, and a blind delete would
  // drop the new session on the old one's way out.
  const onDetach = useCallback((key: string, session: TerminalSession) => {
    if (sessions.current.get(key) === session) {
      sessions.current.delete(key);
    }
  }, []);

  return {
    tabs,
    visible: tabsForProject(tabs, activeProject),
    activeKey,
    select,
    create,
    restore,
    close,
    closeProject,
    rename,
    restart,
    onStatus,
    onAttach,
    onDetach,
  };
}
