import { useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeController } from "../lib/useFileTree";
import type { TreeRow } from "../lib/tree";
import { ROOT, parentPath, visibleRows } from "../lib/tree";
import type { Status } from "../lib/git";
import type { Badges } from "../lib/gitStatus";
import { badgeAt, badgeTone, badgesFor, changedRows } from "../lib/gitStatus";
import { UiIcon } from "./Icon";
import { RowView } from "./FileTreeRow";
import { CreateRow } from "./InlineField";

export interface FileTreeProps {
  readonly tree: FileTreeController;
  /** This project's git status (#8, #40): the marker and tint on every row,
   * and the rows themselves in changed-only mode. Available-shaped and empty
   * until the first read lands, which is why it is a value rather than an
   * optional. */
  readonly status: Status;
  /** The open-file intent (DESIGN.md §5, "selecting a file emits an
   * open-file intent"). #7's editor is what actually opens it; until then
   * this is passed through and dropped, the same way `terminals` is
   * threaded through Workbench today. */
  readonly onOpenFile: (path: string) => void;
}

/** What is being created, and where. */
interface Creating {
  readonly dir: string;
  readonly isDir: boolean;
}

/**
 * The lazy, keyboard-navigable file tree (DESIGN.md §5, issue #6).
 *
 * Rows are a flat list (`visibleRows`) rather than nested components: it is
 * what makes arrow-key navigation a matter of moving one index, and what
 * keeps a 5,000-file repository's DOM to only the directories actually
 * expanded — lazy loading, not virtualization, is what bounds it (see the
 * plan this ticket shipped against).
 */
