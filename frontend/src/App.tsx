import { useCallback, useEffect, useState } from "react";
import { StreamEndpoint } from "../wailsjs/go/app/App";
import { ProjectTabs } from "./components/ProjectTabs";
import { TerminalPane } from "./components/TerminalPane";
import { TerminalTabs } from "./components/TerminalTabs";
import { ProjectStatus, Workbench } from "./components/Workbench";
import { type BuildStatus, detachedBuild, loadBuild } from "./lib/build";
import type { Directory } from "./lib/directory";
import { wailsDirectory } from "./lib/directory";
import type { Files } from "./lib/files";
import { wailsFiles } from "./lib/files";
import type { Git, Status } from "./lib/git";
import { wailsGit } from "./lib/git";
import type { Kube } from "./lib/kube";
import {
  bindingSummary,
  hasBinding,
  overriddenPaths,
  scopeOf,
  settingsWithKube,
  wailsKube,
  withKube,
} from "./lib/kube";
import type { Health } from "./lib/health";
import { wailsHealth } from "./lib/health";
import { useHealth } from "./lib/useHealth";
import { useKube } from "./lib/useKube";
import { usePipeline } from "./lib/usePipeline";
import { FolderDialog } from "./components/FolderBinding";
import { Pipeline } from "./components/PipelineDialog";
import { ProjectPanel } from "./components/ProjectPanel";
import type { Project, Registry } from "./lib/projects";
import { findProject, projectLabel, wailsRegistry } from "./lib/projects";
import { useProjects } from "./lib/useProjects";
import type { SessionStore } from "./lib/session";
import { wailsSession } from "./lib/session";
import { useSession } from "./lib/useSession";
import type { Endpoint } from "./lib/stream";
import type { Appearance } from "./lib/theme";
import { clampFontSize, preferredAppearance, watchAppearance } from "./lib/theme";
import { BuildLine, FontSize } from "./components/StatusBar";
import { NO_BLAME, useBlame } from "./lib/useBlame";
import type { EditorTab } from "./lib/editorTabs";
import { useEditorTabs } from "./lib/useEditorTabs";
import { useFileTree } from "./lib/useFileTree";
import { useGitOps } from "./lib/useGitOps";
import { useGitStatus } from "./lib/useGitStatus";
import { useTerminals } from "./lib/useTerminals";
import { Breadcrumb } from "./components/Breadcrumb";
import { EditorPane } from "./components/EditorPane";
import { EditorTabs } from "./components/EditorTabs";
import { ViewToolbar } from "./components/ViewToolbar";

const initialStatus: BuildStatus = { info: detachedBuild, attached: false };

/** The line typed into a fresh shell by the "Claude Code" action. */
const CLAUDE_COMMAND = "claude";

/**
 * The backend seams the workbench reads through — one per service that has
 * one (DESIGN.md §3.2).
 *
 * They are one object rather than one prop each because the list grows with
 * every service that lands, and a prop apiece grows this component's
 * branching with it: a defaulted parameter is a decision point, so the fourth
 * service to arrive is what pushes `App` past the complexity ceiling. A test
 * overrides the seam it cares about and inherits the rest.
 */
export interface Backend {
  readonly registry: Registry;
  readonly directory: Directory;
  readonly files: Files;
  readonly git: Git;
  readonly session: SessionStore;
  readonly kube: Kube;
  readonly health: Health;
}

/** Every seam backed by its generated Wails binding. */
export const wailsBackend: Backend = {
  registry: wailsRegistry,
  directory: wailsDirectory,
  files: wailsFiles,
  git: wailsGit,
  session: wailsSession,
  kube: wailsKube,
  health: wailsHealth,
};

export interface AppProps {
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  load?: typeof loadBuild;
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  endpoint?: () => Promise<Endpoint>;
  /** Overrides for individual backend seams; each one not given is the Wails
   * binding. */
  backend?: Partial<Backend>;
}

/**
 * The project workbench (DESIGN.md §5).
 *
 * Projects are the organizing unit: a top-level tab each, and inside one, the
 * three-pane layout with terminals rooted at the checkout. The terminal state
 * lives above the project tabs deliberately — see `useTerminals`.
 */
