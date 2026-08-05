import { useCallback, useEffect, useRef, useState } from "react";
import type { Directory } from "./directory";
import { wailsDirectory } from "./directory";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Endpoint } from "./stream";
import type { TreeState } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  collapse,
  expand,
  initialTree,
  joinPath,
  parentPath,
  select,
  toggleHidden,
  withError,
  withListing,
  withLoading,
} from "./tree";

/**
 * The file tree's state and operations for whichever project is active
 * (DESIGN.md §5).
 *
 * Unlike the terminal strip (`useTerminals`), this is scoped to one project
 * at a time rather than flattened across all of them: only the active
 * project's tree is ever visible, so there is nothing to keep mounted for an
 * inactive one, and a project switch is a clean reset rather than a filter
 * over shared state.
 */
export interface FileTreeController {
  readonly state: TreeState;
  readonly expand: (dir: string) => void;
  readonly collapse: (dir: string) => void;
  readonly select: (path: string | null) => void;
  readonly toggleHidden: () => void;
  /** Resolves to an error message on failure, or null on success. */
  readonly createEntry: (dir: string, name: string, isDir: boolean) => Promise<string | null>;
  readonly renameEntry: (path: string, newName: string) => Promise<string | null>;
  readonly deleteEntry: (path: string) => Promise<string | null>;
}

export function useFileTree(
  root: string | null,
  endpoint: Endpoint | null,
  directory: Directory = wailsDirectory,
  /** Injectable for tests; defaults to opening a real WebSocket. */
  socketFactory?: SocketFactory,
): FileTreeController {
  const [state, setState] = useState<TreeState>(initialTree);

  // The current state, for the /events handler: that callback is registered
  // once per (root, endpoint) pair and must see what is actually loaded at
  // the moment an event arrives, not what was loaded when it was registered.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // A new project has nothing loaded yet, and the previous project's entries
  // must not linger on screen while the fresh listing arrives.
  useEffect(() => {
    setState(initialTree());
  }, [root]);

  const list = useCallback(
    (dir: string) => {
      if (root === null) {
        return;
      }
      setState((current) => withLoading(current, dir));
      // An async body rather than .then/.catch directly on directory.list's
      // return value: the generated binding throws synchronously when there
      // is no Wails runtime behind it (App.tsx's own endpoint fetch has the
      // same shape, for the same reason), and a throw before a promise chain
      // is attached would otherwise escape this effect uncaught.
      void (async () => {
        try {
          const entries = await directory.list(root, dir);
          setState((current) => withListing(current, dir, entries));
        } catch (error: unknown) {
          setState((current) => withError(current, dir, describeError(error)));
        }
      })();
    },
    [root, directory],
  );

  // Root's own listing is not behind an expand click — the top level of any
  // file tree is visible as soon as there is a project to show.
  useEffect(() => {
    if (root !== null) {
      list(ROOT);
    }
  }, [root, list]);

  const expandDir = useCallback(
    (dir: string) => {
      setState((current) => expand(current, dir));
      list(dir);
    },
    [list],
  );

  const collapseDir = useCallback((dir: string) => {
    setState((current) => collapse(current, dir));
  }, []);

  // /events: a coalesced batch names directories that may have changed
  // (PROTOCOL.md §5). Only directories this tree has already loaded are
  // worth re-fetching — see affectedTrackedDirs for why.
  useEffect(() => {
    if (root === null || endpoint === null) {
      return;
    }
    const socket = openEventsSocket(
      endpoint,
      {
        onTree: (changedRoot, dirs) => {
          if (changedRoot !== root) {
            return;
          }
          for (const dir of affectedTrackedDirs(stateRef.current, dirs)) {
            list(dir);
          }
        },
      },
      socketFactory,
    );
    return () => {
      socket.close();
    };
  }, [root, endpoint, list, socketFactory]);

  const createEntry = useCallback(
    async (dir: string, name: string, isDir: boolean): Promise<string | null> => {
      if (root === null) {
        return "no project is open";
      }
      try {
        await directory.create(root, joinPath(dir, name), isDir);
        list(dir);
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, directory, list],
  );

  const renameEntry = useCallback(
    async (path: string, newName: string): Promise<string | null> => {
      if (root === null) {
        return "no project is open";
      }
      const dir = parentPath(path);
      try {
        await directory.rename(root, path, joinPath(dir, newName));
        list(dir);
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, directory, list],
  );

  const deleteEntry = useCallback(
    async (path: string): Promise<string | null> => {
      if (root === null) {
        return "no project is open";
      }
      try {
        await directory.remove(root, path);
        list(parentPath(path));
        setState((current) => (current.selected === path ? select(current, null) : current));
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, directory, list],
  );

  return {
    state,
    expand: expandDir,
    collapse: collapseDir,
    select: useCallback((path: string | null) => {
      setState((current) => select(current, path));
    }, []),
    toggleHidden: useCallback(() => {
      setState((current) => toggleHidden(current));
    }, []),
    createEntry,
    renameEntry,
    deleteEntry,
  };
}

/** Renders a rejected binding call as a sentence the tree can show. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the file tree backend is not reachable";
}
