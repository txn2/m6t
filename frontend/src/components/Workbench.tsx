import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FileTree } from "./FileTree";
import { BranchBar } from "./BranchBar";
import { ChangesPanel } from "./ChangesPanel";
import { CommitBox } from "./CommitBox";
import { PaneSeparator } from "./PaneSeparator";
import type { Project } from "../lib/projects";
import type { FileTreeController } from "../lib/useFileTree";
import type { GitStatusController } from "../lib/useGitStatus";
import type { GitOpsController } from "../lib/useGitOps";
import { badgesFor, branchSummary } from "../lib/gitStatus";
import {
  EDITOR_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  TERMINAL_DEFAULT,
  TERMINAL_MIN,
} from "../lib/panes";

export interface WorkbenchProps {
  /** The file tree's state and operations for this project (#6). */
  readonly tree: FileTreeController;
  /** This project's git status (#8): tree badges and the changes list. */
  readonly git: GitStatusController;
  /** The mutating git loop for this project (#9): stage, commit, pull, push,
   * branch switch. */
  readonly gitOps: GitOpsController;
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
export function Workbench({
  tree,
  git,
  gitOps,
  onOpenFile,
  editor,
  terminals,
}: WorkbenchProps) {
  // The rollup walks every changed path's ancestors, and this component
  // re-renders on unrelated state — a keystroke in the editor, a terminal
  // status. A status object is replaced only when a read lands, so this ties
  // the work to the thing that actually changed.
  const badges = useMemo(() => badgesFor(git.status), [git.status]);

  const [sidebar, setSidebar] = useState(SIDEBAR_DEFAULT);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT);
  const { extent, frame } = useExtent();

  return (
    <div
      ref={frame}
      className="workbench"
      style={
        {
          "--m6t-sidebar": `${String(sidebar)}px`,
          "--m6t-terminal": `${String(terminalHeight)}px`,
        } as CSSProperties
      }
    >
      <aside className="workbench__tree">
        <FileTree tree={tree} badges={badges} onOpenFile={onOpenFile} />
        <BranchBar
          status={git.status}
          branches={gitOps.branches}
          remotes={gitOps.remotes}
          error={gitOps.error}
          busy={gitOps.busy}
          onCheckout={gitOps.checkout}
          onPull={gitOps.pull}
          onPush={gitOps.push}
          onDismissError={gitOps.dismissError}
        />
        <ChangesPanel
          status={git.status}
          error={git.error}
          onOpenFile={onOpenFile}
          onStage={gitOps.stage}
          onUnstage={gitOps.unstage}
          busy={gitOps.busy}
        />
        <CommitBox status={git.status} onCommit={gitOps.commit} busy={gitOps.busy} />
      </aside>

      <PaneSeparator
        orientation="vertical"
        size={sidebar}
        direction={1}
        bounds={{ min: SIDEBAR_MIN, minOther: EDITOR_MIN_WIDTH, total: extent.width }}
        label="Sidebar width"
        onResize={setSidebar}
      />

      <section className="workbench__editor" aria-label="Editor">
        {editor}
      </section>

      {/* The terminal trails this separator, so dragging down grows the
          editor above it rather than the terminal below — hence direction -1. */}
      <PaneSeparator
        orientation="horizontal"
        size={terminalHeight}
        direction={-1}
        bounds={{ min: TERMINAL_MIN, minOther: EDITOR_MIN_HEIGHT, total: extent.height }}
        label="Terminal height"
        onResize={setTerminalHeight}
      />

      <section className="workbench__terminal" aria-label="Terminal">
        {terminals}
      </section>
    </div>
  );
}

/**
 * The workbench's own size, for clamping a drag against the window.
 *
 * Zero until something reports otherwise, which is the value `clampSplit`
 * reads as "unmeasured" and answers by dropping the upper bound. That is the
 * correct behaviour in the two cases where it happens: the first frame, before
 * layout, and every jsdom test, where there is no layout at all. A
 * ResizeObserver rather than a window listener because the workbench is not
 * the window — the project strip and status bar are above and below it, and a
 * split clamped against the window's height would let the terminal grow past
 * the bottom of the screen.
 */
function useExtent(): {
  readonly extent: { width: number; height: number };
  readonly frame: React.RefObject<HTMLDivElement | null>;
} {
  const [extent, setExtent] = useState({ width: 0, height: 0 });
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = frame.current;
    // jsdom implements neither, and the observer is an enhancement: without
    // it the minimums still hold, only the far edge stops being enforced.
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setExtent({ width: box.width, height: box.height });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return { extent, frame };
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
