import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Directory } from "./directory";
import { wailsDirectory } from "./directory";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Endpoint } from "./stream";
import type { ProjectTrees } from "./projectTrees";
import { treeFor, withTree, withoutTree } from "./projectTrees";
import type { Entry, RestoredTree, TreeState } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  ancestry,
  collapse,
  expand,
  joinPath,
  openDirs,
  parentPath,
  locate,
  restoreTree,
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
 * The file tree's state and operations, one tree per project (DESIGN.md §5).
 *
 * Only the active project's tree is on screen, so — unlike the terminal strip
 * and the editor strip — nothing has to stay mounted for an inactive project.
 * What it keeps instead is the state behind those rows: which directories were
 * open, what was selected, whether hidden files were showing, and every
 * listing already fetched. A switch changes which entry is read, not what is
 * stored (#59).
 *
 * That is a choice rather than a saving. A pane holding a running shell or an
 * unsaved buffer *cannot* be rebuilt, which is what forced the other two;
 * a tree can be, merely at the cost of a burst of round trips and a loading
 * state where the rows used to be, on every switch, forever. The listings
 * themselves are names and `isDir` flags — a few hundred kilobytes across
 * every project a user has open, once.
 *
 * Retained rows come with an obligation: the `/events` handler below ignores
 * events for the project that is not on screen, so an inactive project's
 * listings go stale by construction. Returning to one re-lists everything it
 * has open, behind the rows it is already showing.
 */
export interface FileTreeController {
  readonly state: TreeState;
  readonly expand: (dir: string) => void;
  readonly collapse: (dir: string) => void;
  readonly select: (path: string | null) => void;
  /** Opens a directory and everything above it, and selects it — what a
   * breadcrumb segment click does (#43). */
  readonly reveal: (dir: string) => void;
  /** Brings one file on screen and selects it (#56): the directories above it
   * expand, the filters that would have hidden it clear, and the row scrolls
   * into view once its listing lands. */
  readonly locate: (path: string) => void;
  /** Puts a saved tree shape back and re-lists what it had open (#58). */
  readonly restore: (saved: RestoredTree) => void;
  /**
   * Drops a project's retained tree, named by its root path — which is what
   * keys them, so this takes a path where the editor and terminal strips take
   * a project name.
   */
  readonly closeProject: (root: string) => void;
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
  const [trees, setTrees] = useState<ProjectTrees>({});
  const state = useMemo(() => treeFor(trees, root), [trees, root]);

  // The backend seam, behind a ref so nothing below changes identity with it —
  // the guard `useGitStatus` states in full and for the same reason. A caller
  // passing an inline object, which is the ordinary way to write a test and an
  // easy slip in a component, would otherwise rebuild `list` every render,
  // re-run the listing effect, fetch, render, and rebuild it again: a loop that
  // ends in an out-of-memory crash rather than a visible bug.
  const seam = useRef(directory);
  useEffect(() => {
    seam.current = directory;
  }, [directory]);

  // The projects this hook is still holding a tree for: every one that has been
  // on screen, less the ones removed from the registry since. A ref rather than
  // state because nothing renders from it — it exists so that a listing still
  // in flight when a project is removed cannot write the entry back a moment
  // after `closeProject` dropped it, leaving the map holding a project the
  // registry no longer has. `useGitStatus` keeps the same set for the same
  // reason.
  const held = useRef(new Set<string>());

  /**
   * Applies a change to one named project's tree.
   *
   * The project is a parameter rather than read off `root`, and that is what
   * makes every asynchronous path here safe across a switch: a listing or a
   * batch of manifest verdicts that lands after the user has moved on is
   * written into the tree it was fetched for, which is still on the map and
   * still worth updating. Before the map existed there was nowhere to put such
   * an answer and the only option was to discard it.
   */
  const updateTree = useCallback(
    (project: string, change: (current: TreeState) => TreeState) => {
      if (!held.current.has(project)) {
        return;
      }
      setTrees((current) => withTree(current, project, change(treeFor(current, project))));
    },
    [],
  );

  // The active project's state, for the /events handler and for the refresh
  // below: both are registered once per project and must see what is actually
  // loaded at the moment they run, not what was loaded when they were
  // registered. Declared before the effects that read it so that in any commit
  // it is assigned first.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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
          const heads = await seam.current.prefixes(forRoot, paths);
          updateTree(forRoot, (current) => withManifests(current, heads, paths));
        } catch {
          // Left unclassified; the rows keep their name-derived icon.
        }
      }
    },
    [updateTree],
  );

  const list = useCallback(
    (dir: string) => {
      if (root === null) {
        return;
      }
      const forRoot = root;
      updateTree(forRoot, (current) => withLoading(current, dir));
      // An async body rather than .then/.catch directly on directory.list's
      // return value: the generated binding throws synchronously when there
      // is no Wails runtime behind it (App.tsx's own endpoint fetch has the
      // same shape, for the same reason), and a throw before a promise chain
      // is attached would otherwise escape this effect uncaught.
      void (async () => {
        try {
          const entries = await seam.current.list(forRoot, dir);
          updateTree(forRoot, (current) => withListing(current, dir, entries));
          await classify(forRoot, dir, entries);
        } catch (error: unknown) {
          updateTree(forRoot, (current) => withError(current, dir, describeError(error)));
        }
      })();
    },
    [root, classify, updateTree],
  );

  /**
   * Everything the project now on screen has open: root, which is never behind
   * an expand click, and — for a project being returned to — every directory
   * whose rows are already showing.
   *
   * The refresh is not optional. The `/events` subscription below only follows
   * the active project, so a retained listing is exactly as old as the time
   * spent in other projects; without this, a directory deleted while the user
   * was elsewhere would still have a row on their return. `withLoading` keeps
   * the last-known children, so the rows on screen are the retained ones until
   * the fresh listing replaces them in place.
   *
   * It reads the state through the ref rather than depending on it: an effect
   * that re-ran when a listing landed would ask for that listing again.
   */
  useEffect(() => {
    if (root === null) {
      return;
    }
    held.current.add(root);
    for (const dir of openDirs(stateRef.current)) {
      list(dir);
    }
  }, [root, list]);

  /** Applies a change to the tree the user is looking at — every operation
   * below is one the user performed on it, so none of them name a project. */
  const updateActive = useCallback(
    (change: (current: TreeState) => TreeState) => {
      if (root !== null) {
        updateTree(root, change);
      }
    },
    [root, updateTree],
  );

  const expandDir = useCallback(
    (dir: string) => {
      updateActive((current) => expand(current, dir));
      list(dir);
    },
    [list, updateActive],
  );

  const collapseDir = useCallback(
    (dir: string) => {
      updateActive((current) => collapse(current, dir));
    },
    [updateActive],
  );

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
      updateActive((current) => reveal(current, dir));
      for (const path of ancestry(dir)) {
        if (!(path in stateRef.current.dirs)) {
          list(path);
        }
      }
    },
    [list, updateActive],
  );

  const locateFile = useCallback(
    (path: string) => {
      updateActive((current) => locate(current, path));
      // The chain above the file, not the file: listing a file is a backend
      // error, and the row appears as soon as its own directory is listed.
      for (const dir of ancestry(parentPath(path))) {
        if (!(dir in stateRef.current.dirs)) {
          list(dir);
        }
      }
    },
    [list, updateActive],
  );

  /**
   * Restores a saved tree shape (#58).
   *
   * It runs once per project, on the first activation — the session seeds a
   * tree that has nothing in it yet, and from then on the retained state is
   * what remembers. So every saved directory is listed: on a first activation
   * none of them have been, and the ref that would say otherwise describes the
   * project being switched away from until this commit's effects run.
   *
   * The root is skipped because the effect above already lists it for every
   * project, and asking twice would mean two round trips for one directory.
   */
  const restoreTreeState = useCallback(
    (saved: RestoredTree) => {
      updateActive((current) => restoreTree(current, saved));
      for (const dir of saved.expanded) {
        if (dir !== ROOT) {
          list(dir);
        }
      }
    },
    [list, updateActive],
  );

  const closeProject = useCallback((closing: string) => {
    held.current.delete(closing);
    setTrees((current) => withoutTree(current, closing));
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
        await seam.current.create(root, joinPath(dir, name), isDir);
        list(dir);
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, list],
  );

  const renameEntry = useCallback(
    async (path: string, newName: string): Promise<string | null> => {
      if (root === null) {
        return "no project is open";
      }
      const dir = parentPath(path);
      try {
        await seam.current.rename(root, path, joinPath(dir, newName));
        list(dir);
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, list],
  );

  const deleteEntry = useCallback(
    async (path: string): Promise<string | null> => {
      if (root === null) {
        return "no project is open";
      }
      try {
        await seam.current.remove(root, path);
        list(parentPath(path));
        updateActive((current) => (current.selected === path ? select(current, null) : current));
        return null;
      } catch (error: unknown) {
        return describeError(error);
      }
    },
    [root, list, updateActive],
  );

  return {
    state,
    expand: expandDir,
    collapse: collapseDir,
    select: useCallback(
      (path: string | null) => {
        updateActive((current) => select(current, path));
      },
      [updateActive],
    ),
    reveal: revealDir,
    locate: locateFile,
    restore: restoreTreeState,
    closeProject,
    toggleHidden: useCallback(() => {
      updateActive(toggleHidden);
    }, [updateActive]),
    toggleChangedOnly: useCallback(() => {
      updateActive(toggleChangedOnly);
    }, [updateActive]),
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
