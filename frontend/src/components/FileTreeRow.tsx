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

export function RowView({
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
      {/* The tint is the primary signal (#40) and the badge beside it is the
          one that survives a monochrome display or a screen reader; a colour
          on its own would be the only thing saying "modified". */}
      <span className="tree__name" data-tone={badgeTone(badge) ?? undefined}>
        {row.name}
      </span>
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
 * A row's context menu: the actions that work, and nothing else.
 *
 * It carries no note about what a later ticket will add. A menu that lists
 * what it cannot do is a menu the user has to read past every time, and the
 * git and kube entries (#8, #10, DESIGN.md §6, §7) will announce themselves by
 * appearing here when they work.
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
    </div>
  );
}
