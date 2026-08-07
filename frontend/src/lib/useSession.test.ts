import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { session as models } from "../../wailsjs/go/models";
import type { Directory } from "./directory";
import type { FileContent } from "./files";
import type { Project, Registry } from "./projects";
import type { Session, SessionStore } from "./session";
import { emptySession } from "./session";
import type { Entry } from "./tree";
import { ROOT } from "./tree";
import { useEditorTabs } from "./useEditorTabs";
import { useFileTree } from "./useFileTree";
import { useProjects } from "./useProjects";
import { SAVE_DELAY, useSession } from "./useSession";
import { useTerminals } from "./useTerminals";

const infra = { name: "infra", path: "/w/infra" } as Project;
const apps = { name: "apps", path: "/w/apps" } as Project;

const content = (text: string): FileContent =>
  ({
    content: text,
    crlf: false,
    mixedEol: false,
    readOnly: false,
    size: text.length,
  }) as FileContent;

/** A registry holding the given projects and refusing every write: these tests
 * restore into a workspace, they do not edit one. */
function fakeRegistry(projects: Project[] = [infra, apps]): Registry {
  return {
    list: () => Promise.resolve(projects),
    choose: () => Promise.resolve(""),
    add: () => Promise.reject(new Error("not used")),
    remove: () => Promise.reject(new Error("not used")),
    update: () => Promise.reject(new Error("not used")),
    reorder: () => Promise.reject(new Error("not used")),
  };
}

function fakeFiles(disk: Record<string, string> = {}) {
  return {
    read: vi.fn((_root: string, path: string) =>
      path in disk
        ? Promise.resolve(content(disk[path]))
        : Promise.reject(new Error(`no such file: ${path}`)),
    ),
    write: vi.fn(() => Promise.resolve()),
  };
}

function fakeDirectory(listings: Record<string, Entry[]> = { [ROOT]: [] }) {
  return {
    list: vi.fn((_root: string, dir: string) => Promise.resolve(listings[dir] ?? [])),
    create: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    prefixes: vi.fn(() => Promise.resolve({})),
  };
}

/** A session store over an in-memory file, recording what was written. */
function fakeStore(initial: Session = emptySession()) {
  const saved: Session[] = [];
  return {
    saved,
    last: () => saved[saved.length - 1],
    store: {
      load: vi.fn(() => Promise.resolve(initial)),
      save: vi.fn((state: Session) => {
        saved.push(state);
        return Promise.resolve();
      }),
    } satisfies SessionStore,
  };
}

/** A saved session; see session.test.ts on why the overrides are loose. */
function saved(over: Record<string, unknown> = {}): Session {
  return models.State.createFrom({ version: 1, projects: [], ...over });
}

/**
 * The workbench's hooks, wired the way `App` wires them.
 *
 * The real hooks rather than fakes, because what these tests are about is the
 * order the restore happens in — a tree that resets on a project switch, a
 * strip that must not be recorded before it is filled — and a fake of those
 * hooks would be a fake of the behaviour under test.
 */
