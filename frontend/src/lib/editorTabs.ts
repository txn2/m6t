import type { FileContent } from "./files";
import type { IconKind } from "./tree";

/**
 * The editor tab strip's model: what a tab is, and the transitions the strip
 * performs on it. Everything here is pure — the hook (useEditorTabs) owns the
 * backend calls and the /events subscription, this owns the shape of what
 * they produced — the same split `lib/tabs.ts` already uses for the terminal
 * strip. This is a second, independent instance of that pattern rather than
 * shared code: DESIGN.md §5 and issue #7 both want the editor strip kept
 * separate from the terminal strip.
 */

/** The kinds of file the editor renders differently. Derived from `tree.ts`'s
 * `IconKind`, which already buckets by extension — "dir" never reaches a tab. */
export type EditorTabKind = "yaml" | "markdown" | "text";

/** Where a tab's content stands relative to the backend. */
export type EditorTabStatus = "loading" | "ready" | "error";

/** How a markdown tab is currently shown; yaml/text tabs are always "edit". */
export type EditorMode = "preview" | "edit";

/** One editor tab. */
export interface EditorTab {
  /** Identity for React and for every lookup here; never reused. */
  readonly key: string;
  /** The project this tab belongs to, by name — the same scoping
   * `TerminalTab.project` uses. */
  readonly project: string;
  /** The project's worktree root, fixed when the tab is created — what
   * `Files.read`/`Files.write` take alongside `path`. */
  readonly root: string;
  /** Root-relative, slash-separated path (`tree.ts`'s convention). */
  readonly path: string;
  /** The file's basename, shown on the tab; `path` is what the tab's tooltip
   * shows, so two files with the same name stay tellable apart. */
  readonly title: string;
  readonly kind: EditorTabKind;
  readonly mode: EditorMode;
  readonly status: EditorTabStatus;
  /** The buffer as the user is editing it, LF-normalized. */
  readonly content: string;
  /** The content as last read from or written to disk, LF-normalized.
   * Comparing against this is what dirtiness and external-change
   * reconciliation are both built on. */
  readonly baseline: string;
  /** The file's line-ending style, as ReadFile reported it — WriteFile needs
   * it back to save without rewriting lines the user never touched. */
  readonly crlf: boolean;
  /** A file the backend will not let the editor write back: too large, or
   * mixed line endings. */
  readonly readOnly: boolean;
  /** Why `readOnly` is set, when the reason is non-uniform line endings. */
  readonly mixedEol: boolean;
  /** The file's size on disk, for the read-only notice. */
  readonly size: number;
  /** Set when the file changed on disk while this tab was dirty: the disk's
   * content, offered for a keep-mine/take-disk choice rather than applied
   * over the user's edits. */
  readonly conflict: string | null;
  /** True while a save is in flight, so a second Cmd+S cannot start one on
   * top of it. */
  readonly saving: boolean;
  /** Why `status` is "error", or why the last save failed. */
  readonly error: string | null;
}

/** Whether a tab has edits not yet written to disk. A loading or errored tab
 * is never dirty — there is no confirmed disk content for it to differ from. */
export function isDirty(tab: EditorTab): boolean {
  return tab.status === "ready" && tab.content !== tab.baseline;
}

/**
 * Whether a save is allowed right now.
 *
 * The conflict clause is the one worth stating out loud: a tab holding an
 * unresolved conflict must not be saveable, because the buffer was written
 * against a version of the file that no longer exists on disk. Letting Cmd+S
 * through would silently discard whatever the other writer — a `claude`
 * session in the terminal pane, most likely — had just done. The user has to
 * pick keep-mine or take-disk first; both clear the conflict and re-enable
 * this.
 */
export function canSave(tab: EditorTab): boolean {
  return isDirty(tab) && !tab.readOnly && !tab.saving && tab.conflict === null;
}

/** The sentence a read-only tab shows, or null when the tab is editable. */
export function readOnlyNotice(tab: EditorTab): string | null {
  if (!tab.readOnly) {
    return null;
  }
  if (tab.mixedEol) {
    return "Read-only: this file mixes CRLF and LF line endings. Saving it would rewrite every line, not just your edit.";
  }
  return `Read-only: ${formatSize(tab.size)} is over the editing limit.`;
}

/** A byte count in the units a person reads. */
export function formatSize(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) {
    return `${mib.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024).toString()} KB`;
}

