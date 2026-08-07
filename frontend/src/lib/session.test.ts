import { describe, expect, it } from "vitest";
import { session as models } from "../../wailsjs/go/models";
import { newTab as newEditorTab } from "./editorTabs";
import type { EditorTab } from "./editorTabs";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  TERMINAL_DEFAULT,
  TERMINAL_MIN,
} from "./panes";
import type { LiveSession, Session } from "./session";
import {
  emptySession,
  nextSession,
  projectSession,
  restoredEditors,
  restoredTerminals,
  restoredTree,
  restoredWorkspace,
  sameSession,
} from "./session";
import { newTab as newTerminalTab } from "./tabs";
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE } from "./theme";
import { ROOT, expand, initialTree, select, toggleHidden, withListing } from "./tree";

/** A saved session, built the way the Wails binding delivers one.
 *
 * The overrides are loose rather than `Partial<Session>` because that is what
 * the binding's own `createFrom` takes, and what a file written by another
 * build looks like: partial records, absent lists, fields this build has never
 * heard of. Typing them as complete records here would make the fixtures
 * something the app can never actually be handed. */
function session(over: Record<string, unknown> = {}): Session {
  return models.State.createFrom({ version: 1, projects: [], ...over });
}

/** The live workspace, with everything empty unless a test says otherwise. */
function live(over: Partial<LiveSession> = {}): LiveSession {
  return {
    activeProject: "infra",
    fontSize: DEFAULT_FONT_SIZE,
    sidebar: SIDEBAR_DEFAULT,
    terminalHeight: TERMINAL_DEFAULT,
    editors: [],
    activeEditor: null,
    terminals: [],
    activeTerminal: null,
    tree: initialTree(),
    ...over,
  };
}

function editorTab(key: string, path: string): EditorTab {
  return newEditorTab(key, "infra", "/w/infra", path, "yaml");
}

describe("reading a saved session", () => {
  it("finds a project's record by name", () => {
    const state = session({
      projects: [{ name: "apps", activeEditor: "a.yaml" }, { name: "infra" }],
    });

    expect(projectSession(state, "apps")?.activeEditor).toBe("a.yaml");
    expect(projectSession(state, "nothing")).toBeNull();
  });

  // Go marshals an empty slice as null, so every list has to survive being
  // absent — this is what the first launch after an upgrade looks like.
  it("survives a session whose lists are absent", () => {
    const state = models.State.createFrom({ version: 1 });

    expect(projectSession(state, "infra")).toBeNull();
    expect(restoredWorkspace(state).activeProject).toBeNull();
    expect(restoredEditors(null).files).toEqual([]);
    expect(restoredTerminals(null, "/w/infra").tabs).toEqual([]);
    expect(restoredTree(null, false).expanded).toEqual([]);
  });

  it("restores the window-wide settings", () => {
    const state = session({
      activeProject: "infra",
      fontSize: 15,
      sidebar: 340,
      terminalHeight: 200,
      changedOnly: true,
    });

    expect(restoredWorkspace(state)).toEqual({
      activeProject: "infra",
      fontSize: 15,
      sidebar: 340,
      terminalHeight: 200,
      changedOnly: true,
    });
  });

  // A field that was never recorded is a zero, and a zero is not a size — it
  // is the absence of one, and must restore the default rather than the floor.
  it("reads an unrecorded setting as its default rather than its minimum", () => {
    const restored = restoredWorkspace(session({ activeProject: "infra" }));

    expect(restored.fontSize).toBe(DEFAULT_FONT_SIZE);
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT);
    expect(restored.terminalHeight).toBe(TERMINAL_DEFAULT);
  });

  it("holds a recorded setting inside the bounds the UI enforces", () => {
    const restored = restoredWorkspace(
      session({ fontSize: 400, sidebar: 12, terminalHeight: 3 }),
    );

    expect(restored.fontSize).toBe(MAX_FONT_SIZE);
    expect(restored.sidebar).toBe(SIDEBAR_MIN);
    expect(restored.terminalHeight).toBe(TERMINAL_MIN);
  });

  it("reads a font size below the minimum as the minimum", () => {
    expect(restoredWorkspace(session({ fontSize: 2 })).fontSize).toBe(
      MIN_FONT_SIZE,
    );
  });

  it("restores editor tabs in order, narrowing the mode to one the editor has", () => {
    const record = models.Project.createFrom({
      name: "infra",
      editors: [
        { path: "a.yaml", mode: "edit" },
        { path: "notes.md", mode: "preview" },
        { path: "b.yaml", mode: "something else entirely" },
      ],
      activeEditor: "notes.md",
    });

    expect(restoredEditors(record)).toEqual({
      files: [
        { path: "a.yaml", mode: "edit" },
        { path: "notes.md", mode: "preview" },
        { path: "b.yaml", mode: "edit" },
      ],
      active: "notes.md",
    });
  });

  // internal/session clears a cwd whose directory is gone; the substitution is
  // the frontend's because the project root is the frontend's to know.
  it("opens a terminal whose directory is gone at the project root", () => {
    const record = models.Project.createFrom({
      name: "infra",
      terminals: [
        { title: "shell 1", cwd: "" },
        { title: "shell 2", cwd: "/w/infra/manifests" },
      ],
      activeTerminal: 1,
    });

    expect(restoredTerminals(record, "/w/infra")).toEqual({
      tabs: [
        { title: "shell 1", cwd: "/w/infra" },
        { title: "shell 2", cwd: "/w/infra/manifests" },
      ],
      active: 1,
    });
  });

  it("focuses the first terminal when the recorded position is not one", () => {
    const record = models.Project.createFrom({
      name: "infra",
      terminals: [{ title: "shell 1", cwd: "/w/infra" }],
      activeTerminal: 6,
    });

    expect(restoredTerminals(record, "/w/infra").active).toBe(0);
  });

  it("takes the changed-files filter from the window rather than the project", () => {
    const record = models.Project.createFrom({
      name: "infra",
      treeExpanded: ["", "manifests"],
      treeSelected: "manifests/a.yaml",
      treeShowHidden: true,
    });

    expect(restoredTree(record, true)).toEqual({
      expanded: ["", "manifests"],
      selected: "manifests/a.yaml",
      showHidden: true,
      changedOnly: true,
    });
  });
});

