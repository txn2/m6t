import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { newTab } from "./editorTabs";
import type { FileContent } from "./files";
import { tabsInChangedDirs, useEditorTabs } from "./useEditorTabs";

const endpoint = { port: 51234, token: "tok" };

const content = (text: string, over: Partial<FileContent> = {}): FileContent =>
  ({ content: text, crlf: false, mixedEol: false, readOnly: false, size: text.length, ...over }) as FileContent;

/** A Files whose responses a test controls. Left structurally typed so the
 * mock methods stay callable as mocks in assertions, the same way
 * `fakeDirectory` does in useFileTree.test.ts. */
function fakeFiles(initial: Record<string, FileContent> = {}) {
  const disk = { ...initial };
  return {
    disk,
    read: vi.fn((_root: string, path: string) =>
      path in disk
        ? Promise.resolve(disk[path])
        : Promise.reject(new Error(`no such file: ${path}`)),
    ),
    write: vi.fn((_root: string, path: string, text: string) => {
      disk[path] = content(text);
      return Promise.resolve();
    }),
  };
}

/** A minimal fake WebSocket, the shape useFileTree.test.ts already uses. */
function fakeSocketFactory() {
  const sockets: { onmessage: ((event: MessageEvent) => void) | null; close: () => void }[] = [];
  const factory = vi.fn(() => {
    const socket = { onmessage: null, close: vi.fn() };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { factory, sockets };
}

/** Delivers a `tree` event over the fake socket, in the wire form
 * PROTOCOL.md §5 specifies. */
function pushTreeEvent(
  sockets: ReturnType<typeof fakeSocketFactory>["sockets"],
  root: string,
  dirs: string[],
) {
  act(() => {
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "tree", payload: { root, dirs } }),
    } as MessageEvent);
  });
}

describe("opening files", () => {
  it("loads a file into a new tab", async () => {
    const files = fakeFiles({ "deploy.yaml": content("kind: Deployment\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "deploy.yaml");
    });

    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    expect(result.current.visible[0].content).toBe("kind: Deployment\n");
    expect(result.current.activeKey).toBe(result.current.visible[0].key);
  });

  it("focuses the existing tab rather than opening a file twice", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n"), "b.yaml": content("b: 2\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(1);
    });
    act(() => {
      result.current.open("infra", "/w/infra", "b.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(2);
    });

    const firstKey = result.current.visible[0].key;
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });

    expect(result.current.visible).toHaveLength(2);
    expect(result.current.activeKey).toBe(firstKey);
    expect(files.read).toHaveBeenCalledTimes(2);
  });

  it("picks a tab's kind from its extension", async () => {
    const files = fakeFiles({ "docs/README.md": content("# hi\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "docs/README.md");
    });

    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    expect(result.current.visible[0].kind).toBe("markdown");
    expect(result.current.visible[0].mode).toBe("preview");
  });

  it("reports a load failure on the tab instead of throwing", async () => {
    const files = fakeFiles();
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "gone.yaml");
    });

    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("error");
    });
    expect(result.current.visible[0].error).toContain("gone.yaml");
  });
});

describe("saving", () => {
  it("writes the buffer and clears dirty", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.edit(key, "a: 2\n");
    });
    act(() => {
      result.current.save(key);
    });

    await waitFor(() => {
      expect(result.current.visible[0].baseline).toBe("a: 2\n");
    });
    expect(files.write).toHaveBeenCalledWith("/w/infra", "a.yaml", "a: 2\n", false);
  });

  it("hands the file's CRLF flag back so the write restores its line endings", async () => {
    const files = fakeFiles({ "win.yaml": content("a: 1\n", { crlf: true }) });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "win.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.edit(key, "a: 2\n");
    });
    act(() => {
      result.current.save(key);
    });

    await waitFor(() => {
      expect(files.write).toHaveBeenCalledWith("/w/infra", "win.yaml", "a: 2\n", true);
    });
  });

  it("does not write a clean tab", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });

    act(() => {
      result.current.save(result.current.visible[0].key);
    });

    expect(files.write).not.toHaveBeenCalled();
  });

  it("keeps the buffer and reports why when a write fails", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    files.write.mockRejectedValueOnce(new Error("permission denied"));
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.edit(key, "a: 2\n");
    });
    act(() => {
      result.current.save(key);
    });

    await waitFor(() => {
      expect(result.current.visible[0].error).toBe("permission denied");
    });
    expect(result.current.visible[0].content).toBe("a: 2\n");
    expect(result.current.visible[0].saving).toBe(false);
  });
});

