import type { ReactNode } from "react";
import { FileTree } from "./FileTree";
import type { Project } from "../lib/projects";
import type { FileTreeController } from "../lib/useFileTree";

export interface WorkbenchProps {
  /** The file tree's state and operations for this project (#6). */
  readonly tree: FileTreeController;
  /** The open-file intent a tree selection emits; #7's editor is what will
   * act on it. */
  readonly onOpenFile: (path: string) => void;
  /** The terminal strip and panes for this project. */
  readonly terminals: ReactNode;
}

/**
 * The per-project workbench (DESIGN.md §5): file tree, editor, terminal.
 *
 * The editor is a placeholder that names the issue that fills it. The file
 * tree is real — it is #6's — and the terminal pane is real — it is #4's,
 * rooted at this project's checkout.
 */
export function Workbench({ tree, onOpenFile, terminals }: WorkbenchProps) {
  return (
    <div className="workbench">
      <aside className="workbench__tree">
        <FileTree tree={tree} onOpenFile={onOpenFile} />
      </aside>

      <section className="workbench__editor" aria-label="Editor">
        <p className="placeholder">Editor — #7</p>
      </section>

      <section className="workbench__terminal" aria-label="Terminal">
        {terminals}
      </section>
    </div>
  );
}

export interface ProjectStatusProps {
  readonly project: Project | null;
}

/**
 * The per-project half of the status bar.
 *
 * The kube binding is shown even when it is empty, because "no context bound"
 * is the state that disables every cluster action (DESIGN.md §4) and a user
 * looking for why an apply button is greyed out should find the answer here
 * rather than in a menu.
 */
export function ProjectStatus({ project }: ProjectStatusProps) {
  if (project === null) {
    return <span data-testid="project-status">no project selected</span>;
  }
  const context = project.kube.context;
  return (
    <span data-testid="project-status">
      {context === ""
        ? `${project.name} — no context bound`
        : `${project.name} — ${context}`}
    </span>
  );
}
