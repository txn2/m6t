import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FileTree } from "./FileTree";
import type { PipelineAction } from "../lib/pipeline";
import { BranchBar } from "./BranchBar";
import { PaneSeparator } from "./PaneSeparator";
import type { Project } from "../lib/projects";
import { projectLabel } from "../lib/projects";
import type { Binding } from "../lib/kube";
import { bindingSummary } from "../lib/kube";
import { UiIcon } from "./Icon";
import type { FileTreeController } from "../lib/useFileTree";
import type { GitStatusController } from "../lib/useGitStatus";
import type { GitOpsController } from "../lib/useGitOps";
import { branchSummary } from "../lib/gitStatus";
import {
  CLUSTER_MIN,
  EDITOR_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  SIDEBAR_MIN,
  TERMINAL_MIN,
  clampSplit,
} from "../lib/panes";

export interface WorkbenchProps {
  /** The file tree's state and operations for this project (#6). */
  readonly tree: FileTreeController;
  /** This project's git status (#8, #40): the tree draws it, and the status
   * bar reports what is wrong with it. */
  readonly git: GitStatusController;
  /** The mutating git loop for this project (#9): pull, push, branch switch.
   * Staging and committing are the terminal agent's, not m6t's (#39). */
  readonly gitOps: GitOpsController;
  /** The open-file intent a tree selection emits; the editor strip acts on it. */
  readonly onOpenFile: (path: string) => void;
  /** The editor strip and panes for this project (#7). */
  readonly editor: ReactNode;
  /** The terminal strip and panes for this project. */
  readonly terminals: ReactNode;
  /** The project panel for this project (#10): the Kubernetes binding, the
   * folder overrides it carries, and — once #12 lands — the live status of
   * what is on screen. */
  readonly cluster: ReactNode;
  /** The folders carrying a kube override, for the tree to mark (#10). */
  readonly overridden: ReadonlySet<string>;
  /** Opens the Kubernetes binding dialog for a folder (#10). */
  readonly onBind: (path: string) => void;
  /** Whether this project reaches a cluster, which gates the tree's pipeline
   * entries (#11). */
  readonly bound: boolean;
  /** Starts a pipeline run from a tree row (#11). */
  readonly onCluster: (path: string, action: PipelineAction) => void;
  /**
   * The two split sizes, in pixels, and how a change to them is reported.
   *
   * They are the caller's rather than this component's because they outlive it:
   * the session restores them at launch and records them as they are dragged
   * (#58), and a workbench that owned them would reset both every time the
   * project strip had no project to show.
   */
  readonly panes: PaneSizes;
  readonly onPanes: (next: PaneSizes) => void;
}

/** The workbench's three split sizes, in pixels. */
export interface PaneSizes {
  readonly sidebar: number;
  readonly terminalHeight: number;
  readonly cluster: number;
}

/**
 * The per-project workbench (DESIGN.md §5): file tree, editor, terminal.
 *
 * All three are real: the tree is #6's, the editor is #7's, and the terminal
 * is #4's, rooted at this project's checkout.
 *
 * The sidebar is the tree and the branch bar, and nothing else (#40). The
 * changes list that used to sit under them said what the tree already knew,
 * in a second place, for a fixed share of the sidebar's height — the tree
 * now colours the changed paths where they live and filters down to them on
 * demand, and the two states the list also reported (no git, not a
 * repository) are the status bar's, where they are visible whatever the
 * sidebar is showing.
 */
