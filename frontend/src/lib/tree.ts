import type { watch } from "../../wailsjs/go/models";

/**
 * The file tree's state (DESIGN.md §5): a lazily-loaded map of directory
 * listings plus which ones are expanded, keyed by root-relative path.
 *
 * Everything here is pure — the hook (useFileTree) owns the backend calls,
 * this owns the shape of what they produced — which is what makes the tree's
 * behaviour testable without a Wails runtime, the same split useTerminals and
 * lib/tabs.ts already use for the terminal strip.
 */

/** The project's own root, in this package's convention. */
export const ROOT = "";

/** One entry the backend returned, aliased so a Go struct change fails
 * type-checking here rather than disagreeing silently. */
export type Entry = watch.Entry;

/** One row the tree can render: a listed entry plus its full path. */
export interface TreeEntry {
  readonly name: string;
  readonly isDir: boolean;
  /** Root-relative, slash-separated — this package's path convention. */
  readonly path: string;
}

/** Where a directory's listing stands. */
export type DirStatus = "loading" | "loaded" | "error";

/** One directory's listing, as last fetched. */
export interface DirState {
  readonly status: DirStatus;
  /** The last successfully fetched children, kept across a reload so the
   * tree does not blank out while a refresh is in flight. */
  readonly children: readonly TreeEntry[];
  readonly error: string | null;
}

/** The tree's whole state. */
export interface TreeState {
  readonly dirs: Readonly<Record<string, DirState>>;
  readonly expanded: ReadonlySet<string>;
  readonly selected: string | null;
  readonly showHidden: boolean;
}

/** A tree with nothing loaded yet, root pre-expanded — the top level of any
 * file tree is always visible, not behind a click. */
export function initialTree(): TreeState {
  return { dirs: {}, expanded: new Set([ROOT]), selected: null, showHidden: false };
}

/** Joins a child name onto a directory path in this package's convention. */
export function joinPath(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`;
}

/** The directory a path lives in — ROOT for a top-level entry. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? ROOT : path.slice(0, index);
}

/** File-type icon bucket, by extension — DESIGN.md §5's yaml/md/other. */
export type IconKind = "dir" | "yaml" | "md" | "file";

export function iconKind(entry: Pick<Entry, "name" | "isDir">): IconKind {
  if (entry.isDir) {
    return "dir";
  }
  const lower = entry.name.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "md";
  }
  return "file";
}

/** Whether an entry is a dotfile — hidden unless the tree's toggle is on. */
export function isHidden(entry: Pick<Entry, "name">): boolean {
  return entry.name.startsWith(".");
}

/** The children of a loaded directory the tree should actually render. */
export function visibleChildren(
  state: TreeState,
  dir: string,
): readonly TreeEntry[] {
  const listed = state.dirs[dir]?.children ?? [];
  return state.showHidden ? listed : listed.filter((e) => !isHidden(e));
}

/** Marks a directory as being (re)fetched, keeping its last-known children
 * on screen rather than clearing them out from under the user. */
export function withLoading(state: TreeState, dir: string): TreeState {
  const existing = state.dirs[dir];
  return withDir(state, dir, { status: "loading", children: existing?.children ?? [], error: null });
}

/** Records a directory's freshly fetched listing. */
export function withListing(state: TreeState, dir: string, entries: readonly Entry[]): TreeState {
  const children = entries.map((e) => ({ name: e.name, isDir: e.isDir, path: joinPath(dir, e.name) }));
  return withDir(state, dir, { status: "loaded", children, error: null });
}

/** Records that a directory's listing failed, keeping its last-known
 * children so a transient failure does not erase what was there. */
export function withError(state: TreeState, dir: string, message: string): TreeState {
  const existing = state.dirs[dir];
  return withDir(state, dir, { status: "error", children: existing?.children ?? [], error: message });
}

function withDir(state: TreeState, dir: string, next: DirState): TreeState {
  return { ...state, dirs: { ...state.dirs, [dir]: next } };
}

/** Expands a directory, so its children render once loaded. */
export function expand(state: TreeState, dir: string): TreeState {
  if (state.expanded.has(dir)) {
    return state;
  }
  return { ...state, expanded: new Set(state.expanded).add(dir) };
}

/** Collapses a directory. Its listing is kept, not discarded, so
 * re-expanding shows the last-known contents instantly while a fresh
 * listing loads behind it. */
export function collapse(state: TreeState, dir: string): TreeState {
  if (!state.expanded.has(dir)) {
    return state;
  }
  const expanded = new Set(state.expanded);
  expanded.delete(dir);
  return { ...state, expanded };
}

export function select(state: TreeState, path: string | null): TreeState {
  return { ...state, selected: path };
}

export function toggleHidden(state: TreeState): TreeState {
  return { ...state, showHidden: !state.showHidden };
}

/** One row in the flattened, rendered tree: a visible entry plus its depth. */
export interface TreeRow extends TreeEntry {
  readonly depth: number;
}

/**
 * The tree flattened into the rows it actually renders, in display order —
 * every visible entry under ROOT, and every visible entry under each
 * expanded directory, depth-first.
 *
 * A flat list rather than a nested one is what makes keyboard navigation
 * (FileTree.tsx) a matter of moving an index: the up/down/expand/collapse
 * rules the issue asks for do not need to know about React's tree of
 * components to be correct, only about this array.
 */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of visibleChildren(state, dir)) {
      rows.push({ ...entry, depth });
      if (entry.isDir && state.expanded.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk(ROOT, 0);
  return rows;
}

/**
 * The subset of a "tree changed" event's directories (PROTOCOL.md §5,
 * `.`-for-root) that this tree has actually loaded, translated to this
 * package's `""`-for-root convention.
 *
 * A directory the tree never fetched has nothing on screen to go stale, so
 * there is nothing useful to do with a change reported for it — this is what
 * keeps a five-thousand-file repository from re-listing directories nobody
 * has ever opened just because something changed inside one of them.
 */
export function affectedTrackedDirs(state: TreeState, wireDirs: readonly string[]): string[] {
  const affected: string[] = [];
  for (const wireDir of wireDirs) {
    const dir = wireDir === "." ? ROOT : wireDir;
    if (dir in state.dirs) {
      affected.push(dir);
    }
  }
  return affected;
}
