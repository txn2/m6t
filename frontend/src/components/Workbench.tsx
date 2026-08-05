import { useMemo, type ReactNode } from "react";
import { FileTree } from "./FileTree";
import { ChangesPanel } from "./ChangesPanel";
import type { Project } from "../lib/projects";
import type { FileTreeController } from "../lib/useFileTree";
import type { GitStatusController } from "../lib/useGitStatus";
import { badgesFor, branchSummary } from "../lib/gitStatus";

export interface WorkbenchProps {
  /** The file tree's state and operations for this project (#6). */
  readonly tree: FileTreeController;
  /** This project's git status (#8): tree badges and the changes list. */
  readonly git: GitStatusController;
  /** The open-file intent a tree selection emits; the editor strip acts on it. */
  readonly onOpenFile: (path: string) => void;
  /** The editor strip and panes for this project (#7). */
  readonly editor: ReactNode;
  /** The terminal strip and panes for this project. */
  readonly terminals: ReactNode;
}

/**
 * The per-project workbench (DESIGN.md §5): file tree, editor, terminal.
 *
 * All three are real: the tree is #6's, the editor is #7's, and the terminal
 * is #4's, rooted at this project's checkout.
 */
export function Workbench({ tree, git, onOpenFile, editor, terminals }: WorkbenchProps) {
  // The rollup walks every changed path's ancestors, and this component
  // re-renders on unrelated state — a keystroke in the editor, a terminal
  // status. A status object is replaced only when a read lands, so this ties
  // the work to the thing that actually changed.
  const badges = useMemo(() => badgesFor(git.status), [git.status]);

  return (
    <div className="workbench">
      <aside className="workbench__tree">
        <FileTree tree={tree} badges={badges} onOpenFile={onOpenFile} />
        <ChangesPanel status={git.status} error={git.error} onOpenFile={onOpenFile} />
      </aside>

      <section className="workbench__editor" aria-label="Editor">
        {editor}
      </section>

      <section className="workbench__terminal" aria-label="Terminal">
        {terminals}
      </section>
    </div>
  );
}

export interface ProjectStatusProps {
  readonly project: Project | null;
  /** The active project's git state, for the branch half of the bar (#8). */
  readonly git: GitStatusController;
}

/**
 * The per-project half of the status bar.
 *
 * The kube binding is shown even when it is empty, because "no context bound"
 * is the state that disables every cluster action (DESIGN.md §4) and a user
 * looking for why an apply button is greyed out should find the answer here
 * rather than in a menu. The branch line sits beside it for the same reason:
 * DESIGN.md §5 puts `⎇ main ↑1 ↓0 · 3 changed` in the status bar because
 * which branch is checked out decides what an apply would actually apply.
 */
export function ProjectStatus({ project, git }: ProjectStatusProps) {
  if (project === null) {
    return <span data-testid="project-status">no project selected</span>;
  }
  const context = project.kube.context;
  return (
    <>
      <span data-testid="project-status">
        {context === ""
          ? `${project.name} — no context bound`
          : `${project.name} — ${context}`}
      </span>
      <span data-testid="git-status">
        {git.error ?? branchSummary(git.status)}
      </span>
    </>
  );
}
