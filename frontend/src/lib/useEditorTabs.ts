import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorMode, EditorTab } from "./editorTabs";
import {
  canSave,
  findTabKey,
  kindFromIcon,
  mapTab,
  newTab,
  removeTab,
  resolveKeepMine,
  resolveTakeDisk,
  selectionAfterClose,
  tabsForProject,
  withBlame,
  withEdit,
  withError,
  withExternalChange,
  withLoaded,
  withMode,
  withReloadFailed,
  withSaveFailed,
  withSaved,
  withSaving,
} from "./editorTabs";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Files } from "./files";
import { wailsFiles } from "./files";
import type { Endpoint } from "./stream";
import { ROOT, iconKind, parentPath } from "./tree";

/**
 * The editor strip's state, owned above the project tabs.
 *
 * It is one flat list for every project rather than one list per project, for
 * the reason `useTerminals` gives and one of its own: a tab holds unsaved
 * work, and a project switch that dropped it would lose the user's edits
 * silently. Switching projects filters what the strip shows; it does not
 * change what is mounted, so a CodeMirror view keeps its undo history and
 * cursor across the switch too.
 *
 * The selection is per project: coming back to a project lands on the file
 * you left, not on whatever the last project's index happened to be.
 */
export interface EditorTabs {
  readonly tabs: EditorTab[];
  readonly visible: EditorTab[];
  readonly activeKey: string | null;
  readonly select: (key: string) => void;
  readonly open: (project: string, root: string, path: string) => void;
  readonly edit: (key: string, content: string) => void;
  /** Resolves true when the file reached disk. A caller that is about to
   * close the tab has to wait for that answer: closing on a failed write
   * would take the only copy of the user's edits with it. */
  readonly save: (key: string) => Promise<boolean>;
  readonly close: (key: string) => void;
  readonly closeProject: (project: string) => void;
  readonly setMode: (key: string, mode: EditorMode) => void;
  /** Turns one tab's blame column on or off (#52). */
  readonly setBlame: (key: string, blame: boolean) => void;
  readonly keepMine: (key: string) => void;
  readonly takeDisk: (key: string) => void;
}