export function FileTree({ tree, status, onOpenFile }: FileTreeProps) {
  // Both walk every changed path, and this component re-renders on state that
  // has nothing to do with git — a keystroke in the editor, a terminal going
  // busy. A status object is replaced only when a read lands, so this ties the
  // work to the thing that actually changed.
  const badges = useMemo(() => badgesFor(status), [status]);
  const changed = useMemo(() => changedRows(status), [status]);

  // Which of the two the tree is showing (#40). It lives in TreeState rather
  // than here so that `reveal` can clear it (#43) — see the field's own note.
  const changedOnly = tree.state.changedOnly;

  const rows = changedOnly ? changed : visibleRows(tree.state);
  // Root failing to list is the one directory failure worth a dedicated
  // message: every other directory's error stays local to its own row
  // (RowView never renders — a failed subdirectory just contributes no
  // children), but a failed root is the whole tree having nothing to show.
  const rootError = tree.state.dirs[ROOT]?.status === "error" ? tree.state.dirs[ROOT].error : null;
  const [cursor, setCursor] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Shared across creating/renaming/deleting: only one of those is ever
  // active at a time, so one slot is enough and there is nowhere for a stale
  // error from a previous action to leak into a fresh one (every starter
  // below clears it).
  const [actionError, setActionError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // A collapse or a listing shrinking the tree can leave the cursor past the
  // end; clamp rather than lose it off the visible list entirely.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  // A reveal from the breadcrumb (#43) expands its way down to a row that may
  // be well past the bottom of a scrolled tree, and a highlight nobody can see
  // is not a reveal. Keyed on the row's index rather than on `rows`, which is
  // a fresh array on every render: scrolling every render would drag the tree
  // back under the user whenever they scrolled it themselves. The index also
  // changes from -1 the moment a directory listing this reveal asked for
  // lands, which is what makes a row that did not exist yet still arrive on
  // screen.
  const selectedIndex = rows.findIndex((row) => row.path === tree.state.selected);
  useEffect(() => {
    if (selectedIndex >= 0) {
      rowRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Roving tabindex: only move DOM focus when the tree itself already has
  // it, so a background listing refresh (an /events update) never steals
  // focus from wherever the user actually is — a terminal pane, an inline
  // rename field elsewhere in the app.
  useEffect(() => {
    if (containerRef.current?.contains(document.activeElement)) {
      rowRefs.current[cursor]?.focus();
    }
  }, [cursor]);

  const startCreating = (dir: string, isDir: boolean) => {
    setMenuFor(null);
    setActionError(null);
    if (dir !== ROOT && !tree.state.expanded.has(dir)) {
      tree.expand(dir);
    }
    setCreating({ dir, isDir });
  };

  const startRenaming = (path: string) => {
    setMenuFor(null);
    setActionError(null);
    setRenaming(path);
  };

  const startDeleting = (path: string) => {
    setMenuFor(null);
    setActionError(null);
    setDeleting(path);
  };

  const commitCreate = (item: Extract<RenderItem, { kind: "creating" }>, name: string) => {
    void tree.createEntry(item.dir, name, item.isDir).then((error) => {
      if (error === null) {
        setCreating(null);
      } else {
        setActionError(error);
      }
    });
  };

  const commitRename = (path: string, name: string) => {
    void tree.renameEntry(path, name).then((error) => {
      if (error === null) {
        setRenaming(null);
      } else {
        setActionError(error);
      }
    });
  };

  const confirmDelete = (path: string) => {
    void tree.deleteEntry(path).then((error) => {
      if (error === null) {
        setDeleting(null);
      } else {
        setActionError(error);
      }
    });
  };

  const rendered = withCreatingRow(rows, creating);
  const activation: Activation = { tree, onOpenFile, badges, changedOnly };

  return (
    <div className="tree">
      <div className="tree__header">
        <button type="button" aria-label="new file" onClick={() => { startCreating(ROOT, false); }}>
          <UiIcon name="plus" />
          file
        </button>
        <button type="button" aria-label="new folder" onClick={() => { startCreating(ROOT, true); }}>
          <UiIcon name="plus" />
          folder
        </button>
        <button
          type="button"
          className="tree__mode-toggle"
          aria-pressed={changedOnly}
          aria-label={changedOnly ? "show all files" : "show changed files only"}
          title={changedOnly ? "Show all files" : "Show changed files only"}
          onClick={() => {
            tree.toggleChangedOnly();
            // The two lists are different lengths and different orders; a
            // cursor carried across means landing on an unrelated row.
            setCursor(0);
          }}
        >
          <UiIcon name="filter" />
        </button>
        <button
          type="button"
          className="tree__hidden-toggle"
          aria-pressed={tree.state.showHidden}
          onClick={tree.toggleHidden}
        >
          {tree.state.showHidden ? "hide dotfiles" : "show dotfiles"}
        </button>
      </div>

      <div
        ref={containerRef}
        className="tree__rows"
        role="tree"
        aria-label={changedOnly ? "Changed files" : "File tree"}
        onKeyDown={(event) => {
          handleKeyDown(event, { ...activation, rows, cursor, setCursor });
        }}
      >
        {rendered.map((item, index) =>
          item.kind === "creating" ? (
            <CreateRow
              key="creating"
              depth={item.depth}
              isDir={item.isDir}
              error={actionError}
              onCommit={(name) => { commitCreate(item, name); }}
              onCancel={() => { setCreating(null); setActionError(null); }}
            />
          ) : (
            <RowView
              key={item.row.path}
              row={item.row}
              isManifest={tree.state.manifests.get(item.row.path) ?? false}
              badge={badgeAt(badges, item.row.path, item.row.isDir)}
              focused={rowIndexOf(rendered, index) === cursor}
              selected={tree.state.selected === item.row.path}
              expanded={changedOnly || tree.state.expanded.has(item.row.path)}
              menuOpen={menuFor === item.row.path}
              renaming={renaming === item.row.path}
              deleting={deleting === item.row.path}
              error={actionError}
              rowRef={(el) => {
                const i = rowIndexOf(rendered, index);
                if (i !== null) {
                  rowRefs.current[i] = el;
                }
              }}
              onActivate={() => {
                const i = rowIndexOf(rendered, index);
                if (i !== null) {
                  setCursor(i);
                }
                activate(item.row, activation);
              }}
              onMenu={() => { setMenuFor(item.row.path); }}
              onCloseMenu={() => { setMenuFor(null); }}
              onNewFile={() => { startCreating(item.row.isDir ? item.row.path : parentPath(item.row.path), false); }}
              onNewFolder={() => { startCreating(item.row.isDir ? item.row.path : parentPath(item.row.path), true); }}
              onStartRename={() => { startRenaming(item.row.path); }}
              onCommitRename={(name) => { commitRename(item.row.path, name); }}
              onCancelRename={() => { setRenaming(null); setActionError(null); }}
              onStartDelete={() => { startDeleting(item.row.path); }}
              onConfirmDelete={() => { confirmDelete(item.row.path); }}
              onCancelDelete={() => { setDeleting(null); setActionError(null); }}
            />
          ),
        )}
        {rows.length === 0 && creating === null && (
          <p className="tree__empty">{emptyMessage(changedOnly, rootError)}</p>
        )}
      </div>
    </div>
  );
}

/** A rendered row: a real tree entry, or the inline "creating" placeholder. */
type RenderItem =
  | { readonly kind: "entry"; readonly row: TreeRow }
  | { readonly kind: "creating"; readonly depth: number; readonly dir: string; readonly isDir: boolean };

/** Splices the in-progress create row into its target directory's position. */
function withCreatingRow(rows: TreeRow[], creating: Creating | null): RenderItem[] {
  const entries: RenderItem[] = rows.map((row) => ({ kind: "entry", row }));
  if (creating === null) {
    return entries;
  }
  const marker: RenderItem = { kind: "creating", depth: 0, dir: creating.dir, isDir: creating.isDir };
  if (creating.dir === ROOT) {
    return [marker, ...entries];
  }
  const at = rows.findIndex((r) => r.path === creating.dir);
  if (at < 0) {
    return entries;
  }
  return [...entries.slice(0, at + 1), { ...marker, depth: rows[at].depth + 1 }, ...entries.slice(at + 1)];
}

/** The index into `rows` (skipping the synthetic creating row) an item at
 * `renderedIndex` in the rendered list corresponds to, or null for the
 * creating row itself. */
function rowIndexOf(rendered: RenderItem[], renderedIndex: number): number | null {
  let rowIndex = 0;
  for (let i = 0; i < renderedIndex; i += 1) {
    if (rendered[i].kind === "entry") {
      rowIndex += 1;
    }
  }
  return rendered[renderedIndex].kind === "entry" ? rowIndex : null;
}

/** What a row's message is, when there are no rows to show. */
function emptyMessage(changedOnly: boolean, rootError: string | null): string {
  if (changedOnly) {
    // Deliberately not "not a git repository" or "git is missing": those are
    // facts about the project, and the status bar states them for every mode
    // rather than only for the one that happens to be empty because of them.
    return "Nothing has changed in this project.";
  }
  return rootError ?? "No files in this project.";
}

/** What activating a row acts on — bundled so the handlers below stay under
 * the parameter-count budget the rest of the frontend holds to. */
interface Activation {
  readonly tree: FileTreeController;
  readonly onOpenFile: (path: string) => void;
  readonly badges: Badges;
  readonly changedOnly: boolean;
}

/** The context arrow-key navigation acts over. */
interface NavContext extends Activation {
  readonly rows: TreeRow[];
  readonly cursor: number;
  readonly setCursor: (value: number) => void;
}

function handleKeyDown(event: React.KeyboardEvent, nav: NavContext): void {
  const row = nav.rows[nav.cursor];
  if (!row) {
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      nav.setCursor(Math.min(nav.cursor + 1, nav.rows.length - 1));
      break;
    case "ArrowUp":
      event.preventDefault();
      nav.setCursor(Math.max(nav.cursor - 1, 0));
      break;
    case "ArrowRight":
      event.preventDefault();
      moveRight(row, nav);
      break;
    case "ArrowLeft":
      event.preventDefault();
      moveLeft(row, nav);
      break;
    case "Enter":
      event.preventDefault();
      activate(row, nav);
      break;
    default:
      break;
  }
}

function moveRight(row: TreeRow, nav: NavContext): void {
  if (!row.isDir) {
    return;
  }
  if (isOpen(row, nav)) {
    nav.setCursor(Math.min(nav.cursor + 1, nav.rows.length - 1));
  } else {
    nav.tree.expand(row.path);
  }
}

function moveLeft(row: TreeRow, nav: NavContext): void {
  if (row.isDir && isOpen(row, nav) && !nav.changedOnly) {
    nav.tree.collapse(row.path);
    return;
  }
  const parent = parentPath(row.path);
  const index = nav.rows.findIndex((r) => r.path === parent);
  if (index >= 0) {
    nav.setCursor(index);
  }
}

/** Whether a directory row's children are on screen beneath it. Every
 * directory in changed-only mode is: the mode's rows are built with their
 * ancestors already in place, and none of them is behind a listing the tree
 * may not have fetched. */
function isOpen(row: TreeRow, ctx: Activation): boolean {
  return ctx.changedOnly || ctx.tree.state.expanded.has(row.path);
}

function activate(row: TreeRow, ctx: Activation): void {
  if (row.isDir) {
    // A twisty in changed-only mode would hide changes from the mode whose
    // whole job is to show them, so there is nothing to toggle there.
    if (!ctx.changedOnly) {
      toggleDir(row, ctx.tree);
    }
    return;
  }
  // A deleted path is a row about a file that is not on disk. Opening it
  // would be a file-not-found from the backend dressed up as an editor tab.
  if (badgeTone(badgeAt(ctx.badges, row.path, false)) === "deleted") {
    return;
  }
  ctx.tree.select(row.path);
  ctx.onOpenFile(row.path);
}

function toggleDir(row: TreeRow, tree: FileTreeController): void {
  if (tree.state.expanded.has(row.path)) {
    tree.collapse(row.path);
  } else {
    tree.expand(row.path);
  }
}