export default function App({
  load = loadBuild,
  endpoint = StreamEndpoint,
  backend,
}: AppProps) {
  const { registry, directory, files, git, session, kube, health } = {
    ...wailsBackend,
    ...backend,
  };

  const [build, setBuild] = useState<BuildStatus>(initialStatus);
  const [stream, setStream] = useState<Endpoint | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const projects = useProjects(registry);

  const [appearance, setAppearance] = useState<Appearance>(preferredAppearance);

  const terminals = useTerminals(projects.activeName);
  const editors = useEditorTabs(projects.activeName, stream, files);

  useEffect(() => {
    let current = true;
    void load().then((next) => {
      if (current) {
        setBuild(next);
      }
    });
    return () => {
      current = false;
    };
  }, [load]);

  useEffect(() => {
    let current = true;
    // An async body rather than .then: the generated binding throws
    // synchronously when there is no Wails runtime behind it, and a UI with no
    // terminals has to say why rather than take the whole render down.
    void (async () => {
      try {
        const next = await endpoint();
        if (current) {
          setStream(next);
        }
      } catch (error: unknown) {
        if (current) {
          setStreamError(describe(error));
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [endpoint]);

  // Appearance follows the OS and has no in-app override: theme belongs in a
  // settings dialog, not in a button on the chrome. Following it live is what
  // makes removing that button a fix rather than a regression — otherwise
  // switching the OS to dark would leave m6t the only light window on screen
  // until it was restarted.
  useEffect(() => watchAppearance(setAppearance), []);

  const active = projects.active;
  // One binding for both hooks: they take the same path, and computing it
  // twice is two more branches in a component that has a ceiling on them.
  const activePath = active?.path ?? null;
  const tree = useFileTree(activePath, stream, directory);
  const gitStatus = useGitStatus(activePath, stream, git);

  const handleRemove = useCallback(
    (name: string) => {
      // Everything the project was holding goes with it. Its terminal and
      // editor panes would otherwise stay mounted for the life of the app with
      // no tab left to reach them, and its retained tree and status would sit
      // in maps nothing can reach either. The two halves are keyed
      // differently: a pane belongs to a project by name, and a listing or a
      // status belongs to the checkout it was read from.
      terminals.closeProject(name);
      editors.closeProject(name);
      const removed = findProject(projects.list, name);
      if (removed !== null) {
        tree.closeProject(removed.path);
        gitStatus.closeProject(removed.path);
      }
      projects.remove(name);
    },
    [projects, terminals, editors, tree, gitStatus],
  );

  // The write half re-reads through the read half: an operation refreshes the
  // status it changed rather than reporting one of its own, so the panel has
  // one source for what the repository looks like (PROTOCOL.md §5, `git`).
  const gitOps = useGitOps(activePath, gitStatus.refresh, git);

  // Everything Kubernetes in the panel follows what is on screen rather than
  // what the project defaults to. `aim` is what turns the open tab into the two
  // paths those sections need — see its own comment for why they differ.
  const openTab =
    editors.visible.find((tab) => tab.key === editors.activeKey) ?? null;
  const { file: openFile, folder: selection } = aim(openTab);
  const cluster = useKube(
    { project: projects.activeName, rel: selection },
    kube,
  );

  // The folder whose override is being edited, by repository-relative path, or
  // null when no dialog is open. It belongs to the active project: the tree
  // that opened it is the active project's, and a project switch closes it
  // rather than leaving a dialog writing into a repository nobody is looking
  // at.
  const [bindingFolder, setBindingFolder] = useState<string | null>(null);
  useEffect(() => {
    setBindingFolder(null);
  }, [projects.activeName]);

  // Live cluster health for the file on screen (#12).
  const clusterHealth = useHealth(
    { project: projects.activeName, root: activePath, file: openFile },
    stream,
    health,
  );

  // The diff → apply pipeline (#11). It is declared beside the binding it is
  // aimed with rather than inside the workbench: a run outlives the tree row
  // that started it, and its log belongs to the project rather than to the
  // pane the user happened to be looking at.
  const pipeline = usePipeline(projects.activeName, kube);

  // Declared after every hook it restores into, so that in any commit their
  // effects have run before its own: a restore seeds a project's tree on its
  // first activation, and the tree's own effects are what list what it opens.
  const { workspace, setWorkspace } = useSession({
    projects,
    editors,
    terminals,
    tree,
    store: session,
  });

  const handleOpenFile = useCallback(
    (path: string) => {
      if (active !== null) {
        editors.open(active.name, active.path, path);
      }
    },
    [active, editors],
  );

  return (
    <main className={`shell shell--${appearance}`}>
      <ProjectTabs
        projects={projects.list}
        activeName={projects.activeName}
        pending={projects.pending}
        onSelect={projects.select}
        onRename={projects.rename}
        onColor={projects.recolor}
        onMove={projects.move}
        onRemove={handleRemove}
        onAdd={projects.beginAdd}
        onAddCommit={projects.commitAdd}
        onAddCancel={projects.cancelAdd}
      />

      {projects.error !== null && (
        <p className="shell__error" role="alert">
          {projects.error}
        </p>
      )}

      {active === null ? (
        <p className="panes__empty">
          No project open. Add a repository to get started.
        </p>
      ) : (
        <>
          <Workbench
            tree={tree}
            git={gitStatus}
            gitOps={gitOps}
            onOpenFile={handleOpenFile}
            panes={workspace}
            onPanes={setWorkspace}
            editor={
              <Editor
                project={active}
                editors={editors}
                status={gitStatus.status}
                git={git}
                onLocate={tree.locate}
                appearance={appearance}
                onReveal={tree.reveal}
              />
            }
            terminals={
              <Terminals
                project={active}
                stream={stream}
                streamError={streamError}
                terminals={terminals}
                fontSize={workspace.fontSize}
                appearance={appearance}
              />
            }
            overridden={overriddenPaths(active)}
            onBind={setBindingFolder}
            bound={hasBinding(active)}
            onCluster={(path, action) => {
              pipeline.start(action, path);
            }}
            cluster={
              <ProjectPanel
                project={active}
                kube={cluster}
                seam={kube}
                scope={selection}
                onOverride={async (context, namespace, guarded) => {
                projects.replace(
                  await kube.bindFolder(active.name, selection, context, namespace, guarded),
                );
                cluster.refresh();
              }}
              onDefault={async (context, namespace, guarded) => {
                  await projects.rebind(
                    active.name,
                    settingsWithKube(
                      active,
                      withKube(active, {
                        context,
                        namespace,
                        protected: guarded,
                      }),
                    ),
                  );
                  // The panel is showing a binding resolved before the write.
                  // Asking again is what makes the new context appear without a
                  // reload — and asking rather than assuming is what keeps the
                  // displayed binding the backend's answer rather than the
                  // form's.
                  cluster.refresh();
                }}
                runs={pipeline.log}
                health={clusterHealth}
              />
            }
          />

          <Pipeline controller={pipeline} />

          {bindingFolder !== null && (
            <FolderDialog
              project={active}
              folder={bindingFolder}
              inherited={bindingSummary(cluster.binding)}
            inheritedContext={cluster.binding.context}
              contexts={cluster.contexts}
              kube={kube}
              onWritten={(written) => {
                projects.replace(written);
                cluster.refresh();
              }}
              onClose={() => {
                setBindingFolder(null);
              }}
            />
          )}
        </>
      )}

      <footer className="statusbar">
        <ProjectStatus
          project={active}
          git={gitStatus}
          binding={cluster.binding}
        />
        <span className="statusbar__spacer" />
        <BuildLine build={build} />
        <FontSize
          size={workspace.fontSize}
          onChange={(px) => {
            setWorkspace({ fontSize: clampFontSize(px) });
          }}
        />
      </footer>
    </main>
  );
}

interface EditorProps {
  readonly project: Project;
  readonly editors: ReturnType<typeof useEditorTabs>;
  /** This project's git status (#8): what decides whether a file has a blame
   * column to offer (#52). */
  readonly status: Status;
  /** The git seam, for the blame the column shows (#52). */
  readonly git: Git;
  /** Selects the open file in the tree — `FileTreeController.locate` (#56). */
  onLocate: (path: string) => void;
  readonly appearance: Appearance;
  /** What a breadcrumb segment opens in the tree (#43). */
  onReveal: (dir: string) => void;
}

/**
 * The editor strip and its panes for one project.
 *
 * Every tab in the app is rendered here, not only the active project's, for
 * the reason `Terminals` gives about shells and one of its own: a pane that
 * unmounted on a project switch would drop its CodeMirror view, and with it
 * the undo history behind whatever unsaved work the tab is holding.
 */
function Editor({
  project,
  editors,
  status,
  git,
  onLocate,
  appearance,
  onReveal,
}: EditorProps) {
  // The strip's own tabs, not every project's: the breadcrumb describes what
  // is on screen, and `activeKey` is per project.
  const active =
    editors.visible.find((tab) => tab.key === editors.activeKey) ?? null;
  // One blame, for the file on screen. See useBlame for why it is not per tab.
  const blame = useBlame(active, git);

  return (
    <>
      <EditorTabs
        tabs={editors.visible}
        activeKey={editors.activeKey}
        onSelect={editors.select}
        onClose={editors.close}
        onSave={editors.save}
        onPreview={(key, preview) => {
          editors.setMode(key, preview ? "preview" : "edit");
        }}
      />

      <Breadcrumb tab={active} onReveal={onReveal} />

      <ViewToolbar
        tab={active}
        status={status}
        onLocate={onLocate}
        onToggleBlame={editors.setBlame}
      />

      <div className="editor-panes">
        {editors.tabs.map((tab) => (
          <EditorPane
            key={tab.key}
            tab={tab}
            active={tab.key === editors.activeKey}
            appearance={appearance}
            blame={tab.key === editors.activeKey ? blame : NO_BLAME}
            onChange={editors.edit}
            onSave={(key) => {
              void editors.save(key);
            }}
            onKeepMine={editors.keepMine}
            onTakeDisk={editors.takeDisk}
          />
        ))}
        {editors.visible.length === 0 && (
          <p className="panes__empty">
            No file open in {projectLabel(project)}. Pick one from the tree to
            start editing.
          </p>
        )}
      </div>
    </>
  );
}

interface TerminalsProps {
  readonly project: Project;
  readonly stream: Endpoint | null;
  readonly streamError: string | null;
  readonly terminals: ReturnType<typeof useTerminals>;
  readonly fontSize: number;
  readonly appearance: Appearance;
}

/**
 * The terminal strip and its panes for one project.
 *
 * Every tab in the app is rendered here, not only the active project's: a pane
 * that unmounted on a project switch would detach its shell. The strip shows
 * the active project's tabs; the panes hidden by `active` are the rest.
 */
function Terminals({
  project,
  stream,
  streamError,
  terminals,
  fontSize,
  appearance,
}: TerminalsProps) {
  return (
    <>
      <TerminalTabs
        tabs={terminals.visible}
        activeKey={terminals.activeKey}
        onSelect={terminals.select}
        onClose={terminals.close}
        onRename={terminals.rename}
        onCreate={() => {
          terminals.create(project.name, project.path, null);
        }}
        onCreateClaude={() => {
          terminals.create(project.name, project.path, CLAUDE_COMMAND);
        }}
      />

      <div className="panes">
        {stream === null ? (
          <p className="panes__empty" data-testid="stream-status">
            {streamError ?? "connecting to the terminal backend…"}
          </p>
        ) : (
          terminals.tabs.map((tab) => (
            <TerminalPane
              key={`${tab.key}:${String(tab.generation)}`}
              tab={tab}
              endpoint={stream}
              active={tab.key === terminals.activeKey}
              fontSize={fontSize}
              appearance={appearance}
              onStatus={terminals.onStatus}
              onRestart={terminals.restart}
              onAttach={terminals.onAttach}
              onDetach={terminals.onDetach}
            />
          ))
        )}
        {stream !== null && terminals.visible.length === 0 && (
          <p className="panes__empty">
            No terminals open in {projectLabel(project)}. Open a shell to get
            started.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * What the panel's Kubernetes sections are aimed at.
 *
 * Two paths out of one tab, because the sections ask different questions. The
 * binding sections ask "where does this go", which a scope answers for a
 * subtree, so they take the folder — `scopeOf` is the reduction, and a file
 * inherits from its directory, which is the whole of how a folder binding
 * works. The health section asks "what is there now", and answers it for the
 * one file: a subtree's worth of object rows is a list whose interesting row is
 * off the bottom of a 280px pane.
 *
 * The two still agree about the cluster. A scope covers whole path segments, so
 * a file resolves to exactly what its folder resolves to.
 */
function aim(tab: EditorTab | null): { file: string | null; folder: string } {
  if (tab === null) {
    return { file: null, folder: "" };
  }
  return { file: tab.path, folder: scopeOf(tab.path) };
}

/** Renders a rejected binding call as a sentence the status line can show. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string"
    ? error
    : "the terminal backend is not reachable";
}