export function useEditorTabs(
  activeProject: string | null,
  endpoint: Endpoint | null,
  files: Files = wailsFiles,
  /** Injectable for tests; defaults to opening a real WebSocket. */
  socketFactory?: SocketFactory,
): EditorTabs {
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeByProject, setActiveByProject] = useState<
    Record<string, string | null>
  >({});

  // Tab keys are never reused: a key that came back would let React match a
  // new tab's editor to a closed one's view.
  const keys = useRef(0);

  // The current strip, for the /events handler and for `save`: both are
  // registered once and must see what is actually open when they run, not
  // what was open when they were created — the same reason `useFileTree`
  // keeps a `stateRef`.
  const strip = useRef<EditorTab[]>([]);
  useEffect(() => {
    strip.current = tabs;
  }, [tabs]);

  const activeKey =
    activeProject === null ? null : (activeByProject[activeProject] ?? null);

  const select = useCallback(
    (key: string) => {
      setActiveByProject((current) =>
        activeProject === null ? current : { ...current, [activeProject]: key },
      );
    },
    [activeProject],
  );

  const load = useCallback(
    (key: string, root: string, path: string) => {
      // An async body rather than .then: the generated binding throws
      // synchronously when there is no Wails runtime behind it, and a throw
      // before a promise chain is attached would escape uncaught — the same
      // shape `useFileTree.list` uses, for the same reason.
      void (async () => {
        try {
          const content = await files.read(root, path);
          setTabs((current) => mapTab(current, key, (tab) => withLoaded(tab, content)));
        } catch (error: unknown) {
          setTabs((current) => mapTab(current, key, (tab) => withError(tab, describe(error))));
        }
      })();
    },
    [files],
  );

  const open = useCallback(
    (project: string, root: string, path: string) => {
      const existing = findTabKey(strip.current, project, path);
      if (existing !== null) {
        setActiveByProject((current) => ({ ...current, [project]: existing }));
        return;
      }

      keys.current += 1;
      const key = `editor-${String(keys.current)}`;
      const kind = kindFromIcon(iconKind(path, false));
      setTabs((current) => [...current, newTab(key, project, root, path, kind)]);
      setActiveByProject((current) => ({ ...current, [project]: key }));
      load(key, root, path);
    },
    [load],
  );

  const edit = useCallback((key: string, content: string) => {
    setTabs((current) => mapTab(current, key, (tab) => withEdit(tab, content)));
  }, []);

  const save = useCallback(
    async (key: string): Promise<boolean> => {
      const tab = strip.current.find((t) => t.key === key);
      if (!tab || !canSave(tab)) {
        return false;
      }
      // The buffer as it is right now, not as it will be when the write
      // lands: the user keeps typing through an async save, and the baseline
      // has to advance to what was actually written, not past it.
      const written = tab.content;

      setTabs((current) => mapTab(current, key, withSaving));
      try {
        await files.write(tab.root, tab.path, written, tab.crlf);
        setTabs((current) => mapTab(current, key, (t) => withSaved(t, written)));
        return true;
      } catch (error: unknown) {
        setTabs((current) => mapTab(current, key, (t) => withSaveFailed(t, describe(error))));
        return false;
      }
    },
    [files],
  );

  // Closing is unconditional here. The unsaved-changes prompt belongs to the
  // strip UI, which is where the user can still see what they are about to
  // discard; by the time this runs the decision has been made — the same
  // division the tree's delete confirmation and `DeleteEntry` already use.
  const close = useCallback((key: string) => {
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

  // Removing a project takes its tabs with it: they would otherwise stay in
  // the flat list for the life of the app with no strip left to reach them.
  const closeProject = useCallback((project: string) => {
    setTabs((current) => current.filter((tab) => tab.project !== project));
    setActiveByProject((current) => {
      const { [project]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const setMode = useCallback((key: string, mode: EditorMode) => {
    setTabs((current) => mapTab(current, key, (tab) => withMode(tab, mode)));
  }, []);

  const setBlame = useCallback((key: string, blame: boolean) => {
    setTabs((current) => mapTab(current, key, (tab) => withBlame(tab, blame)));
  }, []);

  const keepMine = useCallback((key: string) => {
    setTabs((current) => mapTab(current, key, resolveKeepMine));
  }, []);

  const takeDisk = useCallback((key: string) => {
    setTabs((current) => mapTab(current, key, resolveTakeDisk));
  }, []);

  // Re-reads one file a change event named and reconciles the tab against it.
  // A failed re-read keeps the buffer: the file may have been deleted out
  // from under an unsaved edit, and that buffer is then the only copy of the
  // user's work left — losing it to a tidy error state would be the worst
  // possible response.
  const reconcile = useCallback(
    (tab: EditorTab) => {
      void (async () => {
        try {
          const content = await files.read(tab.root, tab.path);
          setTabs((current) =>
            mapTab(current, tab.key, (t) => withExternalChange(t, content)),
          );
        } catch (error: unknown) {
          setTabs((current) =>
            mapTab(current, tab.key, (t) => withReloadFailed(t, describe(error))),
          );
        }
      })();
    },
    [files],
  );

  // /events: a coalesced batch names directories that may have changed
  // (PROTOCOL.md §5). One socket serves every project's tabs — each event
  // carries the root it happened under, and every tab knows its own — rather
  // than one socket per project, which would mean tearing down and reopening
  // on each project switch for no gain.
  useEffect(() => {
    if (endpoint === null) {
      return;
    }
    const socket = openEventsSocket(
      endpoint,
      {
        onTree: (changedRoot, dirs) => {
          for (const tab of tabsInChangedDirs(strip.current, changedRoot, dirs)) {
            reconcile(tab);
          }
        },
      },
      socketFactory,
    );
    return () => {
      socket.close();
    };
  }, [endpoint, socketFactory, reconcile]);

  return {
    tabs,
    visible: tabsForProject(tabs, activeProject),
    activeKey,
    select,
    open,
    edit,
    save,
    close,
    closeProject,
    setMode,
    setBlame,
    keepMine,
    takeDisk,
  };
}

/**
 * The open tabs a change event actually concerns: those under the root it
 * happened in, whose own directory is one the event named.
 *
 * The wire form uses "." for a root-level directory and this package uses ""
 * (`tree.ts`'s ROOT), the same translation `affectedTrackedDirs` performs for
 * the tree.
 */
export function tabsInChangedDirs(
  tabs: readonly EditorTab[],
  root: string,
  wireDirs: readonly string[],
): EditorTab[] {
  const changed = new Set(wireDirs.map((dir) => (dir === "." ? ROOT : dir)));
  return tabs.filter(
    (tab) => tab.root === root && changed.has(parentPath(tab.path)),
  );
}

/** Renders a rejected binding call as a sentence a tab can show. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the editor backend is not reachable";
}