describe("recording a session", () => {
  const hydrated = new Set(["infra"]);

  it("records the active project's strips and settings", () => {
    const editors = [editorTab("e1", "a.yaml"), editorTab("e2", "b.yaml")];
    const terminals = [
      newTerminalTab("t1", "infra", "shell 1", "/w/infra", null),
      newTerminalTab("t2", "infra", "claude 1", "/w/infra/manifests", null),
    ];
    let tree = expand(initialTree(), "manifests");
    tree = toggleHidden(select(tree, "manifests/a.yaml"));

    const next = nextSession(
      emptySession(),
      live({
        editors,
        activeEditor: "e2",
        terminals,
        activeTerminal: "t2",
        tree,
        fontSize: 16,
        sidebar: 300,
        terminalHeight: 210,
      }),
      hydrated,
      ["infra"],
    );

    expect(next.activeProject).toBe("infra");
    expect(next.fontSize).toBe(16);
    expect(next.sidebar).toBe(300);
    expect(next.terminalHeight).toBe(210);
    expect(next.changedOnly).toBe(false);
    expect(next.projects[0]).toEqual({
      name: "infra",
      editors: [
        { path: "a.yaml", mode: "edit" },
        { path: "b.yaml", mode: "edit" },
      ],
      activeEditor: "b.yaml",
      terminals: [
        { title: "shell 1", cwd: "/w/infra" },
        { title: "claude 1", cwd: "/w/infra/manifests" },
      ],
      activeTerminal: 1,
      treeExpanded: ["", "manifests"],
      treeSelected: "manifests/a.yaml",
      treeShowHidden: true,
    });
  });

  // The strips only ever show the active project, so every other project's
  // record is already correct in the previous session — and reading them off
  // the live hooks would mean recording emptiness for projects that simply are
  // not on screen.
  it("leaves the records of projects that are not on screen alone", () => {
    const previous = session({
      projects: [
        { name: "infra", activeEditor: "a.yaml", editors: [{ path: "a.yaml", mode: "edit" }] },
        { name: "apps", activeEditor: "b.yaml", editors: [{ path: "b.yaml", mode: "edit" }] },
      ],
    });

    const next = nextSession(previous, live({ activeProject: "infra" }), hydrated, [
      "infra",
      "apps",
    ]);

    expect(projectSession(next, "apps")?.editors).toEqual([{ path: "b.yaml", mode: "edit" }]);
    expect(projectSession(next, "infra")?.editors).toEqual([]);
  });

  // The window between a project becoming active and its tabs being put back is
  // a window in which its strips are empty and its record is not.
  it("does not record a project whose tabs have not been restored yet", () => {
    const previous = session({
      projects: [{ name: "infra", editors: [{ path: "a.yaml", mode: "edit" }] }],
    });

    const next = nextSession(previous, live(), new Set(), ["infra"]);

    expect(projectSession(next, "infra")?.editors).toEqual([{ path: "a.yaml", mode: "edit" }]);
  });

  it("drops the record of a project that is no longer registered", () => {
    const previous = session({
      projects: [{ name: "infra" }, { name: "gone", editors: [{ path: "x.yaml" }] }],
    });

    const next = nextSession(previous, live(), hydrated, ["infra"]);

    expect(next.projects.map((record) => record.name)).toEqual(["infra"]);
  });

  // An empty registry list is what the app holds before the registry answers.
  // Clearing every record on the strength of it would delete the session
  // during the launch that was about to restore from it.
  it("keeps every record while the registry has not answered", () => {
    const previous = session({ projects: [{ name: "infra" }, { name: "apps" }] });

    const next = nextSession(previous, live({ activeProject: null }), new Set(), []);

    expect(next.projects.map((record) => record.name)).toEqual(["infra", "apps"]);
  });

  it("records the registry's order, so an unchanged workspace is an unchanged file", () => {
    const previous = session({ projects: [{ name: "apps" }, { name: "infra" }] });

    const next = nextSession(previous, live({ activeProject: null }), new Set(), [
      "infra",
      "apps",
    ]);

    expect(next.projects.map((record) => record.name)).toEqual(["infra", "apps"]);
  });

  it("records no active editor when the strip has no selection", () => {
    const next = nextSession(
      emptySession(),
      live({ editors: [editorTab("e1", "a.yaml")], activeEditor: null }),
      hydrated,
      ["infra"],
    );

    expect(projectSession(next, "infra")?.activeEditor).toBe("");
  });

  it("records the first terminal when the strip's selection is not among them", () => {
    const next = nextSession(
      emptySession(),
      live({
        terminals: [newTerminalTab("t1", "infra", "shell 1", "/w/infra", null)],
        activeTerminal: "gone",
      }),
      hydrated,
      ["infra"],
    );

    expect(projectSession(next, "infra")?.activeTerminal).toBe(0);
  });
});

