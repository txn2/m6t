import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Directory } from "./directory";
import type { Entry } from "./tree";
import { ROOT, visibleRows } from "./tree";
import { useFileTree } from "./useFileTree";

const endpoint = { port: 51234, token: "tok" };

/** A Directory whose responses a test controls directly. Left untyped as
 * `Directory` (structurally compatible, so it still passes to useFileTree)
 * so the mock methods stay callable as mocks in assertions.
 *
 * `heads` is what ReadPrefixes would return for the whole project; the fake
 * serves the subset each call actually asks about, so a test can assert on
 * which paths were asked for rather than only on what came back. */
function fakeDirectory(listings: Record<string, Entry[]>, heads: Record<string, string> = {}) {
  return {
    list: vi.fn((_root: string, relPath: string) => {
      const dir = relPath === "" ? ROOT : relPath;
      return Promise.resolve(listings[dir] ?? []);
    }),
    create: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    prefixes: vi.fn((_root: string, relPaths: string[]) =>
      Promise.resolve(
        Object.fromEntries(
          relPaths.filter((path) => path in heads).map((path) => [path, heads[path]]),
        ),
      ),
    ),
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

describe("classifying manifests lazily (#38)", () => {
  it("reads the heads of a listing's plain YAML and records the verdicts", async () => {
    const directory = fakeDirectory(
      {
        [ROOT]: [
          { name: "deploy.yaml", isDir: false },
          { name: "codecov.yml", isDir: false },
        ],
      },
      { "deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n", "codecov.yml": "coverage: {}\n" },
    );
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));

    await waitFor(() => {
      expect(result.current.state.manifests.size).toBe(2);
    });
    expect(directory.prefixes).toHaveBeenCalledWith("/w/infra", ["deploy.yaml", "codecov.yml"]);
    expect(result.current.state.manifests.get("deploy.yaml")).toBe(true);
    expect(result.current.state.manifests.get("codecov.yml")).toBe(false);
  });

  it("does not read files whose icon its name already settles", async () => {
    const directory = fakeDirectory({
      [ROOT]: [
        { name: "Chart.yaml", isDir: false },
        { name: "README.md", isDir: false },
        { name: "templates", isDir: true },
      ],
    });
    renderHook(() => useFileTree("/w/infra", null, directory));

    await waitFor(() => {
      expect(directory.list).toHaveBeenCalled();
    });
    // Nothing in this listing can change with its content, so the round trip
    // is not made at all — this is what keeps expanding a chart free.
    expect(directory.prefixes).not.toHaveBeenCalled();
  });

  it("splits a large directory into batches the backend will serve", async () => {
    // internal/watch.ReadPrefixes refuses more than 1024 paths in one call,
    // so a flat directory of manifests bigger than that has to arrive in
    // pieces or it never classifies at all.
    const entries = Array.from({ length: 600 }, (_, i) => ({ name: `m${String(i)}.yaml`, isDir: false }));
    const heads = Object.fromEntries(entries.map((e) => [e.name, "apiVersion: v1\nkind: Pod\n"]));
    const directory = fakeDirectory({ [ROOT]: entries }, heads);
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));

    await waitFor(() => {
      expect(result.current.state.manifests.size).toBe(600);
    });
    expect(directory.prefixes).toHaveBeenCalledTimes(3);
    for (const call of directory.prefixes.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(256);
    }
  });

  it("drops verdicts that land after the project has changed", async () => {
    let release: (value: Record<string, string>) => void = () => undefined;
    const directory = {
      ...fakeDirectory({ [ROOT]: [{ name: "deploy.yaml", isDir: false }] }),
      prefixes: vi.fn(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useFileTree(root, null, directory),
      { initialProps: { root: "/w/infra" } },
    );
    await waitFor(() => {
      expect(directory.prefixes).toHaveBeenCalled();
    });

    rerender({ root: "/w/other" });
    await act(async () => {
      release({ "deploy.yaml": "apiVersion: v1\nkind: Pod\n" });
      await Promise.resolve();
    });

    // Paths are project-relative, so the old project's answer for
    // "deploy.yaml" would otherwise decide the new project's icon for its
    // own file of that name.
    expect(result.current.state.manifests.has("deploy.yaml")).toBe(false);
  });

  it("leaves the tree usable when classification fails", async () => {
    const directory = {
      ...fakeDirectory({ [ROOT]: [{ name: "deploy.yaml", isDir: false }] }),
      prefixes: vi.fn(() => Promise.reject(new Error("backend gone"))),
    };
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));

    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    // The listing stands and the row keeps its name-derived icon; a failed
    // classification is not a failed directory.
    expect(result.current.state.dirs[ROOT].error).toBeNull();
    expect(result.current.state.manifests.size).toBe(0);
  });

  it("re-reads a directory's YAML when the watcher says it changed", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const heads: Record<string, string> = { "deploy.yaml": "x: 1\n" };
    const directory = fakeDirectory({ [ROOT]: [{ name: "deploy.yaml", isDir: false }] }, heads);
    const { result } = renderHook(() => useFileTree("/w/infra", endpoint, directory, factory));

    await waitFor(() => {
      expect(result.current.state.manifests.get("deploy.yaml")).toBe(false);
    });

    // The file becomes a manifest on disk. Without a re-read the row would
    // keep saying plain YAML for the life of the tree.
    heads["deploy.yaml"] = "apiVersion: v1\nkind: Pod\n";
    act(() => {
      sockets[0].onmessage?.({
        data: '{"type":"tree","payload":{"root":"/w/infra","dirs":["."]}}',
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(result.current.state.manifests.get("deploy.yaml")).toBe(true);
    });
  });
});

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

  it("opens a project it has never seen on an empty tree", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] });
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useFileTree(root, null, directory),
      { initialProps: { root: "/w/infra" } },
    );
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    rerender({ root: "/w/other" });

    // The previous project's entries must not linger on screen under the new
    // project's name while its first listing is in flight — its relative paths
    // mean something else here.
    expect(result.current.state.dirs[ROOT]?.children).toEqual([]);
    expect(result.current.state.expanded.has(ROOT)).toBe(true);
  });

  // The seam below is rebuilt inside the render callback, which is both the
  // ordinary way to write a test and an easy slip in a component. A hook that
  // re-ran its listing effect on it would fetch, render, and fetch again — the
  // failure is an out-of-memory crash rather than a wrong value, so it is
  // worth a test of its own rather than being left to whoever trips it.
  it("survives a caller that passes a new seam on every render", async () => {
    const { result } = renderHook(() =>
      useFileTree("/w/infra", null, fakeDirectory({ [ROOT]: [{ name: "a.yaml", isDir: false }] })),
    );

    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    expect(result.current.state.dirs[ROOT].children).toHaveLength(1);
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
      prefixes: vi.fn(() => Promise.resolve({})),
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

describe("keeping a project's tree across a switch (#59)", () => {
  /** A Directory serving a different repository per root, so a test can prove
   * two projects' identical relative paths never bleed into one another. */
  function byRoot(listings: Record<string, Record<string, Entry[]>>) {
    return {
      list: vi.fn((root: string, relPath: string) => {
        const dir = relPath === "" ? ROOT : relPath;
        return Promise.resolve(listings[root]?.[dir] ?? []);
      }),
      create: vi.fn(() => Promise.resolve()),
      rename: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
      prefixes: vi.fn(() => Promise.resolve({})),
    };
  }

  const infra = {
    [ROOT]: [{ name: "manifests", isDir: true }],
    manifests: [
      { name: "prod", isDir: true },
      { name: "app.yaml", isDir: false },
    ],
    "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
  };

  /** Renders the hook over a switchable root, waiting for the first project's
   * root listing to land. */
  function open(directory: Directory, root: string) {
    return renderHook(({ at }: { at: string }) => useFileTree(at, null, directory), {
      initialProps: { at: root },
    });
  }

  it("comes back to the same expansion, selection and hidden-file setting", async () => {
    const directory = fakeDirectory(infra);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests/prod");
      result.current.select("manifests/app.yaml");
      result.current.toggleHidden();
    });

    rerender({ at: "/w/apps" });
    rerender({ at: "/w/infra" });

    expect([...result.current.state.expanded].sort()).toEqual([
      ROOT,
      "manifests",
      "manifests/prod",
    ]);
    expect(result.current.state.selected).toBe("manifests/app.yaml");
    expect(result.current.state.showHidden).toBe(true);
  });

  it("has the retained rows on screen before the refreshed ones land", async () => {
    const directory = fakeDirectory(infra);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });

    rerender({ at: "/w/apps" });
    rerender({ at: "/w/infra" });

    // Synchronously on return, with every refresh still in flight: the rows
    // are the retained ones rather than a loading state where they were.
    expect(result.current.state.dirs.manifests.status).toBe("loading");
    expect(visibleRows(result.current.state).map((row) => row.path)).toEqual([
      "manifests",
      "manifests/prod",
      "manifests/app.yaml",
    ]);
  });

  it("re-lists what the project has open, and nothing it has collapsed", async () => {
    const directory = fakeDirectory(infra);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests/prod");
    });
    await waitFor(() => {
      expect(result.current.state.dirs["manifests/prod"]?.status).toBe("loaded");
    });
    act(() => {
      result.current.collapse("manifests");
    });

    rerender({ at: "/w/apps" });
    directory.list.mockClear();
    rerender({ at: "/w/infra" });

    // `manifests/prod` is still expanded and still loaded, but it draws
    // nothing while its parent is closed — re-listing it would be a round trip
    // for rows nobody can see.
    expect(directory.list.mock.calls.map(([, dir]) => dir)).toEqual([ROOT]);
  });

  it("drops a directory deleted while the user was in another project", async () => {
    const listings: Record<string, Entry[]> = {
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod", isDir: true }],
    };
    const directory = fakeDirectory(listings);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.children).toHaveLength(1);
    });

    rerender({ at: "/w/apps" });
    listings.manifests = [];
    rerender({ at: "/w/infra" });

    await waitFor(() => {
      expect(result.current.state.dirs.manifests.children).toEqual([]);
    });
  });

  it("never shows one project's listing under another's identical path", async () => {
    const directory = byRoot({
      "/w/infra": {
        [ROOT]: [{ name: "manifests", isDir: true }],
        manifests: [{ name: "infra.yaml", isDir: false }],
      },
      "/w/apps": {
        [ROOT]: [{ name: "manifests", isDir: true }],
        manifests: [{ name: "apps.yaml", isDir: false }],
      },
    });
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });

    rerender({ at: "/w/apps" });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    expect(result.current.state.dirs.manifests.children.map((e) => e.name)).toEqual([
      "apps.yaml",
    ]);

    rerender({ at: "/w/infra" });
    expect(result.current.state.dirs.manifests.children.map((e) => e.name)).toEqual([
      "infra.yaml",
    ]);
  });

  it("keeps the changed-files filter window-wide rather than per project", async () => {
    const directory = fakeDirectory(infra);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.toggleChangedOnly();
    });
    rerender({ at: "/w/apps" });
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    // The filter describes how the user is working, not which repository they
    // are looking at — see `withTree`.
    expect(result.current.state.changedOnly).toBe(true);

    act(() => {
      result.current.toggleChangedOnly();
    });
    rerender({ at: "/w/infra" });
    expect(result.current.state.changedOnly).toBe(false);
  });

  it("forgets a project that has left the registry", async () => {
    const directory = fakeDirectory(infra);
    const { result, rerender } = open(directory, "/w/infra");
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });

    rerender({ at: "/w/apps" });
    act(() => {
      result.current.closeProject("/w/infra");
    });
    rerender({ at: "/w/infra" });

    // Nothing retained: a re-added project starts where a new one does, and
    // the map is not holding an entry a removed project left behind.
    expect(result.current.state.dirs.manifests).toBeUndefined();
    expect([...result.current.state.expanded]).toEqual([ROOT]);
  });

  it("drops a listing that lands after the project left the registry", async () => {
    let release: (entries: Entry[]) => void = () => undefined;
    const directory: Directory = {
      list: vi.fn(
        () =>
          new Promise<Entry[]>((resolve) => {
            release = resolve;
          }),
      ),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      prefixes: vi.fn(() => Promise.resolve({})),
    };
    const { result } = open(directory, "/w/infra");

    act(() => {
      result.current.closeProject("/w/infra");
    });
    await act(async () => {
      release([{ name: "late.yaml", isDir: false }]);
    });

    // A read in flight when a project is removed would otherwise write its
    // entry back a moment after the removal dropped it, leaving the map
    // holding a project the registry no longer has.
    expect(result.current.state.dirs[ROOT]).toBeUndefined();
  });

  it("records a listing that lands after the user has moved on", async () => {
    let release: (entries: Entry[]) => void = () => undefined;
    const directory: Directory = {
      list: vi.fn((root: string) =>
        root === "/w/infra"
          ? new Promise<Entry[]>((resolve) => {
              release = resolve;
            })
          : Promise.resolve([]),
      ),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      prefixes: vi.fn(() => Promise.resolve({})),
    };
    const { result, rerender } = open(directory, "/w/infra");

    rerender({ at: "/w/apps" });
    await act(async () => {
      release([{ name: "late.yaml", isDir: false }]);
    });

    // The answer belongs to the project it was asked of, which is still on the
    // map — before there was one, a late listing had nowhere to go but away.
    expect(result.current.state.dirs[ROOT]?.children).toEqual([]);
    rerender({ at: "/w/infra" });
    expect(result.current.state.dirs[ROOT].children.map((e) => e.name)).toEqual(["late.yaml"]);
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

describe("locating a file (#56)", () => {
  function nested() {
    return fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod", isDir: true }],
      "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
    });
  }

  it("opens the directories above the file and selects it", async () => {
    const directory = nested();
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.locate("manifests/prod/ingress.yaml");
    });

    expect(result.current.state.expanded.has("manifests/prod")).toBe(true);
    expect(result.current.state.selected).toBe("manifests/prod/ingress.yaml");
    await waitFor(() => {
      expect(result.current.state.dirs["manifests/prod"]?.status).toBe("loaded");
    });
  });

  // Listing a file is an error from the backend, and the row appears as soon
  // as its own directory is listed — so the file must never be asked for.
  it("never asks the backend to list the file", async () => {
    const directory = nested();
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.locate("manifests/prod/ingress.yaml");
    });
    await waitFor(() => {
      expect(result.current.state.dirs["manifests/prod"]?.status).toBe("loaded");
    });

    const asked = directory.list.mock.calls.map(([, path]) => path);
    expect(asked).not.toContain("manifests/prod/ingress.yaml");
  });
});

