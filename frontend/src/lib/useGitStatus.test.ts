import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileStatus, Status } from "./git";
import { MODIFIED, NOT_A_REPOSITORY, UNTRACKED, emptyStatus } from "./git";
import { useGitStatus } from "./useGitStatus";

const endpoint = { port: 51234, token: "tok" };

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[], branchName = "main"): Status {
  const empty = emptyStatus();
  return { ...empty, branch: { ...empty.branch, name: branchName }, files };
}

/** A Git seam whose answers a test controls, keyed by root. */
function fakeGit(byRoot: Record<string, Status>) {
  return {
    status: vi.fn((root: string) => Promise.resolve(byRoot[root] ?? emptyStatus())),
  };
}

/** A minimal fake WebSocket — the same shape useFileTree's own tests use, so
 * no jsdom WebSocket is needed. */
function fakeSocketFactory() {
  const sockets: { onmessage: ((event: MessageEvent) => void) | null; close: () => void }[] = [];
  const factory = vi.fn(() => {
    const socket = { onmessage: null, close: vi.fn() };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { factory, sockets };
}

/** A `git` event frame for root, as the backend publishes it (PROTOCOL.md §5). */
function gitEvent(root: string): MessageEvent {
  return { data: JSON.stringify({ type: "git", payload: { root } }) } as MessageEvent;
}

describe("reading a project's status", () => {
  it("reads it as soon as a project is given", async () => {
    const git = fakeGit({ "/w/infra": statusOf([file("a.yaml", { worktree: MODIFIED })]) });
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });
    expect(result.current.status.branch.name).toBe("main");
    expect(git.status).toHaveBeenCalledWith("/w/infra");
  });

  it("reads nothing when there is no project", () => {
    const git = fakeGit({});
    renderHook(() => useGitStatus(null, null, git));

    expect(git.status).not.toHaveBeenCalled();
  });

  // The previous project's badges must not sit on the new project's tree
  // while its first read is in flight.
  it("shows a project it has never read nothing of the last one's", async () => {
    const git = fakeGit({
      "/w/infra": statusOf([file("a.yaml", { worktree: MODIFIED })]),
      "/w/other": statusOf([]),
    });
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useGitStatus(root, null, git),
      { initialProps: { root: "/w/infra" as string | null } },
    );
    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });

    rerender({ root: "/w/other" });

    expect(result.current.status.files).toHaveLength(0);
  });

  // The degraded states are not errors: they arrive on the status so the
  // status bar can explain them, and `error` stays null.
  it("carries a not-a-repository state without reporting an error", async () => {
    const git = fakeGit({ "/w/infra": { ...emptyStatus(), availability: NOT_A_REPOSITORY } });
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.status.availability).toBe(NOT_A_REPOSITORY);
    });
    expect(result.current.error).toBeNull();
  });
});

describe("failures", () => {
  it("reports a rejected read", async () => {
    const git = { status: vi.fn(() => Promise.reject(new Error("git exploded"))) };
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.error).toBe("git exploded");
    });
  });

  // The generated binding throws synchronously when there is no Wails runtime
  // behind it, which would escape an unguarded promise chain.
  it("reports a binding that throws synchronously", async () => {
    const git = {
      status: vi.fn(() => {
        throw new Error("no Wails runtime");
      }),
    };
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.error).toBe("no Wails runtime");
    });
  });

  it("describes a rejection that is not an Error", async () => {
    const git = { status: vi.fn(() => Promise.reject("just a string")) };
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.error).toBe("just a string");
    });
  });

  it("has a sentence for a rejection that is neither", async () => {
    const git = { status: vi.fn(() => Promise.reject({ nope: true })) };
    const { result } = renderHook(() => useGitStatus("/w/infra", null, git));

    await waitFor(() => {
      expect(result.current.error).toBe("the git backend is not reachable");
    });
  });

  // Stale badges plus a visible reason beats no badges: the last good answer
  // stays on screen while the failure is reported.
  it("keeps the last good status when a later read fails", async () => {
    let fail = false;
    const git = {
      status: vi.fn(() =>
        fail ? Promise.reject(new Error("boom")) : Promise.resolve(statusOf([file("a.yaml")])),
      ),
    };
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useGitStatus("/w/infra", endpoint, git, factory));
    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });

    fail = true;
    await act(async () => {
      sockets[0].onmessage?.(gitEvent("/w/infra"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });
    expect(result.current.status.files).toHaveLength(1);
  });

  it("clears a previous failure once a read succeeds", async () => {
    let fail = true;
    const git = {
      status: vi.fn(() =>
        fail ? Promise.reject(new Error("boom")) : Promise.resolve(statusOf([file("a.yaml")])),
      ),
    };
    const { factory, sockets } = fakeSocketFactory();
    const { result } = renderHook(() => useGitStatus("/w/infra", endpoint, git, factory));
    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });

    fail = false;
    await act(async () => {
      sockets[0].onmessage?.(gitEvent("/w/infra"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });
});

