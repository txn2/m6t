import { SaveSession, SessionState } from "../../wailsjs/go/app/App";
import { session as models } from "../../wailsjs/go/models";
import type { session } from "../../wailsjs/go/models";
import type { EditorMode, EditorTab } from "./editorTabs";
import {
  CLUSTER_DEFAULT,
  CLUSTER_MIN,
  EDITOR_MIN_HEIGHT,
  EDITOR_MIN_WIDTH,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  TERMINAL_DEFAULT,
  TERMINAL_MIN,
  clampSplit,
} from "./panes";
import type { TerminalTab } from "./tabs";
import { DEFAULT_FONT_SIZE, clampFontSize } from "./theme";
import type { RestoredTree, TreeState } from "./tree";

/**
 * The workspace session as the UI uses it (#58): what was on screen when m6t
 * was last closed, and the arithmetic that turns it back into the state the
 * hooks hold.
 *
 * Everything here is either a pure function over a saved session or a thin seam
 * over the Wails bindings, the same split `lib/projects.ts` uses — which is what
 * makes restoring testable without a backend, and matters more here than
 * elsewhere: every rule below exists for a workspace that changed while the app
 * was closed, and none of those cases are reachable by clicking around.
 */

/**
 * The saved shapes, aliased from the generated bindings rather than restated: a
 * change to the Go struct fails type-checking here instead of disagreeing with
 * it silently.
 */
export type Session = session.State;
export type ProjectSession = session.Project;

/**
 * The session operations the UI performs. An interface so tests can drive
 * restoring and saving without a Wails runtime, in the shape `Registry` and the
 * other seams already use.
 */
export interface SessionStore {
  load: () => Promise<Session>;
  save: (state: Session) => Promise<void>;
}

/** The session store backed by the Wails bindings. */
export const wailsSession: SessionStore = {
  load: () => SessionState(),
  save: (state) => SaveSession(state),
};

/**
 * A session with nothing in it: what a first launch restores from.
 *
 * No version. The schema number is internal/session's — it stamps every write
 * with the one this build reads, so a copy of it here would be a second answer
 * to the same question that could only ever be wrong.
 */
export function emptySession(): Session {
  return models.State.createFrom({ projects: [] });
}

/**
 * One project's saved record, or null when there is none.
 *
 * Go marshals an empty slice as `null`, so every list read out of a session has
 * to survive being absent — which is also what a record written by a build with
 * fewer fields than this one looks like.
 */
export function projectSession(state: Session, name: string): ProjectSession | null {
  return (state.projects ?? []).find((record) => record.name === name) ?? null;
}

/** The window-wide settings, with every number held inside the bounds the UI
 * actually enforces. */
export interface RestoredWorkspace {
  readonly activeProject: string | null;
  readonly fontSize: number;
  readonly sidebar: number;
  readonly terminalHeight: number;
  readonly cluster: number;
  readonly changedOnly: boolean;
}

/**
 * The window-wide settings a session restores to.
 *
 * The clamping is here rather than in the Go store on purpose: how narrow a
 * sidebar may be and how small a font may be are the frontend's rules, held in
 * `panes.ts` and `theme.ts`, and a second copy of them in the backend would be
 * two answers to one question. A zero is read as "not recorded" rather than
 * clamped up to a minimum, so a session written before a field existed restores
 * that field's default instead of its floor.
 *
 * The far edge is deliberately not clamped here — `total: 0` is `clampSplit`'s
 * "not measured" — because the window's size is not known until the workbench
 * has been laid out. The workbench clamps against its own extent once it has
 * one, which is also what catches a session saved on a larger display.
 */
export function restoredWorkspace(state: Session): RestoredWorkspace {
  const active = state.activeProject ?? "";
  return {
    activeProject: active === "" ? null : active,
    fontSize: clampFontSize(recorded(state.fontSize, DEFAULT_FONT_SIZE)),
    sidebar: clampSplit(recorded(state.sidebar, SIDEBAR_DEFAULT), {
      min: SIDEBAR_MIN,
      minOther: EDITOR_MIN_WIDTH,
      total: 0,
    }),
    terminalHeight: clampSplit(recorded(state.terminalHeight, TERMINAL_DEFAULT), {
      min: TERMINAL_MIN,
      minOther: EDITOR_MIN_HEIGHT,
      total: 0,
    }),
    cluster: clampSplit(recorded(state.clusterWidth, CLUSTER_DEFAULT), {
      min: CLUSTER_MIN,
      minOther: EDITOR_MIN_WIDTH,
      total: 0,
    }),
    changedOnly: state.changedOnly ?? false,
  };
}

/** A recorded size, or the default when there is none. Zero is the absence of
 * a value rather than a size — it is what a field written before it existed
 * decodes to — so it takes the default rather than being clamped up to a
 * floor. */
function recorded(value: number | undefined, fallback: number): number {
  return value === undefined || value === 0 ? fallback : value;
}

/** One editor tab to reopen. */
export interface RestoredEditor {
  readonly path: string;
  readonly mode: EditorMode;
}

/** The editor strip a project restores to. */
export interface RestoredEditors {
  readonly files: readonly RestoredEditor[];
  /** The path to focus, or null to focus the first tab that opens. */
  readonly active: string | null;
}

/**
 * The editor tabs a record reopens.
 *
 * The mode is narrowed here rather than trusted: the store carries whatever
 * string the editor last wrote, because which modes exist is the editor's
 * business, and this is the one place that knows the answer.
 */