/**
 * Every icon bucket that is a YAML file. `IconKind` splits YAML five ways so
 * the tree can show a chart, a kustomization and a workflow as themselves
 * (#38) — but all five get YAML syntax highlighting and YAML folding, so
 * this maps them back together. Missing one would silently open `Chart.yaml`
 * as plain text.
 */
const YAML_ICONS: ReadonlySet<IconKind> = new Set<IconKind>([
  "yaml",
  "kubernetes",
  "helm",
  "kustomize",
  "actions",
]);

/** The file-type bucket a tab uses, from `tree.ts`'s path-based `IconKind` —
 * no second copy of the extension list to keep in sync. */
export function kindFromIcon(icon: IconKind): EditorTabKind {
  if (YAML_ICONS.has(icon)) {
    return "yaml";
  }
  if (icon === "md") {
    return "markdown";
  }
  return "text";
}

/** A tab's file name, the last path segment. */
export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * The separator a project's own paths are written with.
 *
 * `path` is slash-separated everywhere inside the app — this package's
 * convention, and `tree.ts`'s — but `root` is whatever the OS handed the
 * registry, which on Windows is backslashes (DESIGN.md §1 targets it). A path
 * the user copies is on its way into a shell or a file dialog, so it goes out
 * in the platform's form rather than in the one only m6t uses.
 */
function separator(root: string): string {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

/** A tab's path relative to its project root, for the clipboard (#42). */
export function relativePath(tab: EditorTab): string {
  const sep = separator(tab.root);
  return sep === "/" ? tab.path : tab.path.split("/").join(sep);
}

/**
 * A tab's absolute path, for the clipboard (#42).
 *
 * The root's trailing separator is dropped before joining, so a project opened
 * at a filesystem root — `/`, or `C:\` — produces one separator rather than
 * two.
 */
export function absolutePath(tab: EditorTab): string {
  const sep = separator(tab.root);
  const root = tab.root.replace(/[/\\]+$/, "");
  return `${root}${sep}${relativePath(tab)}`;
}

/** Creates a tab that has not yet asked the backend for its content. */
export function newTab(
  key: string,
  project: string,
  root: string,
  path: string,
  kind: EditorTabKind,
): EditorTab {
  return {
    key,
    project,
    root,
    path,
    title: basename(path),
    kind,
    // Markdown opens in rendered preview by default (the issue's own
    // wording); yaml and text have no preview to default away from.
    mode: kind === "markdown" ? "preview" : "edit",
    status: "loading",
    content: "",
    baseline: "",
    crlf: false,
    readOnly: false,
    mixedEol: false,
    size: 0,
    conflict: null,
    saving: false,
    error: null,
  };
}

/** The tabs belonging to one project — flat storage, filtered for display,
 * the same reasoning `tabsForProject` in `tabs.ts` documents: every tab stays
 * in the list across a project switch, so a project's unsaved buffer is never
 * dropped because the user looked at something else. */
export function tabsForProject(
  tabs: readonly EditorTab[],
  project: string | null,
): EditorTab[] {
  if (project === null) {
    return [];
  }
  return tabs.filter((tab) => tab.project === project);
}

/** The key of an already-open tab for this project/path, or null. Opening a
 * file the strip already has a tab for focuses it rather than duplicating it. */
export function findTabKey(
  tabs: readonly EditorTab[],
  project: string,
  path: string,
): string | null {
  return tabs.find((tab) => tab.project === project && tab.path === path)?.key ?? null;
}

/** Applies a patch to one tab, leaving the rest untouched. */
export function patchTab(
  tabs: readonly EditorTab[],
  key: string,
  patch: Partial<EditorTab>,
): EditorTab[] {
  return tabs.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab));
}

/** Applies a transform to one tab, leaving the rest untouched. */
export function mapTab(
  tabs: readonly EditorTab[],
  key: string,
  transform: (tab: EditorTab) => EditorTab,
): EditorTab[] {
  return tabs.map((tab) => (tab.key === key ? transform(tab) : tab));
}

/** Removes a tab from the strip. */
export function removeTab(tabs: readonly EditorTab[], key: string): EditorTab[] {
  return tabs.filter((tab) => tab.key !== key);
}

/**
 * The tab to select after `key` is closed — the same right-neighbour,
 * then-left, then-none rule `selectionAfterClose` in `tabs.ts` uses, kept as
 * its own copy because it operates on `EditorTab`, not `TerminalTab`.
 */
