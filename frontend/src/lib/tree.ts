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
  /**
   * Whether the tree is filtered down to the changed files (#40).
   *
   * It sits here beside `showHidden` rather than in the component, where it
   * started, because the two are the same kind of thing — a filter over which
   * rows exist — and `reveal` has to be able to clear both of them to keep its
   * promise. A filter the reveal cannot see is a filter that silently swallows
   * the reveal.
   */
  readonly changedOnly: boolean;
  /**
   * Every plain-YAML path whose content has been read, mapped to whether it
   * turned out to be a Kubernetes manifest (#38).
   *
   * A map rather than a set of the positives, because the two answers it
   * distinguishes are "read, and it is not a manifest" and "not read yet",
   * and only the second is worth another round trip. Absence is what makes
   * the classification happen once per file for the life of the tree.
   */
  readonly manifests: ReadonlyMap<string, boolean>;
}

/** A tree with nothing loaded yet, root pre-expanded — the top level of any
 * file tree is always visible, not behind a click. */
export function initialTree(): TreeState {
  return {
    dirs: {},
    expanded: new Set([ROOT]),
    selected: null,
    showHidden: false,
    changedOnly: false,
    manifests: new Map(),
  };
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
 * Every prefix of a root-relative path, outermost first, the path itself
 * last: `manifests/prod/ingress.yaml` becomes `["manifests",
 * "manifests/prod", "manifests/prod/ingress.yaml"]`.
 *
 * One function for the two things that need the same chain — the breadcrumb
 * above the editor draws it (#43) and `reveal` expands it — so a breadcrumb
 * segment and the directory a click on it opens cannot come from two
 * different notions of what the segments are.
 *
 * ROOT yields nothing: the project root is not a segment, it is what these
 * paths are relative to. Empty segments are dropped for the same reason, so a
 * path that picked up a doubled separator does not produce a nameless crumb
 * pointing at its own parent.
 */
export function ancestry(path: string): string[] {
  const chain: string[] = [];
  for (const segment of path.split("/")) {
    if (segment !== "") {
      chain.push(chain.length === 0 ? segment : `${chain[chain.length - 1]}/${segment}`);
    }
  }
  return chain;
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
 * The icon bucket a root-relative path has from its name alone.
 *
 * This never returns "kubernetes". A name cannot tell a manifest from any
 * other YAML — only `apiVersion:` and `kind:` in the content can, which is
 * what `looksLikeManifest` reads and `resolveIconKind` applies. Everything
 * here is synchronous and free, so every YAML file has an icon the instant
 * its row appears; the ones that turn out to be manifests upgrade when their
 * heads arrive.
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
 * Which of the YAML dialects a `.yaml`/`.yml` file is, from its path.
 *
 * Only the two a path genuinely settles: a workflow lives at one known
 * location, and a chart's values and templates are named by Helm itself.
 * Everything else is plain YAML until its content says otherwise — a
 * `docker-compose.yaml` and a Deployment are indistinguishable by name, and
 * guessing from the directory above them dresses one of the two up as
 * something it is not.
 */
function yamlKind(path: string, name: string): IconKind {
  const dirs = parentPath(path).split("/").filter((segment) => segment !== "");
  if (dirs[0] === ".github" && dirs[1] === "workflows") {
    return "actions";
  }
  if (name.startsWith("values") || dirs.includes("templates")) {
    return "helm";
  }
  return "yaml";
}

/**
 * Whether a file's head says it is a Kubernetes manifest.
 *
 * The rule the API server itself applies: every object has an `apiVersion`
 * and a `kind`, both at the top level. Both are required — a chart's
 * `values.yaml` can carry a `kind:` of its own, and a bare `apiVersion:`
 * with nothing under it is not an object.
 *
 * A column-0 match is what makes "top level" checkable without a YAML
 * parser: nested mappings are indented, and a `kind:` under `spec:` or
 * inside a list item never starts a line. Multi-document files match on any
 * document, so a file opening with a comment block or a `---` still
 * classifies.
 *
 * `head` is a prefix (watch.ReadPrefixes), so this can only be wrong in one
 * direction: a manifest whose apiVersion and kind both sit past the cut
 * keeps the plain YAML icon. That is the safe direction — the icon
 * understates rather than lies.
 */
export function looksLikeManifest(head: string): boolean {
  let apiVersion = false;
  let kind = false;
  // A UTF-8 BOM would sit in front of the first key and defeat the column-0
  // match on the one line most likely to carry it.
  for (const line of head.replace(/^\ufeff/, "").split("\n")) {
    apiVersion ||= /^apiVersion:\s*\S/.test(line);
    kind ||= /^kind:\s*\S/.test(line);
    if (apiVersion && kind) {
      return true;
    }
  }
  return false;
}

/**
 * The icon a row actually shows: its name-derived bucket, upgraded to the
 * Kubernetes wheel once the content has been read and said so.
 *
 * Only plain YAML is upgradeable. A chart's rendered `templates/` are
 * genuine manifests and would pass the content test, but Helm is the more
 * useful thing to say about them — a path rule that fired is a stronger
 * statement than the content test, not a weaker one it can overrule.
 */
export function resolveIconKind(kind: IconKind, isManifest: boolean): IconKind {
  return kind === "yaml" && isManifest ? "kubernetes" : kind;
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

/**
 * Records what a batch of file heads said (`looksLikeManifest`).
 *
 * Every path asked about is recorded, including the ones that came back
 * without a head at all — a directory, a deleted file, a binary. Recording
 * "not a manifest" for those is what stops the tree asking again on every
 * listing refresh for a file that will never answer.
 */
export function withManifests(state: TreeState, heads: Readonly<Record<string, string>>, asked: readonly string[]): TreeState {
  const manifests = new Map(state.manifests);
  for (const path of asked) {
    manifests.set(path, looksLikeManifest(heads[path] ?? ""));
  }
  return { ...state, manifests };
}

/**
 * The plain-YAML paths in one directory listing: the files whose icon
 * depends on content rather than name.
 *
 * Taken from the listing rather than from state, and without excluding what
 * has already been classified, because a listing arrives on expand *and*
 * every time the watcher says the directory changed — and a file edited into
 * a manifest, or out of one, is exactly the case a cache keyed on path
 * alone would keep showing the old answer for. The cost is one bounded read
 * per YAML file in the directories actually open.
 */
export function yamlPaths(dir: string, entries: readonly Entry[]): string[] {
  return entries
    .filter((entry) => !entry.isDir)
    .map((entry) => joinPath(dir, entry.name))
    .filter((path) => iconKind(path, false) === "yaml");
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

/**
 * Brings a directory on screen: it and every ancestor expanded, it selected,
 * and every filter that would have hidden it cleared.
 *
 * The filters are the part worth stating out loud. A reveal that left
 * `showHidden` off could not show `.github/workflows`, and one that left
 * changed-only mode on could not show a directory with nothing changed in it
 * — in both cases the tree would answer a reveal by doing nothing at all,
 * which is the one outcome a "reveal" must not have. Turning a filter off is
 * visible in the header's own toggles, so the user can see what happened and
 * put it back.
 *
 * Expanding is all this does about listings: a directory expanded here may
 * never have been fetched, and `useFileTree.reveal` is what asks for the ones
 * that have not.
 */
export function reveal(state: TreeState, dir: string): TreeState {
  const chain = ancestry(dir);
  const expanded = new Set(state.expanded);
  for (const path of chain) {
    expanded.add(path);
  }
  return {
    ...state,
    expanded,
    selected: dir,
    showHidden: state.showHidden || chain.some((path) => isHidden({ name: baseName(path) })),
    changedOnly: false,
  };
}

export function select(state: TreeState, path: string | null): TreeState {
  return { ...state, selected: path };
}

export function toggleHidden(state: TreeState): TreeState {
  return { ...state, showHidden: !state.showHidden };
}

/** Flips between the full tree and the changed files alone (#40). */
export function toggleChangedOnly(state: TreeState): TreeState {
  return { ...state, changedOnly: !state.changedOnly };
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