export function Workbench({
  tree,
  git,
  gitOps,
  onOpenFile,
  editor,
  terminals,
  cluster,
  overridden,
  onBind,
  bound,
  onCluster,
  panes,
  onPanes,
}: WorkbenchProps) {
  const { sidebar, terminalHeight, cluster: clusterWidth } = panes;
  const { extent, frame } = useExtent();

  const setSidebar = (next: number) => {
    onPanes({ ...panes, sidebar: next });
  };
  const setTerminalHeight = (next: number) => {
    onPanes({ ...panes, terminalHeight: next });
  };
  const setCluster = (next: number) => {
    onPanes({ ...panes, cluster: next });
  };

  // A size can arrive too large for the window it is being drawn in: a session
  // saved on a docked display, restored on the laptop alone. The separators
  // clamp what a drag produces, which never runs for a size nobody dragged, so
  // the same bounds are applied here the moment the workbench knows how big it
  // is — and again whenever that changes, which is also what stops a pane from
  // keeping a width the window no longer has after being shrunk.
  useEffect(() => {
    const fitted = fit(panes, extent);
    if (
      fitted.sidebar !== sidebar ||
      fitted.terminalHeight !== terminalHeight ||
      fitted.cluster !== clusterWidth
    ) {
      onPanes(fitted);
    }
  }, [panes, extent, sidebar, terminalHeight, clusterWidth, onPanes]);

  return (
    <div
      ref={frame}
      className="workbench"
      style={
        {
          "--m6t-sidebar": `${String(sidebar)}px`,
          "--m6t-terminal": `${String(terminalHeight)}px`,
          "--m6t-cluster": `${String(clusterWidth)}px`,
        } as CSSProperties
      }
    >
      <aside className="workbench__tree">
        <FileTree
          tree={tree}
          status={git.status}
          onOpenFile={onOpenFile}
          overridden={overridden}
          onBind={onBind}
          bound={bound}
          onCluster={onCluster}
        />
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
      </aside>

      <PaneSeparator
        orientation="vertical"
        size={sidebar}
        direction={1}
        bounds={{ min: SIDEBAR_MIN, minOther: EDITOR_MIN_WIDTH, total: extent.width }}
        label="Sidebar width"
        area="sidebar"
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
        area="terminal"
        onResize={setTerminalHeight}
      />

      <section className="workbench__terminal" aria-label="Terminal">
        {terminals}
      </section>

      {/* The cluster panel leads its separator from the right edge, so
          dragging left grows it — direction -1, the terminal's rule on the
          other axis. */}
      <PaneSeparator
        orientation="vertical"
        size={clusterWidth}
        direction={-1}
        bounds={{ min: CLUSTER_MIN, minOther: EDITOR_MIN_WIDTH, total: extent.width }}
        label="Cluster panel width"
        area="cluster"
        onResize={setCluster}
      />

      <aside className="workbench__cluster" aria-label="Project">
        {cluster}
      </aside>
    </div>
  );
}

/** Both splits held inside the bounds an extent allows — `clampSplit`'s rules,
 * applied to a pair. An unmeasured extent drops the upper bound, which is what
 * keeps the minimums working in jsdom and in the first frame. */
export function fit(
  panes: PaneSizes,
  extent: { readonly width: number; readonly height: number },
): PaneSizes {
  return {
    sidebar: clampSplit(panes.sidebar, {
      min: SIDEBAR_MIN,
      minOther: EDITOR_MIN_WIDTH,
      total: extent.width,
    }),
    terminalHeight: clampSplit(panes.terminalHeight, {
      min: TERMINAL_MIN,
      minOther: EDITOR_MIN_HEIGHT,
      total: extent.height,
    }),
    // Clamped against the width the sidebar has already taken, not against the
    // window: three panes on one axis means the editor's minimum has to survive
    // both neighbours, and clamping each against the full width would let the
    // two of them squeeze it to nothing between them.
    cluster: clampSplit(panes.cluster, {
      min: CLUSTER_MIN,
      minOther: EDITOR_MIN_WIDTH,
      total: extent.width === 0 ? 0 : extent.width - panes.sidebar,
    }),
  };
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
  /** What the current selection is bound to (#10) — resolved by the backend,
   * so it is the binding a kubectl call would actually use rather than the
   * project default the frontend happens to be holding. */
  readonly binding: Binding;
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
 *
 * What it names is the binding for the *selection*, not for the project. In a
 * repository laid out one directory per cluster those differ, and the status
 * bar showing a project default while the editor holds a file bound elsewhere
 * would be the most misleading line in the window (#10).
 */
export function ProjectStatus({ project, git, binding }: ProjectStatusProps) {
  if (project === null) {
    return <span data-testid="project-status">no project selected</span>;
  }
  // The label, not the key: the status bar names the project the user named,
  // and the registry's own name for it is a directory basename they never
  // chose (#41).
  const label = projectLabel(project);
  return (
    <>
      <span
        data-testid="project-status"
        data-protected={binding.protected ? "true" : undefined}
      >
        {`${label}: ${bindingSummary(binding)}`}
        {binding.protected && <UiIcon name="lock" />}
      </span>
      <span data-testid="git-status">
        {git.error ?? branchSummary(git.status)}
      </span>
    </>
  );
}
