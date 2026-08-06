import { Fragment } from "react";
import type { EditorTab } from "../lib/editorTabs";
import { ancestry, baseName } from "../lib/tree";
import { UiIcon } from "./Icon";

export interface BreadcrumbProps {
  /** The file the editor is showing, or null when nothing is open. */
  readonly tab: EditorTab | null;
  /** Opens a directory segment in the tree — `FileTreeController.reveal`. */
  onReveal: (dir: string) => void;
}

/**
 * The active file's path from the project root, above the editor (#43).
 *
 * The root itself is not a segment. Every path in a project is relative to it,
 * so naming it in every breadcrumb would spend the first slot on the one thing
 * that never changes — the project strip above already says which project this
 * is.
 *
 * Only the directory segments are buttons. The file's own segment is the file
 * already on screen, so a click on it has nothing to reveal; in VS Code that
 * slot opens a symbol picker, which this ticket puts out of scope, and a button
 * that does nothing would be worse than plain text either way.
 */
export function Breadcrumb({ tab, onReveal }: BreadcrumbProps) {
  if (tab === null) {
    return null;
  }
  const chain = ancestry(tab.path);
  const last = chain.length - 1;

  return (
    <nav className="breadcrumb" aria-label={`path of ${tab.title}`}>
      {chain.map((path, index) => (
        <Fragment key={path}>
          {index > 0 && (
            <UiIcon name="chevron-right" className="breadcrumb__separator" />
          )}
          {index === last ? (
            <span className="breadcrumb__leaf">{baseName(path)}</span>
          ) : (
            <button
              type="button"
              className="breadcrumb__crumb"
              title={`Reveal ${path} in the tree`}
              onClick={() => {
                onReveal(path);
              }}
            >
              {baseName(path)}
            </button>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
