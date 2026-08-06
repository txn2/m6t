import { act, renderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { Git } from "./git";
import { emptyStatus } from "./git";
import { useGitOps } from "./useGitOps";

/** The seam with every member a spy, so a test can both assert on a call and
 * retarget its implementation mid-run. */
type SpiedGit = { [K in keyof Git]: Mock<Git[K]> };

/**
 * A Git seam whose every call is a spy, overridable per test.
 *
 * Overrides are re-wrapped rather than spread in. A plain function assigned
 * over a spy would type the member as its bare signature — losing
 * `mockImplementation`, which is what the tests that change an answer partway
 * through depend on.
 */
function fakeGit(overrides: Partial<Git> = {}): SpiedGit {
  const seam: SpiedGit = {
    status: vi.fn(() => Promise.resolve(emptyStatus())),
    stage: vi.fn(() => Promise.resolve()),
    unstage: vi.fn(() => Promise.resolve()),
    commit: vi.fn(() => Promise.resolve()),
    pull: vi.fn(() => Promise.resolve()),
    push: vi.fn(() => Promise.resolve()),
    checkout: vi.fn(() => Promise.resolve()),
    branches: vi.fn(() => Promise.resolve(["feature/x", "main"])),
    remotes: vi.fn(() => Promise.resolve(["origin"])),
  };
  for (const [name, implementation] of Object.entries(overrides)) {
    seam[name as keyof Git] = vi.fn(implementation) as never;
  }
  return seam;
}

/** Renders the hook against a root, waiting out the ref listing its mount
 * kicks off so a test's assertions are not racing it. */
async function mount(git: ReturnType<typeof fakeGit>, onChanged = vi.fn()) {
  const rendered = renderHook(() => useGitOps("/w/infra", onChanged, git));
  await waitFor(() => {
    expect(git.branches).toHaveBeenCalled();
  });
  return { ...rendered, onChanged };
}

describe("running an operation", () => {
  it("stages the paths it is given", async () => {
    const git = fakeGit();
    const { result } = await mount(git);

    act(() => {
      result.current.stage(["a.yaml", "b.yaml"]);
    });

    await waitFor(() => {
      expect(git.stage).toHaveBeenCalledWith("/w/infra", ["a.yaml", "b.yaml"]);
    });
  });

  it("passes the push flags through", async () => {
    const git = fakeGit();
    const { result } = await mount(git);

    act(() => {
      result.current.push("origin", true);
    });

    await waitFor(() => {
      expect(git.push).toHaveBeenCalledWith("/w/infra", "origin", true);
    });
  });

  // The status is read back through useGitStatus rather than returned by the
  // operation, so the refresh is what makes the panel correct.
  it("refreshes the status after it lands", async () => {
    const git = fakeGit();
    const { result, onChanged } = await mount(git);

    act(() => {
      result.current.unstage(["a.yaml"]);
    });

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
  });

  // The case that makes the refresh-on-failure rule necessary rather than
  // tidy: a failed pull exits non-zero AND leaves conflicted files behind, so
  // the panel is only correct if a failure refreshes too.
  it("refreshes the status after a failure as well", async () => {
    const git = fakeGit({ pull: vi.fn(() => Promise.reject(new Error("CONFLICT (content)"))) });
    const { result, onChanged } = await mount(git);

    act(() => {
      result.current.pull();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("CONFLICT (content)");
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("carries git's own message verbatim", async () => {
    const git = fakeGit({
      commit: vi.fn(() =>
        Promise.reject(new Error("git commit in /w/infra: nothing to commit, working tree clean")),
      ),
    });
    const { result } = await mount(git);

    await act(async () => {
      await result.current.commit("subject");
    });

    expect(result.current.error).toBe(
      "git commit in /w/infra: nothing to commit, working tree clean",
    );
  });

  it("reports whether a commit was recorded, so the editor keeps a failed draft", async () => {
    const git = fakeGit({ commit: vi.fn(() => Promise.reject(new Error("nothing to commit"))) });
    const { result } = await mount(git);

    let committed: boolean | null = null;
    await act(async () => {
      committed = await result.current.commit("subject");
    });
    expect(committed).toBe(false);

    git.commit.mockImplementation(() => Promise.resolve());
    await act(async () => {
      committed = await result.current.commit("subject");
    });
    expect(committed).toBe(true);
  });

  it("clears a previous failure when the next operation succeeds", async () => {
    const git = fakeGit({ pull: vi.fn(() => Promise.reject(new Error("boom"))) });
    const { result } = await mount(git);

    act(() => {
      result.current.pull();
    });
    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });

    act(() => {
      result.current.stage(["a.yaml"]);
    });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });

  it("can be dismissed without running anything", async () => {
    const git = fakeGit({ pull: vi.fn(() => Promise.reject(new Error("boom"))) });
    const { result } = await mount(git);

    act(() => {
      result.current.pull();
    });
    await waitFor(() => {
      expect(result.current.error).toBe("boom");
    });

    act(() => {
      result.current.dismissError();
    });
    expect(result.current.error).toBeNull();
  });

  // The generated binding throws synchronously with no Wails runtime behind
  // it, which is not an Error instance in every case.
  it("describes a rejection that is not an Error", async () => {
    const git = fakeGit({ pull: vi.fn(() => Promise.reject("plain string")) });
    const { result } = await mount(git);

    act(() => {
      result.current.pull();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("plain string");
    });
  });

  it("falls back to a sentence for a rejection that says nothing", async () => {
    const git = fakeGit({ pull: vi.fn(() => Promise.reject({ code: 7 })) });
    const { result } = await mount(git);

    act(() => {
      result.current.pull();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("the git backend is not reachable");
    });
  });

  it("runs nothing when there is no project", () => {
    const git = fakeGit();
    const { result } = renderHook(() => useGitOps(null, vi.fn(), git));

    act(() => {
      result.current.stage(["a.yaml"]);
    });

    expect(git.stage).not.toHaveBeenCalled();
    expect(git.branches).not.toHaveBeenCalled();
  });
});

describe("the busy flag", () => {
  it("is raised while an operation is in flight and lowered after it", async () => {
    let release = () => {
      /* replaced below */
    };
    const git = fakeGit({
      pull: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const { result } = await mount(git);

    act(() => {
      result.current.pull();
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  // `busy` belongs to the controller, not to the project. Clearing it only
  // when the operation's own project is still active leaves every git control
  // in the app disabled forever after a project switch during a slow push —
  // and nothing else resets it, because the project-change effect has no
  // reason to know an operation was running.
  it("is lowered even when the project changed while the operation ran", async () => {
    let release = () => {
      /* replaced below */
    };
    const git = fakeGit({
      push: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const { result, rerender } = renderHook(({ root }) => useGitOps(root, vi.fn(), git), {
      initialProps: { root: "/w/infra" as string | null },
    });

    act(() => {
      result.current.push("origin", false);
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    rerender({ root: "/w/apps" });
    await act(async () => {
      release();
    });

    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  // The message would name a repository that is no longer on screen.
  it("drops a failure that belongs to a project the user has left", async () => {
    let reject = (_: Error) => {
      /* replaced below */
    };
    const git = fakeGit({
      push: vi.fn(
        () =>
          new Promise<void>((_resolve, rejectIt) => {
            reject = rejectIt;
          }),
      ),
    });
    const { result, rerender } = renderHook(({ root }) => useGitOps(root, vi.fn(), git), {
      initialProps: { root: "/w/infra" as string | null },
    });

    act(() => {
      result.current.push("origin", false);
    });
    rerender({ root: "/w/apps" });
    await act(async () => {
      reject(new Error("git push in /w/infra: rejected"));
    });

    expect(result.current.error).toBeNull();
  });
});

describe("the branch and remote lists", () => {
  it("reads both for the project it is given", async () => {
    const git = fakeGit();
    const { result } = await mount(git);

    await waitFor(() => {
      expect(result.current.branches).toEqual(["feature/x", "main"]);
    });
    expect(result.current.remotes).toEqual(["origin"]);
    expect(git.branches).toHaveBeenCalledWith("/w/infra");
  });

  // A checkout changes which branches exist relative to HEAD and a first push
  // can create a remote-tracking setup, so the lists are re-read with the
  // status rather than only at mount.
  it("re-reads them after an operation", async () => {
    const git = fakeGit();
    const { result } = await mount(git);
    git.branches.mockImplementation(() => Promise.resolve(["main"]));

    act(() => {
      result.current.checkout("main");
    });

    await waitFor(() => {
      expect(result.current.branches).toEqual(["main"]);
    });
  });

  // These decorate controls; they are not the operation. A repository whose
  // `git remote` failed should leave the dropdown empty and the panel usable
  // rather than put an error over the changes list.
  it("leaves the lists empty when they cannot be read, without raising an error", async () => {
    const git = fakeGit({
      branches: vi.fn(() => Promise.reject(new Error("not a git repository"))),
      remotes: vi.fn(() => Promise.reject(new Error("not a git repository"))),
    });
    const { result } = await mount(git);

    await waitFor(() => {
      expect(result.current.branches).toEqual([]);
    });
    expect(result.current.remotes).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  // A project switch must not leave the previous repository's branches in the
  // dropdown while the new one's are being read.
  it("resets when the project changes", async () => {
    const git = fakeGit();
    const { result, rerender } = renderHook(({ root }) => useGitOps(root, vi.fn(), git), {
      initialProps: { root: "/w/infra" as string | null },
    });
    await waitFor(() => {
      expect(result.current.branches).toEqual(["feature/x", "main"]);
    });

    git.branches.mockImplementation(() => Promise.resolve(["other"]));
    rerender({ root: "/w/apps" });

    await waitFor(() => {
      expect(result.current.branches).toEqual(["other"]);
    });
    expect(git.branches).toHaveBeenLastCalledWith("/w/apps");
  });
});