describe("external changes", () => {
  it("silently reloads a clean tab when its directory changes", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });

    files.disk["a.yaml"] = content("a: 99\n");
    pushTreeEvent(sockets, "/w/infra", ["."]);

    await waitFor(() => {
      expect(result.current.visible[0].content).toBe("a: 99\n");
    });
    expect(result.current.visible[0].conflict).toBeNull();
  });

  it("raises a conflict rather than overwriting a dirty tab", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });

    act(() => {
      result.current.edit(result.current.visible[0].key, "a: 2\n");
    });
    files.disk["a.yaml"] = content("a: 99\n");
    pushTreeEvent(sockets, "/w/infra", ["."]);

    await waitFor(() => {
      expect(result.current.visible[0].conflict).toBe("a: 99\n");
    });
    expect(result.current.visible[0].content).toBe("a: 2\n");
  });

  it("ignores a change under a different project's root", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    files.read.mockClear();

    pushTreeEvent(sockets, "/w/somewhere-else", ["."]);

    expect(files.read).not.toHaveBeenCalled();
  });

  it("ignores a change in a directory none of its tabs live in", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    files.read.mockClear();

    pushTreeEvent(sockets, "/w/infra", ["charts/redis"]);

    expect(files.read).not.toHaveBeenCalled();
  });

  it("keeps an unsaved buffer when the file it came from is deleted", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });

    act(() => {
      result.current.edit(result.current.visible[0].key, "a: 2\n");
    });
    delete files.disk["a.yaml"];
    pushTreeEvent(sockets, "/w/infra", ["."]);

    await waitFor(() => {
      expect(result.current.visible[0].error).toContain("a.yaml");
    });
    // The buffer is the only copy of this work left; it must survive.
    expect(result.current.visible[0].content).toBe("a: 2\n");
    expect(result.current.visible[0].status).toBe("ready");
  });

  it("resolves a conflict by keeping the buffer, leaving it dirty and saveable", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.edit(key, "a: 2\n");
    });
    files.disk["a.yaml"] = content("a: 99\n");
    pushTreeEvent(sockets, "/w/infra", ["."]);
    await waitFor(() => {
      expect(result.current.visible[0].conflict).toBe("a: 99\n");
    });

    act(() => {
      result.current.keepMine(key);
    });
    act(() => {
      result.current.save(key);
    });

    await waitFor(() => {
      expect(files.write).toHaveBeenCalledWith("/w/infra", "a.yaml", "a: 2\n", false);
    });
  });

  it("resolves a conflict by taking disk, discarding the buffer", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useEditorTabs("infra", endpoint, files, factory));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.edit(key, "a: 2\n");
    });
    files.disk["a.yaml"] = content("a: 99\n");
    pushTreeEvent(sockets, "/w/infra", ["."]);
    await waitFor(() => {
      expect(result.current.visible[0].conflict).toBe("a: 99\n");
    });

    act(() => {
      result.current.takeDisk(key);
    });

    expect(result.current.visible[0].content).toBe("a: 99\n");
    expect(result.current.visible[0].conflict).toBeNull();
  });
});

describe("the strip across projects", () => {
  it("keeps another project's unsaved tab when the active project changes", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n"), "b.yaml": content("b: 1\n") });
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useEditorTabs(project, null, files),
      { initialProps: { project: "infra" } },
    );
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });
    act(() => {
      result.current.edit(result.current.visible[0].key, "a: unsaved\n");
    });

    rerender({ project: "team-x" });
    expect(result.current.visible).toHaveLength(0);

    rerender({ project: "infra" });
    expect(result.current.visible[0].content).toBe("a: unsaved\n");
  });

  it("remembers each project's own selected tab", async () => {
    const files = fakeFiles({ "a.yaml": content("a\n"), "b.yaml": content("b\n") });
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useEditorTabs(project, null, files),
      { initialProps: { project: "infra" } },
    );
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.activeKey).not.toBeNull();
    });
    const infraKey = result.current.activeKey;

    rerender({ project: "team-x" });
    act(() => {
      result.current.open("team-x", "/w/team-x", "b.yaml");
    });
    await waitFor(() => {
      expect(result.current.activeKey).not.toBe(infraKey);
    });

    rerender({ project: "infra" });
    expect(result.current.activeKey).toBe(infraKey);
  });

  it("closes a project's tabs with the project", async () => {
    const files = fakeFiles({ "a.yaml": content("a\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
    });

    act(() => {
      result.current.closeProject("infra");
    });

    expect(result.current.tabs).toHaveLength(0);
  });

  it("selects the neighbouring tab when the active one closes", async () => {
    const files = fakeFiles({ "a.yaml": content("a\n"), "b.yaml": content("b\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));
    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(1);
    });
    act(() => {
      result.current.open("infra", "/w/infra", "b.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(2);
    });
    const [first, second] = result.current.visible;

    act(() => {
      result.current.select(first.key);
    });
    act(() => {
      result.current.close(first.key);
    });

    expect(result.current.visible.map((t) => t.key)).toEqual([second.key]);
    expect(result.current.activeKey).toBe(second.key);
  });
});

describe("the blame toggle (#52)", () => {
  it("turns one tab's column on without touching another's", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n"), "b.yaml": content("b: 2\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(1);
    });
    act(() => {
      result.current.open("infra", "/w/infra", "b.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(2);
    });

    act(() => {
      result.current.setBlame(result.current.visible[0].key, true);
    });

    expect(result.current.visible[0].blame).toBe(true);
    expect(result.current.visible[1].blame).toBe(false);
  });

  it("turns it off again", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible).toHaveLength(1);
    });
    const key = result.current.visible[0].key;

    act(() => {
      result.current.setBlame(key, true);
    });
    act(() => {
      result.current.setBlame(key, false);
    });

    expect(result.current.visible[0].blame).toBe(false);
  });
});

