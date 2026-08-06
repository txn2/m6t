import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FileTreeController } from "../lib/useFileTree";
import type { TreeRow } from "../lib/tree";
import { ROOT, iconKind, parentPath, resolveIconKind, visibleRows } from "../lib/tree";
import type { Badges } from "../lib/gitStatus";
import { badgeAt, badgeTitle } from "../lib/gitStatus";
import { FileIcon, UiIcon } from "./Icon";
import { CreateRow, InlineField } from "./InlineField";

export interface FileTreeProps {
  readonly tree: FileTreeController;
  /** Git markers for this project's rows (#8), rolled up to directories.
   * Empty until the first status read lands, which is why it is a value
   * rather than an optional. */
  readonly badges: Badges;
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
export function FileTree({ tree, badges, onOpenFile }: FileTreeProps) {
  const rows = visibleRows(tree.state);
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
        aria-label="File tree"
        onKeyDown={(event) => {
          handleKeyDown(event, { rows, cursor, setCursor, tree, onOpenFile });
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
              expanded={tree.state.expanded.has(item.row.path)}
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
                activate(item.row, tree, onOpenFile);
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
          <p className="tree__empty">
            {rootError !== null ? rootError : "No files in this project."}
          </p>
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

/** The context arrow-key navigation acts over — bundled so the handlers
 * below stay under the parameter-count budget the rest of the frontend
 * holds to. */
interface NavContext {
  readonly rows: TreeRow[];
  readonly cursor: number;
  readonly setCursor: (value: number) => void;
  readonly tree: FileTreeController;
  readonly onOpenFile: (path: string) => void;
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
      activate(row, nav.tree, nav.onOpenFile);
      break;
    default:
      break;
  }
}

function moveRight(row: TreeRow, nav: NavContext): void {
  if (!row.isDir) {
    return;
  }
  if (nav.tree.state.expanded.has(row.path)) {
    nav.setCursor(Math.min(nav.cursor + 1, nav.rows.length - 1));
  } else {
    nav.tree.expand(row.path);
  }
}

function moveLeft(row: TreeRow, nav: NavContext): void {
  if (row.isDir && nav.tree.state.expanded.has(row.path)) {
    nav.tree.collapse(row.path);
    return;
  }
  const parent = parentPath(row.path);
  const index = nav.rows.findIndex((r) => r.path === parent);
  if (index >= 0) {
    nav.setCursor(index);
  }
}

function activate(row: TreeRow, tree: FileTreeController, onOpenFile: (path: string) => void): void {
  if (row.isDir) {
    if (tree.state.expanded.has(row.path)) {
      tree.collapse(row.path);
    } else {
      tree.expand(row.path);
    }
    return;
  }
  tree.select(row.path);
  onOpenFile(row.path);
}

interface RowViewProps {
  readonly row: TreeRow;
  /** Whether content said this row is a Kubernetes manifest (#38). */
  readonly isManifest: boolean;
  /** This row's git marker, or null when git reports nothing for it. */
  readonly badge: string | null;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly menuOpen: boolean;
  readonly renaming: boolean;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly rowRef: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
  onMenu: () => void;
  onCloseMenu: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

function RowView({
  row,
  isManifest,
  badge,
  focused,
  selected,
  expanded,
  menuOpen,
  renaming,
  deleting,
  error,
  rowRef,
  onActivate,
  onMenu,
  onCloseMenu,
  onNewFile,
  onNewFolder,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: RowViewProps) {
  if (deleting) {
    return (
      <div
        className="tree__row tree__row--confirm"
        style={{ "--depth": row.depth } as CSSProperties}
        // A native button activates on Enter, and that keydown would
        // otherwise also bubble to the tree's own handler and activate
        // whatever row the cursor is on — this row is not it.
        onKeyDown={(event) => { event.stopPropagation(); }}
      >
        <span>Delete {row.name}?</span>
        <button type="button" onClick={onConfirmDelete}>
          Delete
        </button>
        <button type="button" onClick={onCancelDelete}>
          Cancel
        </button>
        {error !== null && <span className="tree__inline-error">{error}</span>}
      </div>
    );
  }

  if (renaming) {
    return (
      <InlineField
        depth={row.depth}
        initial={row.name}
        ariaLabel={`rename ${row.name}`}
        error={error}
        onCommit={onCommitRename}
        onCancel={onCancelRename}
      />
    );
  }

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={row.isDir ? expanded : undefined}
      aria-level={row.depth + 1}
      tabIndex={focused ? 0 : -1}
      className={`tree__row${selected ? " tree__row--selected" : ""}`}
      style={{ "--depth": row.depth } as CSSProperties}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu();
      }}
    >
      <RowIcons row={row} expanded={expanded} isManifest={isManifest} />
      <span className="tree__name">{row.name}</span>
      {badge !== null && (
        // data-badge rather than a modifier class: a badge can be `?` or `•`,
        // neither of which is usable in a class-selector name.
        <span className="tree__badge" data-badge={badge} title={badgeTitle(badge)}>
          {badge}
        </span>
      )}
      <button
        type="button"
        className="tree__menu-button"
        aria-label={`actions for ${row.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onMenu();
        }}
      >
        <UiIcon name="menu" />
      </button>
      {menuOpen && (
        <RowMenu
          isDir={row.isDir}
          onClose={onCloseMenu}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onRename={onStartRename}
          onDelete={onStartDelete}
        />
      )}
    </div>
  );
}

interface RowIconsProps {
  readonly row: TreeRow;
  readonly expanded: boolean;
  /** Whether this row's content said it is a Kubernetes manifest (#38);
   * false both for "read, and it is not" and for "not read yet". */
  readonly isManifest: boolean;
}

/**
 * A row's leading pair (#38): the twisty and the file-type mark.
 *
 * The twisty belongs to a directory alone, but a file still reserves its
 * width — without the empty span every file's icon would sit one twisty to
 * the left of the folder icons above it, and the tree would read as if
 * files were outdented from their own directory.
 */
function RowIcons({ row, expanded, isManifest }: RowIconsProps) {
  return (
    <>
      <span className="tree__twisty" aria-hidden="true">
        {row.isDir && <UiIcon name={expanded ? "chevron-down" : "chevron-right"} />}
      </span>
      <span className="tree__icon">
        <FileIcon
          kind={resolveIconKind(iconKind(row.path, row.isDir), isManifest)}
          expanded={expanded}
        />
      </span>
    </>
  );
}

interface RowMenuProps {
  readonly isDir: boolean;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * The context menu scaffold the issue asks for: the real actions this
 * ticket implements, plus one honest placeholder line rather than a list of
 * git/kube entries with no behavior behind them yet (#8, #10, DESIGN.md §6,
 * §7).
 */
function RowMenu({ isDir, onClose, onNewFile, onNewFolder, onRename, onDelete }: RowMenuProps) {
  useEffect(() => {
    const closeOnOutsideClick = () => { onClose(); };
    window.addEventListener("click", closeOnOutsideClick);
    return () => { window.removeEventListener("click", closeOnOutsideClick); };
  }, [onClose]);

  return (
    <div className="tree__menu" role="menu" onClick={(event) => { event.stopPropagation(); }}>
      {isDir && (
        <>
          <button type="button" role="menuitem" onClick={onNewFile}>
            New File
          </button>
          <button type="button" role="menuitem" onClick={onNewFolder}>
            New Folder
          </button>
        </>
      )}
      <button type="button" role="menuitem" onClick={onRename}>
        Rename
      </button>
      <button type="button" role="menuitem" onClick={onDelete}>
        Delete
      </button>
      <span className="tree__menu-note">Git and Kubernetes actions arrive in later tickets</span>
    </div>
  );
}