describe("staying current from /events", () => {
  it("reads again when the backend says this project changed", async () => {
    const git = fakeGit({ "/w/infra": statusOf([]) });
    const { factory, sockets } = fakeSocketFactory();
    renderHook(() => useGitStatus("/w/infra", endpoint, git, factory));
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      sockets[0].onmessage?.(gitEvent("/w/infra"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(git.status).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores a change to a different project", async () => {
    const git = fakeGit({ "/w/infra": statusOf([]) });
    const { factory, sockets } = fakeSocketFactory();
    renderHook(() => useGitStatus("/w/infra", endpoint, git, factory));
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      sockets[0].onmessage?.(gitEvent("/w/elsewhere"));
      await Promise.resolve();
    });

    expect(git.status).toHaveBeenCalledTimes(1);
  });

  it("opens no socket without an endpoint", () => {
    const { factory } = fakeSocketFactory();
    renderHook(() => useGitStatus("/w/infra", null, fakeGit({}), factory));

    expect(factory).not.toHaveBeenCalled();
  });

  // `fakeGit({})` above is built inside the render callback, so the seam is a
  // different object on every render. A hook that rebuilt its reader from
  // that would reset its state, re-render, and loop until the process ran out
  // of memory — which is exactly what this hook did before `seam`. Keeping
  // the unstable seam here is the regression test.
  it("survives a caller that passes a new seam on every render", async () => {
    const { result } = renderHook(() =>
      useGitStatus("/w/infra", null, {
        status: () => Promise.resolve(statusOf([file("a.yaml", { worktree: MODIFIED })])),
      }),
    );

    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });
  });

  it("closes its socket when the project changes", async () => {
    const git = fakeGit({});
    const { factory, sockets } = fakeSocketFactory();
    const { rerender } = renderHook(
      ({ root }: { root: string | null }) => useGitStatus(root, endpoint, git, factory),
      { initialProps: { root: "/w/infra" as string | null } },
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    rerender({ root: "/w/other" });

    expect(sockets[0].close).toHaveBeenCalled();
  });
});

describe("not stacking reads", () => {
  // A branch switch produces a batch every 250ms while thousands of files
  // move. Each one is a subprocess, so they must not stack: one in flight,
  // one queued, and the queued one is the trailing edge.
  it("collapses a burst of events into one queued re-read", async () => {
    // An array rather than a single mutable binding: TypeScript narrows a
    // `let` assigned only inside a callback to `null` at every read site.
    const releases: (() => void)[] = [];
    const git = {
      status: vi.fn(
        () =>
          new Promise<Status>((resolve) => {
            releases.push(() => {
              resolve(statusOf([]));
            });
          }),
      ),
    };
    const { factory, sockets } = fakeSocketFactory();
    renderHook(() => useGitStatus("/w/infra", endpoint, git, factory));

    await waitFor(() => {
      expect(git.status).toHaveBeenCalledTimes(1);
    });

    // Five events arrive while the first read is still running.
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        sockets[0].onmessage?.(gitEvent("/w/infra"));
      }
      await Promise.resolve();
    });
    expect(git.status).toHaveBeenCalledTimes(1);

    // Letting the first finish runs exactly one more, not five.
    await act(async () => {
      releases[0]();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(git.status).toHaveBeenCalledTimes(2);
    });

    // And letting that one finish runs nothing further: the queue held one
    // trailing re-read, not five.
    await act(async () => {
      releases[1]();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(git.status).toHaveBeenCalledTimes(2);
  });

  // A read in flight when the project changes belongs to the old project, and
  // is recorded against it: what it must never do is put one repository's
  // badges on another's tree.
  it("keeps a read that lands after the project changed off the visible badges", async () => {
    const answers: Record<string, () => void> = {};
    const git = {
      status: vi.fn(
        (root: string) =>
          new Promise<Status>((resolve) => {
            answers[root] = () => {
              resolve(statusOf([file(`${root}/only.yaml`, { worktree: UNTRACKED })]));
            };
          }),
      ),
    };
    const { result, rerender } = renderHook(
      ({ root }: { root: string | null }) => useGitStatus(root, null, git),
      { initialProps: { root: "/w/infra" as string | null } },
    );
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledWith("/w/infra");
    });

    rerender({ root: "/w/other" });

    // The first project's answer arrives late.
    await act(async () => {
      answers["/w/infra"]();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status.files).toHaveLength(0);

    // ...and the new project's read is the one that lands.
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledWith("/w/other");
    });
    await act(async () => {
      answers["/w/other"]();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.status.files[0]?.path).toBe("/w/other/only.yaml");
    });

    // The late answer was not thrown away — it went to the project it was read
    // from, which is what that project comes back to.
    rerender({ root: "/w/infra" });
    expect(result.current.status.files[0]?.path).toBe("/w/infra/only.yaml");
  });
});

