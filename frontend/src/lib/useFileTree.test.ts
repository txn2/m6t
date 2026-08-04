import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Directory } from "./directory";
import type { Entry } from "./tree";
import { ROOT } from "./tree";
import { useFileTree } from "./useFileTree";

const endpoint = { port: 51234, token: "tok" };

/** A Directory whose responses a test controls directly. Left untyped as
 * `Directory` (structurally compatible, so it still passes to useFileTree)
 * so the mock methods stay callable as mocks in assertions. */
function fakeDirectory(listings: Record<string, Entry[]>) {
  return {
    list: vi.fn((_root: string, relPath: string) => {
      const dir = relPath === "" ? ROOT : relPath;
      return Promise.resolve(listings[dir] ?? []);
    }),
    create: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
  };
}

/** A minimal fake WebSocket: enough surface for openEventsSocket and the
 * hook's own close() call, following the FakeSocket shape terminalSession's
 * own tests already use for the same reason — no jsdom WebSocket needed. */
function fakeSocketFactory() {
  const sockets: { onmessage: ((event: MessageEvent) => void) | null; close: () => void }[] = [];
  const factory = vi.fn(() => {
    const socket = { onmessage: null, close: vi.fn() };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { factory, sockets };
}

describe("loading the tree", () => {
  it("lists root as soon as a project is given", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));

    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    expect(result.current.state.dirs[ROOT].children).toEqual([
      { name: "a.yaml", isDir: false, path: "a.yaml" },
    ]);
  });

  it("resets to a fresh tree when the project changes", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] });
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useFileTree(root, null, directory),
      { initialProps: { root: "/w/infra" } },
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    rerender({ root: "/w/other" });

    // The reset happens before the new root's own listing effect runs, so by
    // the time it settles root is "loading" again rather than still holding
    // the previous project's entries — that stale data is the thing this
    // guards against.
    expect(result.current.state.dirs[ROOT]?.children).toEqual([]);
    expect(result.current.state.expanded.has(ROOT)).toBe(true);
  });

  it("reports a listing failure without losing what root already had", async () => {
    const directory: Directory = {
      list: vi
        .fn()
        .mockResolvedValueOnce([{ name: "a.yaml", isDir: false }])
        .mockRejectedValueOnce(new Error("permission denied")),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
    };
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.expand("manifests");
    });

    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("error");
    });
    expect(result.current.state.dirs.manifests.error).toBe("permission denied");
    // Root's own successful listing is untouched by a sibling's failure.
    expect(result.current.state.dirs[ROOT].status).toBe("loaded");
  });
});

describe("expanding a directory", () => {
  it("lists a directory's contents on expand", async () => {
    const directory = fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "deploy.yaml", isDir: false }],
    });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.expand("manifests");
    });

    expect(result.current.state.expanded.has("manifests")).toBe(true);
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    expect(result.current.state.dirs.manifests.children).toEqual([
      { name: "deploy.yaml", isDir: false, path: "manifests/deploy.yaml" },
    ]);
  });
});

describe("create, rename and delete", () => {
  it("creates an entry and re-lists its parent", async () => {
    const directory = fakeDirectory({ [ROOT]: [] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    let outcome: string | null = "unset";
    await act(async () => {
      outcome = await result.current.createEntry(ROOT, "a.yaml", false);
    });

    expect(outcome).toBeNull();
    expect(directory.create).toHaveBeenCalledWith("/w/infra", "a.yaml", false);
    expect(directory.list).toHaveBeenCalledWith("/w/infra", ROOT);
  });

  it("returns the backend's error message on a failed create", async () => {
    const directory: Directory = {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockRejectedValue(new Error("path already exists")),
      rename: vi.fn(),
      remove: vi.fn(),
    };
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    let outcome: string | null = null;
    await act(async () => {
      outcome = await result.current.createEntry(ROOT, "a.yaml", false);
    });

    expect(outcome).toBe("path already exists");
  });

  it("renames an entry and re-lists its parent", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    await act(async () => {
      await result.current.renameEntry("a.yaml", "b.yaml");
    });

    expect(directory.rename).toHaveBeenCalledWith("/w/infra", "a.yaml", "b.yaml");
  });

  it("deletes an entry, re-lists its parent, and clears the selection if it was selected", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.select("a.yaml");
    });
    expect(result.current.state.selected).toBe("a.yaml");

    await act(async () => {
      await result.current.deleteEntry("a.yaml");
    });

    expect(directory.remove).toHaveBeenCalledWith("/w/infra", "a.yaml");
    expect(result.current.state.selected).toBeNull();
  });
});

describe("hidden files", () => {
  it("toggles the flag the tree filters by", () => {
    const { result } = renderHook(() => useFileTree(null, null, fakeDirectory({})));
    expect(result.current.state.showHidden).toBe(false);
    act(() => {
      result.current.toggleHidden();
    });
    expect(result.current.state.showHidden).toBe(true);
  });
});

describe("live updates over /events", () => {
  it("re-lists a loaded directory named in a matching tree-changed event", async () => {
    const directory = fakeDirectory({
      [ROOT]: [{ name: "a.yaml", isDir: false }],
    });
    const { sockets, factory } = fakeSocketFactory();
    const { result } = renderHook(() =>
      useFileTree("/w/infra", endpoint, directory, factory),
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    expect(directory.list).toHaveBeenCalledTimes(1);

    act(() => {
      sockets[0].onmessage?.({
        data: '{"type":"tree","payload":{"root":"/w/infra","dirs":["."]}}',
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(directory.list).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores a tree-changed event for a different project", async () => {
    const directory = fakeDirectory({ [ROOT]: [] });
    const { sockets, factory } = fakeSocketFactory();
    const { result } = renderHook(() =>
      useFileTree("/w/infra", endpoint, directory, factory),
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    directory.list.mockClear();

    act(() => {
      sockets[0].onmessage?.({
        data: '{"type":"tree","payload":{"root":"/w/other","dirs":["."]}}',
      } as MessageEvent<string>);
    });

    // Give any (wrongly) queued microtask a turn before asserting the absence.
    await Promise.resolve();
    expect(directory.list).not.toHaveBeenCalled();
  });

  it("ignores a change reported for a directory that was never loaded", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "manifests", isDir: true }] });
    const { sockets, factory } = fakeSocketFactory();
    const { result } = renderHook(() =>
      useFileTree("/w/infra", endpoint, directory, factory),
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    directory.list.mockClear();

    act(() => {
      sockets[0].onmessage?.({
        data: '{"type":"tree","payload":{"root":"/w/infra","dirs":["manifests"]}}',
      } as MessageEvent<string>);
    });

    await Promise.resolve();
    expect(directory.list).not.toHaveBeenCalled();
  });

  it("closes the event socket when the project changes", async () => {
    const directory = fakeDirectory({ [ROOT]: [] });
    const { sockets, factory } = fakeSocketFactory();
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) =>
        useFileTree(root, endpoint, directory, factory),
      { initialProps: { root: "/w/infra" } },
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    rerender({ root: "/w/other" });

    expect(sockets[0].close).toHaveBeenCalled();
  });
});