function workbench(options: {
  store: SessionStore;
  registry?: Registry;
  files?: ReturnType<typeof fakeFiles>;
  directory?: ReturnType<typeof fakeDirectory>;
}) {
  const registry = options.registry ?? fakeRegistry();
  const files = options.files ?? fakeFiles();
  const directory = options.directory ?? fakeDirectory();

  return renderHook(() => {
    const projects = useProjects(registry);
    const terminals = useTerminals(projects.activeName);
    const editors = useEditorTabs(projects.activeName, null, files);
    const tree = useFileTree(projects.active?.path ?? null, null, directory as Directory);
    const session = useSession({ projects, editors, terminals, tree, store: options.store });
    return { projects, terminals, editors, tree, session };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("restoring a workspace", () => {
  it("opens the project that was open, not the first one", async () => {
    const { store } = fakeStore(saved({ activeProject: "apps" }));
    const { result } = workbench({ store });

    await waitFor(() => {
      expect(result.current.projects.activeName).toBe("apps");
    });
  });

  it("leaves the registry's choice alone when the saved project is gone", async () => {
    const { store } = fakeStore(saved({ activeProject: "removed" }));
    const { result } = workbench({ store });

    await waitFor(() => {
      expect(result.current.projects.list).toHaveLength(2);
    });
    expect(result.current.projects.activeName).toBe("infra");
  });

  it("restores the window-wide settings", async () => {
    const { store } = fakeStore(
      saved({ fontSize: 17, sidebar: 333, terminalHeight: 222 }),
    );
    const { result } = workbench({ store });

    await waitFor(() => {
      expect(result.current.session.workspace).toEqual({
        fontSize: 17,
        sidebar: 333,
        terminalHeight: 222,
      });
    });
  });

  it("reopens the active project's editor tabs, terminals and tree", async () => {
    const { store } = fakeStore(
      saved({
        activeProject: "infra",
        changedOnly: false,
        projects: [
          {
            name: "infra",
            editors: [
              { path: "a.yaml", mode: "edit" },
              { path: "b.yaml", mode: "edit" },
            ],
            activeEditor: "b.yaml",
            terminals: [{ title: "build", cwd: "/w/infra/manifests" }],
            activeTerminal: 0,
            treeExpanded: ["", "manifests"],
            treeSelected: "a.yaml",
            treeShowHidden: true,
          },
        ],
      }),
    );
    const files = fakeFiles({ "a.yaml": "a: 1\n", "b.yaml": "b: 2\n" });
    const directory = fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod.yaml", isDir: false }],
    });
    const { result } = workbench({ store, files, directory });

    await waitFor(() => {
      expect(result.current.editors.visible).toHaveLength(2);
    });
    expect(result.current.editors.visible.map((tab) => tab.path)).toEqual(["a.yaml", "b.yaml"]);
    expect(result.current.editors.activeKey).toBe(result.current.editors.visible[1].key);
    expect(result.current.terminals.visible.map((tab) => tab.title)).toEqual(["build"]);
    expect(result.current.terminals.visible[0].cwd).toBe("/w/infra/manifests");
    expect(result.current.tree.state.expanded.has("manifests")).toBe(true);
    expect(result.current.tree.state.selected).toBe("a.yaml");
    expect(result.current.tree.state.showHidden).toBe(true);
  });

  // A project's tabs are put back when it is first looked at, not at launch:
  // restoring every registered repository's would read a file and start a
  // shell per tab before the user had asked for any of them.
  it("restores a second project's tabs only once it is on screen", async () => {
    const { store } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [
          { name: "infra", editors: [{ path: "a.yaml", mode: "edit" }] },
          { name: "apps", editors: [{ path: "b.yaml", mode: "edit" }] },
        ],
      }),
    );
    const files = fakeFiles({ "a.yaml": "a: 1\n", "b.yaml": "b: 2\n" });
    const { result } = workbench({ store, files });

    await waitFor(() => {
      expect(result.current.editors.visible).toHaveLength(1);
    });
    expect(files.read).not.toHaveBeenCalledWith("/w/apps", "b.yaml");

    act(() => {
      result.current.projects.select("apps");
    });

    await waitFor(() => {
      expect(result.current.editors.visible.map((tab) => tab.path)).toEqual(["b.yaml"]);
    });
    expect(result.current.editors.tabs).toHaveLength(2);
  });

  // The registry picks the first project the moment it answers, which is a
  // moment before the saved selection lands. Hydrating on the way past it would
  // read that repository's files and start its shells for a project the user
  // never opened.
  it("does not restore the project it was only passing through", async () => {
    const { store } = fakeStore(
      saved({
        activeProject: "apps",
        projects: [
          {
            name: "infra",
            editors: [{ path: "a.yaml", mode: "edit" }],
            terminals: [{ title: "shell 1", cwd: "/w/infra" }],
          },
          { name: "apps", terminals: [{ title: "shell 1", cwd: "/w/apps" }] },
        ],
      }),
    );
    const files = fakeFiles({ "a.yaml": "a: 1\n" });
    const { result } = workbench({ store, files });

    await waitFor(() => {
      expect(result.current.terminals.tabs).toHaveLength(1);
    });
    expect(result.current.terminals.tabs[0].cwd).toBe("/w/apps");
    expect(files.read).not.toHaveBeenCalled();
    expect(result.current.editors.tabs).toHaveLength(0);
  });

  // The tree is reset by a project switch, so unlike the strips it is restored
  // every time — otherwise coming back to a project would show it collapsed.
  it("puts the tree back each time a project comes back on screen", async () => {
    const { store } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [{ name: "infra", treeExpanded: ["", "manifests"] }],
      }),
    );
    const directory = fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [],
    });
    const { result } = workbench({ store, directory });

    await waitFor(() => {
      expect(result.current.tree.state.expanded.has("manifests")).toBe(true);
    });

    act(() => {
      result.current.projects.select("apps");
    });
    await waitFor(() => {
      expect(result.current.tree.state.expanded.has("manifests")).toBe(false);
    });

    act(() => {
      result.current.projects.select("infra");
    });
    await waitFor(() => {
      expect(result.current.tree.state.expanded.has("manifests")).toBe(true);
    });
  });

  it("starts at the defaults when the session cannot be read", async () => {
    const store: SessionStore = {
      load: () => Promise.reject(new Error("no runtime")),
      save: vi.fn(() => Promise.resolve()),
    };
    const { result } = workbench({ store });

    await waitFor(() => {
      expect(result.current.projects.activeName).toBe("infra");
    });
    expect(result.current.session.workspace.sidebar).toBeGreaterThan(0);
    expect(result.current.editors.visible).toHaveLength(0);
  });
});

