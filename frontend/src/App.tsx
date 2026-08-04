import { useCallback, useEffect, useState } from "react";
import { StreamEndpoint } from "../wailsjs/go/app/App";
import { ProjectTabs } from "./components/ProjectTabs";
import { TerminalPane } from "./components/TerminalPane";
import { TerminalTabs } from "./components/TerminalTabs";
import { Toolbar } from "./components/Toolbar";
import { ProjectStatus, Workbench } from "./components/Workbench";
import { type BuildStatus, detachedBuild, loadBuild } from "./lib/build";
import type { Project, Registry } from "./lib/projects";
import {
  findProject,
  selectionAfterReload,
  selectionAfterRemove,
  wailsRegistry,
} from "./lib/projects";
import type { Endpoint } from "./lib/stream";
import type { Appearance } from "./lib/theme";
import {
  DEFAULT_FONT_SIZE,
  clampFontSize,
  preferredAppearance,
} from "./lib/theme";
import { useTerminals } from "./lib/useTerminals";

const initialStatus: BuildStatus = { info: detachedBuild, attached: false };

/** The line typed into a fresh shell by the "Claude Code" action. */
const CLAUDE_COMMAND = "claude";

export interface AppProps {
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  load?: typeof loadBuild;
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  endpoint?: () => Promise<Endpoint>;
  /** Injectable for tests and harnesses; defaults to the Wails bindings. */
  registry?: Registry;
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
  registry = wailsRegistry,
}: AppProps) {
  const [build, setBuild] = useState<BuildStatus>(initialStatus);
  const [stream, setStream] = useState<Endpoint | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);

  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [appearance, setAppearance] = useState<Appearance>(preferredAppearance);

  const terminals = useTerminals(activeProject);

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

  const reload = useCallback(async () => {
    try {
      const listed = await registry.list();
      setProjects(listed);
      setActiveProject((active) => selectionAfterReload(listed, active));
      setProjectError(null);
    } catch (error: unknown) {
      // A registry that will not load is shown, never swallowed: an empty strip
      // would read as "you have no projects" when the truth is a broken
      // projects.yaml the user has to go fix.
      setProjectError(describe(error));
    }
  }, [registry]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Browse, then register. The picker returns "" when the user dismisses it,
  // which ends the flow silently — a cancelled dialog is not a failure and must
  // not leave an error on screen.
  const handleAdd = useCallback(() => {
    setProjectError(null);
    void (async () => {
      try {
        const chosen = await registry.choose();
        if (chosen === "") {
          return;
        }
        const added = await registry.add(chosen);
        await reload();
        setActiveProject(added.name);
      } catch (error: unknown) {
        setProjectError(describe(error));
      }
    })();
  }, [registry, reload]);

  const handleRemove = useCallback(
    (name: string) => {
      // The project's terminals go with it. Their panes would otherwise stay
      // mounted for the life of the app with no tab left to reach them.
      terminals.closeProject(name);
      setActiveProject((active) => selectionAfterRemove(projects, name, active));
      void (async () => {
        try {
          await registry.remove(name);
          await reload();
        } catch (error: unknown) {
          setProjectError(describe(error));
        }
      })();
    },
    [projects, registry, reload, terminals],
  );

  const active = findProject(projects, activeProject);

  return (
    <main className={`shell shell--${appearance}`}>
      <ProjectTabs
        projects={projects}
        activeName={activeProject}
        onSelect={setActiveProject}
        onRemove={handleRemove}
        onAdd={handleAdd}
      />

      <Toolbar
        fontSize={fontSize}
        onFontSize={(px) => {
          setFontSize(clampFontSize(px));
        }}
        appearance={appearance}
        onAppearance={setAppearance}
      />

      {projectError !== null && (
        <p className="shell__error" role="alert">
          {projectError}
        </p>
      )}

      {active === null ? (
        <p className="panes__empty">
          No project open. Add a repository to get started.
        </p>
      ) : (
        <Workbench
          project={active}
          terminals={
            <Terminals
              project={active}
              stream={stream}
              streamError={streamError}
              terminals={terminals}
              fontSize={fontSize}
              appearance={appearance}
            />
          }
        />
      )}

      <footer className="statusbar">
        <ProjectStatus project={active} />
        <span data-testid="build-version">{build.info.version}</span>
        <span data-testid="build-commit">{build.info.commit}</span>
        <span data-testid="build-date">{build.info.date}</span>
        <span data-testid="bridge-status">
          {build.attached
            ? "connected to the Wails backend"
            : "detached — no Wails runtime"}
        </span>
      </footer>
    </main>
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
            No terminals open in {project.name}. Open a shell to get started.
          </p>
        )}
      </div>
    </>
  );
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