describe("revealing a directory (#43)", () => {
  /** A project three levels deep, with only its root listed so far. */
  function nested() {
    return fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod", isDir: true }],
      "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
    });
  }

  it("opens every directory on the way down and lists the ones it has not seen", async () => {
    const directory = nested();
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });

    act(() => {
      result.current.reveal("manifests/prod");
    });

    expect(result.current.state.expanded.has("manifests")).toBe(true);
    expect(result.current.state.expanded.has("manifests/prod")).toBe(true);
    expect(result.current.state.selected).toBe("manifests/prod");
    await waitFor(() => {
      expect(result.current.state.dirs["manifests/prod"]?.status).toBe("loaded");
    });
    expect(result.current.state.dirs["manifests/prod"].children).toEqual([
      { name: "ingress.yaml", isDir: false, path: "manifests/prod/ingress.yaml" },
    ]);
  });

  // The chain up to the file the user is looking at is nearly always already
  // loaded, and re-listing all of it would be a burst of round trips per
  // click to fetch what the tree already has.
  it("does not re-list a directory it has already loaded", async () => {
    const directory = nested();
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.expand("manifests");
    });
    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    directory.list.mockClear();

    act(() => {
      result.current.reveal("manifests");
    });

    expect(directory.list).not.toHaveBeenCalled();
  });

  it("leaves the filters that would have hidden the directory", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: ".github", isDir: true }] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory));
    await waitFor(() => {
      expect(result.current.state.dirs[ROOT]?.status).toBe("loaded");
    });
    act(() => {
      result.current.toggleChangedOnly();
    });

    act(() => {
      result.current.reveal(".github/workflows");
    });

    expect(result.current.state.changedOnly).toBe(false);
    expect(result.current.state.showHidden).toBe(true);
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
      prefixes: vi.fn(() => Promise.resolve({})),
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
    const { result } = renderHook(() => useFileTree("/w/infra", null, fakeDirectory({})));
    expect(result.current.state.showHidden).toBe(false);
    act(() => {
      result.current.toggleHidden();
    });
    expect(result.current.state.showHidden).toBe(true);
  });

  it("holds the flag per project, so each keeps its own", () => {
    const directory = fakeDirectory({ [ROOT]: [] });
    const { result, rerender } = renderHook(({ root }) => useFileTree(root, null, directory), {
      initialProps: { root: "/w/infra" },
    });

    act(() => {
      result.current.toggleHidden();
    });
    rerender({ root: "/w/apps" });
    expect(result.current.state.showHidden).toBe(false);

    rerender({ root: "/w/infra" });
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

describe("restoring a session's tree", () => {
  it("reopens the saved directories and lists them", async () => {
    const directory = fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod", isDir: true }],
      "manifests/prod": [{ name: "ingress.yaml", isDir: false }],
    });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory as Directory));
    await waitFor(() => {
      expect(directory.list).toHaveBeenCalledWith("/w/infra", ROOT);
    });

    act(() => {
      result.current.restore({
        expanded: ["", "manifests", "manifests/prod"],
        selected: "manifests/prod/ingress.yaml",
        showHidden: true,
        changedOnly: false,
      });
    });

    await waitFor(() => {
      expect(result.current.state.dirs["manifests/prod"]?.status).toBe("loaded");
    });
    expect([...result.current.state.expanded].sort()).toEqual([
      "",
      "manifests",
      "manifests/prod",
    ]);
    expect(result.current.state.selected).toBe("manifests/prod/ingress.yaml");
    expect(result.current.state.showHidden).toBe(true);
  });

  // The hook already lists the root for every project; asking again would be a
  // second round trip for one directory on every project switch.
  it("does not re-list the root it was already given", async () => {
    const directory = fakeDirectory({ [ROOT]: [{ name: "manifests", isDir: true }] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory as Directory));
    await waitFor(() => {
      expect(directory.list).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.restore({ expanded: [""], selected: null, showHidden: false, changedOnly: false });
    });

    expect(directory.list).toHaveBeenCalledTimes(1);
  });

  // A directory removed while the app was closed draws nothing: its row comes
  // from its parent's listing, which no longer mentions it.
  it("keeps the rest of the tree when a saved directory is gone", async () => {
    const directory = fakeDirectory({
      [ROOT]: [{ name: "manifests", isDir: true }],
      manifests: [{ name: "prod.yaml", isDir: false }],
    });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory as Directory));
    await waitFor(() => {
      expect(directory.list).toHaveBeenCalledWith("/w/infra", ROOT);
    });

    act(() => {
      result.current.restore({
        expanded: ["manifests", "removed"],
        selected: null,
        showHidden: false,
        changedOnly: false,
      });
    });

    await waitFor(() => {
      expect(result.current.state.dirs.manifests?.status).toBe("loaded");
    });
    expect(visibleRows(result.current.state).map((row) => row.path)).toEqual([
      "manifests",
      "manifests/prod.yaml",
    ]);
  });

  // The changed-files filter is window-wide: the tree carries it across a
  // project switch, so a restore has to be able to set it as well as clear it.
  it("applies the window-wide changed-files filter", async () => {
    const directory = fakeDirectory({ [ROOT]: [] });
    const { result } = renderHook(() => useFileTree("/w/infra", null, directory as Directory));
    await waitFor(() => {
      expect(directory.list).toHaveBeenCalled();
    });

    act(() => {
      result.current.restore({ expanded: [], selected: null, showHidden: false, changedOnly: true });
    });

    expect(result.current.state.changedOnly).toBe(true);
  });
});