describe("deciding whether a session is worth writing", () => {
  it("is the same session when nothing that is stored has changed", () => {
    const a = nextSession(emptySession(), live(), new Set(["infra"]), ["infra"]);
    const b = nextSession(a, live(), new Set(["infra"]), ["infra"]);

    expect(sameSession(a, b)).toBe(true);
  });

  it("is a different session when a pane has moved", () => {
    const a = nextSession(emptySession(), live(), new Set(["infra"]), ["infra"]);
    const b = nextSession(a, live({ sidebar: SIDEBAR_DEFAULT + 40 }), new Set(["infra"]), [
      "infra",
    ]);

    expect(sameSession(a, b)).toBe(false);
    expect(b.sidebar).toBe(SIDEBAR_DEFAULT + 40);
  });

  // A tree's listings change constantly — every watcher event re-lists a
  // directory — and none of them are stored. Recomputing over one must not
  // produce a file to write.
  it("is the same session when only what the tree has loaded has changed", () => {
    const settled = nextSession(emptySession(), live(), new Set(["infra"]), ["infra"]);
    const relisted = withListing(initialTree(), ROOT, [{ name: "deploy.yaml", isDir: false }]);

    const listed = nextSession(settled, live({ tree: relisted }), new Set(["infra"]), [
      "infra",
    ]);

    expect(sameSession(settled, listed)).toBe(true);
  });
});