export function restoredEditors(record: ProjectSession | null): RestoredEditors {
  const files = (record?.editors ?? []).map((editor) => ({
    path: editor.path,
    mode: editor.mode === "preview" ? ("preview" as EditorMode) : ("edit" as EditorMode),
  }));
  return { files, active: record?.activeEditor ? record.activeEditor : null };
}

/** One terminal tab to reopen. */
export interface RestoredTerminal {
  readonly title: string;
  readonly cwd: string;
}

/** The terminal strip a project restores to. */
export interface RestoredTerminals {
  readonly tabs: readonly RestoredTerminal[];
  /** Which tab to focus, as a position in `tabs`. */
  readonly active: number;
}

/**
 * The terminal tabs a record reopens, rooted at `root` where the recorded
 * directory is gone.
 *
 * internal/session clears a cwd whose directory no longer exists, and this is
 * the substitution it leaves to the frontend: the project root is the only
 * other place a tab could sensibly open, and it is a value the backend would
 * have had to duplicate the registry to know.
 */
export function restoredTerminals(
  record: ProjectSession | null,
  root: string,
): RestoredTerminals {
  const tabs = (record?.terminals ?? []).map((terminal) => ({
    title: terminal.title,
    cwd: terminal.cwd === "" ? root : terminal.cwd,
  }));
  const active = record?.activeTerminal ?? 0;
  return { tabs, active: active >= 0 && active < tabs.length ? active : 0 };
}

/**
 * The tree shape a record restores, with the window-wide changed-files filter
 * folded in.
 *
 * `changedOnly` comes from the workspace rather than the record because the
 * tree treats it as a property of how the user is working and carries it across
 * a project switch. Restoring a per-project copy would make switching projects
 * turn the filter off, which is the behaviour the tree deliberately does not
 * have.
 */
export function restoredTree(record: ProjectSession | null, changedOnly: boolean): RestoredTree {
  const selected = record?.treeSelected ?? "";
  return {
    expanded: record?.treeExpanded ?? [],
    selected: selected === "" ? null : selected,
    showHidden: record?.treeShowHidden ?? false,
    changedOnly,
  };
}

/**
 * The live workspace a snapshot is taken from: the window-wide settings, and
 * the active project's three strips.
 *
 * Only the active project's, and that is the whole reason this stays small. A
 * project's editor tabs and terminals cannot change while it is not the one on
 * screen — the strips show the active project and nothing else — so every other
 * project's record is already correct in the previous snapshot, and reading
 * them would mean widening three hooks to expose per-project selections that
 * nothing else needs.
 */
export interface LiveSession {
  readonly activeProject: string | null;
  readonly fontSize: number;
  readonly sidebar: number;
  readonly terminalHeight: number;
  readonly cluster: number;
  readonly editors: readonly EditorTab[];
  readonly activeEditor: string | null;
  readonly terminals: readonly TerminalTab[];
  readonly activeTerminal: string | null;
  readonly tree: TreeState;
}

/**
 * The session to save, given the last one and what is on screen now.
 *
 * `hydrated` names the projects whose records have already been restored into
 * the live hooks this session. It is what stops the snapshot from recording
 * emptiness as fact: a project that has just become active has no tabs open
 * *yet*, and writing that would delete the tabs it was about to get back.
 *
 * `registered` prunes: a project that is no longer in the registry loses its
 * record. When the registry has not answered yet its list is empty, and an
 * empty list leaves every record alone rather than clearing the file — the
 * difference between "there are no projects" and "we do not know yet" is one
 * the registry can report and this cannot.
 */
export function nextSession(
  previous: Session,
  live: LiveSession,
  hydrated: ReadonlySet<string>,
  registered: readonly string[],
): Session {
  const names =
    registered.length > 0 ? registered : (previous.projects ?? []).map((record) => record.name);

  const projects = names
    .map((name) => recordFor(name, previous, live, hydrated))
    .filter((record): record is ProjectSession => record !== null);

  return models.State.createFrom({
    // Echoed rather than asserted: see emptySession.
    version: previous.version,
    activeProject: live.activeProject ?? "",
    fontSize: live.fontSize,
    sidebar: live.sidebar,
    terminalHeight: live.terminalHeight,
    clusterWidth: live.cluster,
    changedOnly: live.tree.changedOnly,
    projects,
  });
}

/** One project's record: what is on screen if this is the project on screen,
 * and what was last recorded otherwise. */
function recordFor(
  name: string,
  previous: Session,
  live: LiveSession,
  hydrated: ReadonlySet<string>,
): ProjectSession | null {
  if (name === live.activeProject && hydrated.has(name)) {
    return liveRecord(name, live);
  }
  return projectSession(previous, name);
}

/** The active project's record, read off the live strips. */
function liveRecord(name: string, live: LiveSession): ProjectSession {
  const active = live.editors.find((tab) => tab.key === live.activeEditor) ?? null;
  return models.Project.createFrom({
    name,
    editors: live.editors.map((tab) => ({ path: tab.path, mode: tab.mode })),
    activeEditor: active?.path ?? "",
    terminals: live.terminals.map((tab) => ({ title: tab.title, cwd: tab.cwd })),
    activeTerminal: Math.max(
      0,
      live.terminals.findIndex((tab) => tab.key === live.activeTerminal),
    ),
    treeExpanded: [...live.tree.expanded],
    treeSelected: live.tree.selected ?? "",
    treeShowHidden: live.tree.showHidden,
  });
}

/** Whether two sessions would be the same file, which is what decides if a
 * change is worth a write. */
export function sameSession(a: Session, b: Session): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