describe("tabsInChangedDirs", () => {
  const tab = (path: string, root = "/w/infra") =>
    newTab(`k-${path}`, "infra", root, path, "yaml");

  it("translates the wire's root marker to the tree's own", () => {
    expect(tabsInChangedDirs([tab("a.yaml")], "/w/infra", ["."]).map((t) => t.path)).toEqual([
      "a.yaml",
    ]);
  });

  it("matches a nested file by its own directory", () => {
    const tabs = [tab("charts/redis/values.yaml"), tab("a.yaml")];

    expect(tabsInChangedDirs(tabs, "/w/infra", ["charts/redis"]).map((t) => t.path)).toEqual([
      "charts/redis/values.yaml",
    ]);
  });

  it("does not match a file in a parent of the changed directory", () => {
    expect(tabsInChangedDirs([tab("a.yaml")], "/w/infra", ["charts"])).toEqual([]);
  });

  it("does not match a tab from another root", () => {
    expect(tabsInChangedDirs([tab("a.yaml", "/w/other")], "/w/infra", ["."])).toEqual([]);
  });
});

describe("restoring a session's tabs", () => {
  it("reopens the saved files in order, focused on the saved one", async () => {
    const files = fakeFiles({
      "a.yaml": content("a: 1\n"),
      "notes.md": content("# notes\n"),
    });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [
          { path: "a.yaml", mode: "edit" },
          { path: "notes.md", mode: "preview" },
        ],
        active: "notes.md",
      });
    });

    expect(result.current.visible.map((tab) => tab.path)).toEqual(["a.yaml", "notes.md"]);
    expect(result.current.visible.every((tab) => tab.status === "ready")).toBe(true);
    expect(result.current.visible[1].mode).toBe("preview");
    expect(result.current.activeKey).toBe(result.current.visible[1].key);
  });

  // A markdown tab opens in preview by default. Restoring one the user had put
  // into edit mode has to override that, or the mode is not really saved.
  it("restores a mode the tab would not have defaulted to", async () => {
    const files = fakeFiles({ "notes.md": content("# notes\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [{ path: "notes.md", mode: "edit" }],
        active: null,
      });
    });

    expect(result.current.visible[0].mode).toBe("edit");
  });

  // Deleted while the app was closed: the tab is not restored, and the ones
  // around it are. An error tab would make every restart after a branch switch
  // an exercise in closing tabs.
  it("silently skips a file that is gone and focuses a survivor", async () => {
    const files = fakeFiles({ "kept.yaml": content("k: 1\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [
          { path: "deleted.yaml", mode: "edit" },
          { path: "kept.yaml", mode: "edit" },
        ],
        active: "deleted.yaml",
      });
    });

    expect(result.current.visible.map((tab) => tab.path)).toEqual(["kept.yaml"]);
    expect(result.current.visible[0].status).toBe("ready");
    expect(result.current.activeKey).toBe(result.current.visible[0].key);
  });

  it("leaves the strip empty when every saved file is gone", async () => {
    const files = fakeFiles();
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [{ path: "deleted.yaml", mode: "edit" }],
        active: "deleted.yaml",
      });
    });

    expect(result.current.visible).toHaveLength(0);
    expect(result.current.activeKey).toBeNull();
  });

  // The user can open a file in the moment before the session is applied.
  it("does not open a second tab for a file that is already open", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n") });
    const { result } = renderHook(() => useEditorTabs("infra", null, files));

    act(() => {
      result.current.open("infra", "/w/infra", "a.yaml");
    });
    await waitFor(() => {
      expect(result.current.visible[0].status).toBe("ready");
    });

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [{ path: "a.yaml", mode: "edit" }],
        active: "a.yaml",
      });
    });

    expect(result.current.visible).toHaveLength(1);
  });

  it("restores one project's tabs without touching another's", async () => {
    const files = fakeFiles({ "a.yaml": content("a: 1\n"), "b.yaml": content("b: 2\n") });
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useEditorTabs(project, null, files),
      { initialProps: { project: "infra" } },
    );

    await act(async () => {
      await result.current.restore("infra", "/w/infra", {
        files: [{ path: "a.yaml", mode: "edit" }],
        active: null,
      });
    });
    rerender({ project: "apps" });
    await act(async () => {
      await result.current.restore("apps", "/w/apps", {
        files: [{ path: "b.yaml", mode: "edit" }],
        active: null,
      });
    });

    expect(result.current.visible.map((tab) => tab.path)).toEqual(["b.yaml"]);
    expect(result.current.tabs).toHaveLength(2);
    rerender({ project: "infra" });
    expect(result.current.visible.map((tab) => tab.path)).toEqual(["a.yaml"]);
  });
});