export function selectionAfterClose(
  tabs: readonly EditorTab[],
  key: string,
  active: string | null,
): string | null {
  if (active !== key) {
    return active;
  }
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0) {
    return active;
  }
  const remaining = removeTab(tabs, key);
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(index, remaining.length - 1)].key;
}

/** Records a freshly loaded (or reloaded) file. */
export function withLoaded(tab: EditorTab, file: FileContent): EditorTab {
  return {
    ...tab,
    status: "ready",
    content: file.content,
    baseline: file.content,
    crlf: file.crlf,
    readOnly: file.readOnly,
    mixedEol: file.mixedEol,
    size: file.size,
    conflict: null,
    error: null,
  };
}

/** Records that loading a tab failed. */
export function withError(tab: EditorTab, message: string): EditorTab {
  return { ...tab, status: "error", error: message };
}

/** Applies an edit to a tab's buffer. A read-only tab ignores edits — this is
 * the state-layer half of the guard CodeMirror also enforces in its own
 * configuration. */
export function withEdit(tab: EditorTab, content: string): EditorTab {
  return tab.readOnly ? tab : { ...tab, content, error: null };
}

/** Marks a save as in flight. */
export function withSaving(tab: EditorTab): EditorTab {
  return { ...tab, saving: true, error: null };
}

/**
 * Records a successful save of `saved` — the exact buffer that was written,
 * not whatever the buffer holds now.
 *
 * The distinction matters: a write is asynchronous, and the user can keep
 * typing while it is in flight. Advancing the baseline to the current buffer
 * would mark those newer keystrokes as already-saved and lose them.
 */
export function withSaved(tab: EditorTab, saved: string): EditorTab {
  return { ...tab, baseline: saved, saving: false, conflict: null, error: null };
}

/** Records a failed save. The buffer is untouched — the user's work is the
 * one thing a failed write must not cost them. */
export function withSaveFailed(tab: EditorTab, message: string): EditorTab {
  return { ...tab, saving: false, error: message };
}

/**
 * Records that re-reading a file after a change event failed.
 *
 * Unlike `withError` this leaves `status` alone, which is the whole point: a
 * file deleted out from under an unsaved edit leaves that buffer as the only
 * copy of the user's work, and moving the tab to an error state would replace
 * it on screen with a message. The tab stays readable and saveable, and the
 * error says why it is now out of touch with disk.
 */
export function withReloadFailed(tab: EditorTab, message: string): EditorTab {
  return { ...tab, error: message };
}

/** Switches a markdown tab between rendered preview and CodeMirror edit. */
export function withMode(tab: EditorTab, mode: EditorMode): EditorTab {
  return { ...tab, mode };
}

/**
 * Reconciles a tab against a file that a `tree` event says may have changed
 * on disk, given its freshly re-read content.
 *
 * A clean tab adopts the disk content silently — there is nothing local to
 * lose. A dirty tab whose disk content still matches its own baseline has
 * seen a false alarm, which is the common case: m6t's own save fires the
 * watcher that lands right back here. A dirty tab whose disk content differs
 * from its baseline is a real conflict, and neither buffer nor baseline moves
 * — `conflict` is set and the UI offers the choice.
 */
export function withExternalChange(tab: EditorTab, file: FileContent): EditorTab {
  if (tab.status !== "ready" || tab.saving) {
    return tab;
  }
  if (!isDirty(tab)) {
    return withLoaded(tab, file);
  }
  if (file.content === tab.baseline) {
    return tab;
  }
  return { ...tab, conflict: file.content, crlf: file.crlf };
}

/**
 * Resolves a conflict by keeping the buffer.
 *
 * The baseline moves to the disk content the user has now seen and rejected,
 * so the tab stays dirty — a save is still required to actually overwrite
 * disk — and the next reconciliation compares against what is really there
 * rather than re-raising the same conflict.
 */
export function resolveKeepMine(tab: EditorTab): EditorTab {
  if (tab.conflict === null) {
    return tab;
  }
  return { ...tab, baseline: tab.conflict, conflict: null };
}

/** Resolves a conflict by discarding local edits and adopting disk. */
export function resolveTakeDisk(tab: EditorTab): EditorTab {
  if (tab.conflict === null) {
    return tab;
  }
  return { ...tab, content: tab.conflict, baseline: tab.conflict, conflict: null };
}
