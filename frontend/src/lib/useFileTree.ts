import { useCallback, useEffect, useRef, useState } from "react";
import type { Directory } from "./directory";
import { wailsDirectory } from "./directory";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Endpoint } from "./stream";
import type { Entry, TreeState } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  ancestry,
  collapse,
  expand,
  initialTree,
  joinPath,
  parentPath,
  reveal,
  select,
  toggleChangedOnly,
  toggleHidden,
  withError,
  withListing,
  withLoading,
  withManifests,
  yamlPaths,
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
  /** Opens a directory and everything above it, and selects it — what a
   * breadcrumb segment click does (#43). */
  readonly reveal: (dir: string) => void;
  readonly toggleHidden: () => void;
  readonly toggleChangedOnly: () => void;
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

  // The project a late response has to be checked against — see `classify`.
  const rootRef = useRef(root);
  useEffect(() => {
    rootRef.current = root;
  }, [root]);

  // A new project has nothing loaded yet, and the previous project's entries
  // must not linger on screen while the fresh listing arrives. Changed-only
  // mode is the one thing carried across: it is a property of how the user is
  // working rather than of the project they are looking at, the same as the
  // sidebar's width, and it behaved that way before it moved into this state.
  useEffect(() => {
    setState((current) => ({ ...initialTree(), changedOnly: current.changedOnly }));
  }, [root]);

  /**
   * Reads the head of every plain-YAML file in a fresh listing and records
   * which of them are Kubernetes manifests (#38).
   *
   * Deliberately after the listing has already been shown rather than
   * before: the rows appear with the icon their names earn, and the ones
   * whose content says "manifest" upgrade a moment later. A tree that waited
   * for this would be a tree that blocked on file reads to draw a directory.
   *
   * A failure is swallowed on purpose. There is no user-facing action behind
   * "could not classify" — every row already has an icon — and the next
   * listing of this directory tries again.
   */
  const classify = useCallback(
    async (forRoot: string, dir: string, entries: readonly Entry[]) => {
      for (const paths of batched(yamlPaths(dir, entries))) {
        try {
          const heads = await directory.prefixes(forRoot, paths);
          // A project switch while this was in flight would otherwise write
          // one project's verdicts into another's tree, where the paths are
          // relative and can collide. The listing state is reset on switch;
          // these would not be.
          if (rootRef.current !== forRoot) {
            return;
          }
          setState((current) => withManifests(current, heads, paths));
        } catch {
          // Left unclassified; the rows keep their name-derived icon.
        }
      }
    },
    [directory],
  );

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
          await classify(root, dir, entries);
        } catch (error: unknown) {
          setState((current) => withError(current, dir, describeError(error)));
        }
      })();
    },
    [root, directory, classify],
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

  /**
   * Opens a directory and every directory above it (#43).
   *
   * Only the ancestors this tree has never listed are fetched, unlike
   * `expandDir`, which refreshes whatever it opens. A reveal walks a whole
   * chain rather than one directory, and the chain leading to the file the
   * user is looking at is very nearly always already loaded — re-listing all
   * of it would mean a burst of round trips on every breadcrumb click to
   * re-fetch what the tree already has.
   */
  const revealDir = useCallback(
    (dir: string) => {
      setState((current) => reveal(current, dir));
      for (const path of ancestry(dir)) {
        if (!(path in stateRef.current.dirs)) {
          list(path);
        }
      }
    },
    [list],
  );

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
    reveal: revealDir,
    toggleHidden: useCallback(() => {
      setState((current) => toggleHidden(current));
    }, []),
    toggleChangedOnly: useCallback(() => {
      setState((current) => toggleChangedOnly(current));
    }, []),
    createEntry,
    renameEntry,
    deleteEntry,
  };
}

/**
 * The paths to ask about, split into batches the backend will serve.
 *
 * internal/watch.ReadPrefixes caps a batch so this binding cannot be turned
 * into a repository walk. A flat directory of two thousand manifests is a
 * real shape, though, and it must classify rather than fail the cap and
 * silently keep the plain YAML icon forever — so the cap is respected here
 * instead of being hit.
 */
function batched(paths: readonly string[]): string[][] {
  const size = 256;
  const batches: string[][] = [];
  for (let at = 0; at < paths.length; at += size) {
    batches.push(paths.slice(at, at + size));
  }
  return batches;
}

/** Renders a rejected binding call as a sentence the tree can show. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the file tree backend is not reachable";
}