describe("keeping a project's badges across a switch (#59)", () => {
  it("shows the last-known status on return and re-reads behind it", async () => {
    const git = fakeGit({
      "/w/infra": statusOf([file("a.yaml", { worktree: MODIFIED })]),
      "/w/apps": statusOf([]),
    });
    const { result, rerender } = renderHook(({ root }: { root: string }) => useGitStatus(root, null, git), {
      initialProps: { root: "/w/infra" },
    });
    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });

    rerender({ root: "/w/apps" });
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledWith("/w/apps");
    });
    git.status.mockClear();

    rerender({ root: "/w/infra" });

    // Synchronously, before the re-read this switch started has landed: the
    // badges the user left are the ones they come back to.
    expect(result.current.status.files[0]?.path).toBe("a.yaml");
    expect(git.status).toHaveBeenCalledWith("/w/infra");
  });

  it("updates the retained badges once the fresh read lands", async () => {
    const byRoot: Record<string, Status> = {
      "/w/infra": statusOf([file("a.yaml", { worktree: MODIFIED })]),
      "/w/apps": statusOf([]),
    };
    const git = fakeGit(byRoot);
    const { result, rerender } = renderHook(({ root }: { root: string }) => useGitStatus(root, null, git), {
      initialProps: { root: "/w/infra" },
    });
    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });

    rerender({ root: "/w/apps" });
    byRoot["/w/infra"] = statusOf([file("b.yaml", { worktree: UNTRACKED })]);
    rerender({ root: "/w/infra" });

    await waitFor(() => {
      expect(result.current.status.files[0]?.path).toBe("b.yaml");
    });
  });

  it("forgets a project that has left the registry", async () => {
    const git = fakeGit({ "/w/infra": statusOf([file("a.yaml", { worktree: MODIFIED })]) });
    const { result, rerender } = renderHook(({ root }: { root: string }) => useGitStatus(root, null, git), {
      initialProps: { root: "/w/infra" },
    });
    await waitFor(() => {
      expect(result.current.status.files).toHaveLength(1);
    });

    rerender({ root: "/w/apps" });
    act(() => {
      result.current.closeProject("/w/infra");
    });
    rerender({ root: "/w/infra" });

    // Nothing retained: the map holds no entry for a project the registry no
    // longer has, so the badges start where a new project's do.
    expect(result.current.status.files).toHaveLength(0);
  });

  it("drops a read that lands after the project left the registry", async () => {
    let release: (status: Status) => void = () => undefined;
    const git = {
      status: vi.fn(
        () =>
          new Promise<Status>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const { result } = renderHook(({ root }: { root: string }) => useGitStatus(root, null, git), {
      initialProps: { root: "/w/infra" },
    });
    await waitFor(() => {
      expect(git.status).toHaveBeenCalledWith("/w/infra");
    });

    act(() => {
      result.current.closeProject("/w/infra");
    });
    await act(async () => {
      release(statusOf([file("a.yaml", { worktree: MODIFIED })]));
    });

    // A `git status` is a subprocess, so a removal lands mid-read easily. Its
    // answer must not put the entry back that the removal just dropped.
    expect(result.current.status.files).toHaveLength(0);
  });
});
