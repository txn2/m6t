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

/** The last path segment — a file's own name. */
export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * File-type icon bucket (issue #38). One row's bucket, not one row's picture:
 * `components/Icon.tsx` owns which artwork each bucket maps to, so the tree,
 * the editor tab strip and the changes rows can all classify with this and
 * still render the same icon.
 */
export type IconKind =
  | "dir"
  | "kubernetes"
  | "helm"
  | "kustomize"
  | "actions"
  | "yaml"
  | "md"
  | "go"
  | "ts"
  | "tsx"
  | "js"
  | "json"
  | "shell"
  | "toml"
  | "docker"
  | "make"
  | "file";

/**
 * Buckets an exact (lowercased) file name settles on its own.
 *
 * A Map rather than an object literal, and not as a style preference: an
 * object literal inherits from `Object.prototype`, so a file named
 * `constructor` or `toString` would look up as "present" and hand back a
 * function where an `IconKind` was promised — which TypeScript cannot catch,
 * because the index signature says the value is an `IconKind`. `Map.get`
 * answers about the entries only.
 */
const BY_NAME: ReadonlyMap<string, IconKind> = new Map([
  ["dockerfile", "docker"],
  ["containerfile", "docker"],
  ["makefile", "make"],
  ["gnumakefile", "make"],
  ["chart.yaml", "helm"],
  ["chart.lock", "helm"],
  ["kustomization.yaml", "kustomize"],
  ["kustomization.yml", "kustomize"],
] satisfies [string, IconKind][]);

/** Buckets an extension settles on its own — every YAML suffix is absent
 * here deliberately, because YAML needs the path to disambiguate. */
const BY_EXTENSION: ReadonlyMap<string, IconKind> = new Map([
  [".md", "md"],
  [".markdown", "md"],
  [".go", "go"],
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "js"],
  [".json", "json"],
  [".sh", "shell"],
  [".bash", "shell"],
  [".zsh", "shell"],
  [".toml", "toml"],
  [".dockerfile", "docker"],
  [".mk", "make"],
] satisfies [string, IconKind][]);

/**
 * The icon bucket for a root-relative path.
 *
 * Path-based only, by design: the honest way to tell a Kubernetes manifest
 * from any other YAML is `apiVersion:` + `kind:` in its content, and there is
 * no way to read that for every entry in a directory the moment it is
 * expanded without turning one click into a few hundred file reads (#38). So
 * the rules below decide from the name and the directories above it, which
 * costs nothing and is wrong only in the cases `yamlKind` names.
 */
export function iconKind(path: string, isDir: boolean): IconKind {
  if (isDir) {
    return "dir";
  }
  const name = baseName(path).toLowerCase();
  const byName = BY_NAME.get(name);
  if (byName !== undefined) {
    return byName;
  }
  const extension = extensionOf(name);
  if (extension === ".yaml" || extension === ".yml") {
    return yamlKind(path, name);
  }
  return BY_EXTENSION.get(extension) ?? "file";
}

/** A file name's suffix including the dot, or "" when it has none. A leading
 * dot does not start an extension: `.gitignore` is a dotfile, not a file of
 * type "gitignore", while `.golangci.yml` is still YAML. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
}

/**
 * Which of the YAML dialects a `.yaml`/`.yml` file is.
 *
 * The last rule is the load-bearing one: in a manifest repository (DESIGN.md
 * §1) YAML that is not a chart, a kustomization or a CI workflow is a
 * Kubernetes manifest, so that is the default — except at the repository root
 * and for dotfiles, which is where repository configuration lives
 * (`codecov.yml`, `.golangci.yml`) and where a Kubernetes wheel would be a
 * lie. A `docker-compose.yaml` two directories down is the case this gets
 * wrong; it takes the generic YAML icon only once content sniffing exists.
 */
function yamlKind(path: string, name: string): IconKind {
  const dirs = parentPath(path).split("/").filter((segment) => segment !== "");
  if (dirs[0] === ".github" && dirs[1] === "workflows") {
    return "actions";
  }
  if (name.startsWith("values") || dirs.includes("templates")) {
    return "helm";
  }
  if (name.startsWith(".") || dirs.length === 0) {
    return "yaml";
  }
  return "kubernetes";
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