describe("recording a workspace", () => {
  it("writes once the workspace has sat still", async () => {
    vi.useFakeTimers();
    const { store, last } = fakeStore(saved({ activeProject: "infra" }));
    const { result } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.session.setWorkspace({ sidebar: 400 });
    });
    expect(store.save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    expect(last().sidebar).toBe(400);
  });

  it("does not write again while nothing has changed", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore(saved({ activeProject: "infra" }));
    const { result } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    act(() => {
      result.current.session.setWorkspace({ sidebar: 400 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });
    const writes = store.save.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY * 4);
    });

    expect(store.save.mock.calls).toHaveLength(writes);
  });

  it("records the tabs the user has open", async () => {
    vi.useFakeTimers();
    const { store, last } = fakeStore(saved({ activeProject: "infra" }));
    const files = fakeFiles({ "a.yaml": "a: 1\n" });
    const { result } = workbench({ store, files });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.editors.open("infra", "/w/infra", "a.yaml");
      result.current.terminals.create("infra", "/w/infra", null);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    const record = last().projects[0];
    expect(record.name).toBe("infra");
    expect(record.editors.map((editor) => editor.path)).toEqual(["a.yaml"]);
    expect(record.terminals).toHaveLength(1);
    expect(record.activeEditor).toBe("a.yaml");
  });

  // The other project's record is not on screen and cannot be read off the
  // strips. Recording what the strips hold would delete it.
  it("keeps the record of a project it has not opened", async () => {
    vi.useFakeTimers();
    const { store, last } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [
          { name: "infra" },
          { name: "apps", editors: [{ path: "b.yaml", mode: "edit" }], activeEditor: "b.yaml" },
        ],
      }),
    );
    const { result } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.session.setWorkspace({ fontSize: 18 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    const record = last().projects.find((project) => project.name === "apps");
    expect(record?.editors).toEqual([{ path: "b.yaml", mode: "edit" }]);
  });

  // The window between a project becoming active and its tabs coming back is
  // the one in which a naive recorder would write the empty strip as fact.
  it("does not record an empty strip before the tabs have been put back", async () => {
    vi.useFakeTimers();
    const { store, saved: writes } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [
          {
            name: "infra",
            editors: [{ path: "a.yaml", mode: "edit" }],
            activeEditor: "a.yaml",
          },
        ],
      }),
    );
    const files = fakeFiles({ "a.yaml": "a: 1\n" });
    const { result } = workbench({ store, files });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    expect(result.current.editors.visible).toHaveLength(1);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.projects[0].editors).toEqual([{ path: "a.yaml", mode: "edit" }]);
    }
  });

  // Every saved file gone means nothing changes on screen, so nothing but this
  // would prompt a write — and the dead tab list would be retried forever.
  it("records a strip whose every saved file has been deleted", async () => {
    vi.useFakeTimers();
    const { store, last } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [
          { name: "infra", editors: [{ path: "gone.yaml", mode: "edit" }], activeEditor: "gone.yaml" },
        ],
      }),
    );
    const { result } = workbench({ store, files: fakeFiles() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    expect(result.current.editors.visible).toHaveLength(0);
    expect(last().projects[0].editors).toEqual([]);
  });

  // Each project's tree is its own. The strips make this easy — they only ever
  // show the active project — but the tree is shared state that is reset and
  // refilled on every switch, so what gets recorded for a project has to be the
  // tree that was on screen while that project was.
  it("records each project's own tree across a switch and back", async () => {
    vi.useFakeTimers();
    const { store, last } = fakeStore(
      saved({
        activeProject: "infra",
        projects: [
          { name: "infra", treeExpanded: ["", "manifests"] },
          { name: "apps", treeExpanded: ["", "charts"] },
        ],
      }),
    );
    const directory = fakeDirectory({
      [ROOT]: [
        { name: "manifests", isDir: true },
        { name: "charts", isDir: true },
      ],
      manifests: [],
      charts: [],
    });
    const { result } = workbench({ store, directory });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    for (const name of ["apps", "infra"]) {
      act(() => {
        result.current.projects.select(name);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    const records = last().projects;
    expect(records.find((project) => project.name === "infra")?.treeExpanded).toEqual([
      "",
      "manifests",
    ]);
    expect(records.find((project) => project.name === "apps")?.treeExpanded).toEqual([
      "",
      "charts",
    ]);
  });

  // The workbench re-renders continuously on its own — the git status the
  // watcher drives is enough. A write that re-armed its timer on every one of
  // those renders would be postponed forever, and the session would never reach
  // disk at all.
  it("writes on time while the workbench keeps re-rendering", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore(saved({ activeProject: "infra" }));
    const { result, rerender } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.session.setWorkspace({ sidebar: 400 });
    });
    for (let elapsed = 0; elapsed < SAVE_DELAY; elapsed += SAVE_DELAY / 5) {
      await act(async () => {
        rerender();
        await vi.advanceTimersByTimeAsync(SAVE_DELAY / 5);
      });
    }

    expect(store.save).toHaveBeenCalled();
  });

  it("survives a write that fails", async () => {
    vi.useFakeTimers();
    const store: SessionStore = {
      load: () => Promise.resolve(saved({ activeProject: "infra" })),
      save: vi.fn(() => Promise.reject(new Error("read-only config directory"))),
    };
    const { result } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.session.setWorkspace({ sidebar: 400 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });

    expect(store.save).toHaveBeenCalled();
    expect(result.current.session.workspace.sidebar).toBe(400);
  });

  it("does not write after the workbench is gone", async () => {
    vi.useFakeTimers();
    const { store } = fakeStore(saved({ activeProject: "infra" }));
    const { result, unmount } = workbench({ store });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY);
    });
    const writes = store.save.mock.calls.length;

    act(() => {
      result.current.session.setWorkspace({ sidebar: 420 });
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DELAY * 2);
    });

    expect(store.save.mock.calls).toHaveLength(writes);
  });
});
