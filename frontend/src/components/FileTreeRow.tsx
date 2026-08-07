import { useEffect, type CSSProperties } from "react";
import type { TreeRow } from "../lib/tree";
import { iconKind, resolveIconKind } from "../lib/tree";
import { badgeTitle, badgeTone } from "../lib/gitStatus";
import { FileIcon, UiIcon } from "./Icon";
import { InlineField } from "./InlineField";

/**
 * One row of the file tree, in every state it can be in: the entry itself,
 * the inline rename field that replaces it, and the delete confirmation that
 * replaces both (#6).
 *
 * Split out of `FileTree` because the two are different jobs at different
 * scales — that component owns the list, the keyboard cursor and which mode
 * the tree is in, and this owns what one row looks like.
 */

export interface RowViewProps {
  readonly row: TreeRow;
  /** Whether content said this row is a Kubernetes manifest (#38). */
  readonly isManifest: boolean;
  /** This row's git marker, or null when git reports nothing for it. */
  readonly badge: string | null;
  /** Whether this directory carries a kube override of its own (#10). It is
   * the folder's own binding, not an inherited one: marking every directory
   * under `prod/` would colour the whole tree and say nothing about where the
   * rule lives. */
  readonly overridden: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly expanded: boolean;
  /** Where the row's menu is open, or null when it is closed. It carries the
   * point it was opened at, which is where it draws. */
  readonly menuAt: { readonly x: number; readonly y: number } | null;
  readonly renaming: boolean;
  readonly deleting: boolean;
  readonly error: string | null;
  readonly rowRef: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
  /** Opens this row's menu at the point the gesture happened. */
  onMenu: (at: { x: number; y: number }) => void;
  onCloseMenu: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  /** Opens the Kubernetes binding dialog for this directory (#10). */
  onBind: () => void;
}

export function RowView({
  row,
  isManifest,
  badge,
  overridden,
  focused,
  selected,
  expanded,
  menuAt,
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
  onBind,
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
      data-bound={overridden || undefined}
      style={{ "--depth": row.depth } as CSSProperties}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <RowIcons row={row} expanded={expanded} isManifest={isManifest} />
      {/* The tint is the primary signal (#40) and the badge beside it is the
          one that survives a monochrome display or a screen reader; a colour
          on its own would be the only thing saying "modified". */}
      <span className="tree__name" data-tone={badgeTone(badge) ?? undefined}>
        {row.name}
      </span>
      <RowMarkers badge={badge} overridden={overridden} />
      <button
        type="button"
        className="tree__menu-button"
        aria-label={`actions for ${row.name}`}
        onClick={(event) => {
          // The button's own corner, so a menu opened from it hangs off it
          // rather than from wherever the pointer happened to be.
          const box = event.currentTarget.getBoundingClientRect();
          event.stopPropagation();
          onMenu({ x: box.left, y: box.bottom });
        }}
      >
        <UiIcon name="menu" />
      </button>
      {menuAt !== null && (
        <RowMenu
          at={menuAt}
          isDir={row.isDir}
          onClose={onCloseMenu}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onRename={onStartRename}
          onDelete={onStartDelete}
          onBind={onBind}
        />
      )}
    </div>
  );
}

/**
 * A row's trailing marks: what git says about it, and whether it carries a
 * kube binding of its own (#10).
 *
 * They are one component rather than two conditionals inline because the row
 * has a branch budget and these are the two cheapest to move — neither depends
 * on any of the row's modes (renaming, deleting, menu-open), so nothing here
 * has to know which one the row is in.
 */
function RowMarkers({
  badge,
  overridden,
}: {
  readonly badge: string | null;
  readonly overridden: boolean;
}) {
  return (
    <>
      {badge !== null && (
        // data-badge rather than a modifier class: a badge can be `?` or `•`,
        // neither of which is usable in a class-selector name.
        <span className="tree__badge" data-badge={badge} title={badgeTitle(badge)}>
          {badge}
        </span>
      )}
      {overridden && (
        <span
          className="tree__bound"
          title="this folder is bound to its own context or namespace"
        >
          <UiIcon name="cluster" />
        </span>
      )}
    </>
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
  /** Where the menu was summoned, in viewport coordinates. */
  readonly at: { readonly x: number; readonly y: number };
  readonly isDir: boolean;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onBind: () => void;
}

/**
 * A row's context menu: the actions that work, and nothing else.
 *
 * It carries no note about what a later ticket will add. A menu that lists
 * what it cannot do is a menu the user has to read past every time, and the
 * git entries (#8, DESIGN.md §7) will announce themselves by appearing here
 * when they work.
 *
 * Kubernetes is a directory's entry alone (#10). A binding covers a subtree,
 * and offering it on a file would invite a per-file override the resolution
 * rules have no way to express — a scope is a folder, and the menu says so by
 * only appearing on one.
 */
function RowMenu({
  at,
  isDir,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onBind,
}: RowMenuProps) {
  useEffect(() => {
    const closeOnOutsideClick = () => { onClose(); };
    window.addEventListener("click", closeOnOutsideClick);
    return () => { window.removeEventListener("click", closeOnOutsideClick); };
  }, [onClose]);

  return (
    <div
      className="tree__menu"
      role="menu"
      // Drawn where the gesture happened rather than where the row is. The menu
      // used to be `position: fixed` with no coordinates at all, which put it
      // at whatever static position the row's flex line left it — hundreds of
      // pixels from the pointer, and wrong again the moment the tree scrolled.
      style={within(at)}
      onClick={(event) => { event.stopPropagation(); }}
    >
      {isDir && (
        <>
          {/* Kubernetes first: it is the reason to open this menu on a
              directory, and the file operations below it are the ones every
              tree has. */}
          <button type="button" role="menuitem" onClick={onBind}>
            <FileIcon kind="kubernetes" />
            Kubernetes
          </button>
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
    </div>
  );
}

/** How wide and tall the menu is assumed to be when holding it on screen.
 * Measuring would need a layout pass and a second render; the menu has a fixed
 * min-width and a known item count, so an estimate that errs large is enough to
 * keep it off the window edges. */
const MENU_WIDTH = 176;
const MENU_HEIGHT = 200;

/** The menu's position, held inside the window.
 *
 * Without this a right-click near the bottom of a tall tree opens a menu whose
 * last item is below the fold, and the item most likely to be cut off is
 * Delete. jsdom reports zero for both dimensions, which reads as "unmeasured"
 * and leaves the point alone. */
function within(at: { readonly x: number; readonly y: number }): CSSProperties {
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  return {
    left: width > 0 ? Math.min(at.x, Math.max(0, width - MENU_WIDTH)) : at.x,
    top: height > 0 ? Math.min(at.y, Math.max(0, height - MENU_HEIGHT)) : at.y,
  };
}
