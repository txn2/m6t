import type { ReactNode } from "react";
import type { Project } from "../lib/projects";

export interface WorkbenchProps {
  readonly project: Project;
  /** The terminal strip and panes for this project. */
  readonly terminals: ReactNode;
}

/**
 * The per-project workbench (DESIGN.md §5): file tree, editor, terminal.
 *
 * The tree and editor are placeholders that name the issue that fills them, so
 * the layout this ticket delivers is honest about what is in it. The terminal
 * pane is real — it is #4's, rooted at this project's checkout.
 */
export function Workbench({ project, terminals }: WorkbenchProps) {
  return (
    <div className="workbench">
      <aside className="workbench__tree" aria-label="File tree">
        <p className="placeholder">File tree — #6</p>
        <p className="placeholder placeholder--path" title={project.path}>
          {project.path}
        </p>
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
