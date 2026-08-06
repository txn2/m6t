import { describe, expect, it } from "vitest";
import type { Branch, FileStatus, Status } from "./git";
import {
  ADDED,
  DELETED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  UNTRACKED,
  emptyStatus,
} from "./git";
import {
  checkoutBlockedReason,
  conflictedFiles,
  defaultRemote,
  isDirty,
  needsUpstream,
  pullBlockedReason,
  pushBlockedReason,
} from "./gitOps";

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[], branch: Partial<Branch> = {}): Status {
  const empty = emptyStatus();
  return { ...empty, branch: { ...empty.branch, name: "main", ...branch }, files };
}

describe("the conflicted paths", () => {
  it("collects them on their own", () => {
    const status = statusOf([
      file("a.yaml", { conflicted: true }),
      file("b.yaml", { worktree: MODIFIED }),
      file("c.yaml", { staged: ADDED }),
    ]);

    expect(conflictedFiles(status).map((f) => f.path)).toEqual(["a.yaml"]);
  });

  it("is empty on a tree with nothing unmerged", () => {
    expect(conflictedFiles(statusOf([file("a.yaml", { worktree: MODIFIED })]))).toEqual([]);
  });
});

describe("a dirty worktree", () => {
  it("counts staged and unstaged tracked changes", () => {
    expect(isDirty(statusOf([file("a.yaml", { staged: ADDED })]))).toBe(true);
    expect(isDirty(statusOf([file("a.yaml", { worktree: MODIFIED })]))).toBe(true);
    expect(isDirty(statusOf([file("a.yaml", { worktree: DELETED })]))).toBe(true);
    expect(isDirty(statusOf([file("a.yaml", { conflicted: true })]))).toBe(true);
  });

  // git carries untracked files across a checkout untouched. Treating them as
  // dirt would block a switch for a build directory git was never told about,
  // which in a manifest repository is most of them.
  it("does not count untracked files", () => {
    expect(isDirty(statusOf([file("dist/out.yaml", { worktree: UNTRACKED })]))).toBe(false);
  });

  it("is clean with nothing changed", () => {
    expect(isDirty(emptyStatus())).toBe(false);
  });
});

describe("blocking a branch switch", () => {
  it("allows one on a clean tree", () => {
    expect(checkoutBlockedReason(statusOf([]))).toBeNull();
    expect(checkoutBlockedReason(statusOf([file("d/o.yaml", { worktree: UNTRACKED })]))).toBeNull();
  });

  it("blocks on a dirty tree and says what to do", () => {
    expect(checkoutBlockedReason(statusOf([file("a.yaml", { worktree: MODIFIED })]))).toBe(
      "Commit or stash your changes before switching branches.",
    );
  });

  it("blocks in a repository with no commits", () => {
    expect(checkoutBlockedReason(statusOf([], { unborn: true }))).toBe(
      "This repository has no commits yet.",
    );
  });

  // The degraded states are the changes panel's to explain; a second sentence
  // about branches would be noise beside "git was not found on your PATH".
  it("says nothing when git is unavailable", () => {
    expect(checkoutBlockedReason({ ...emptyStatus(), availability: NO_GIT })).toBeNull();
    expect(
      checkoutBlockedReason({ ...emptyStatus(), availability: NOT_A_REPOSITORY }),
    ).toBeNull();
  });
});

describe("the upstream prompt", () => {
  it("is needed by a branch that tracks nothing", () => {
    expect(needsUpstream(statusOf([], { name: "feature/x", upstream: "" }))).toBe(true);
  });

  it("is not needed once the branch tracks something", () => {
    expect(needsUpstream(statusOf([], { upstream: "origin/main" }))).toBe(false);
  });

  // Neither of these has a branch to publish.
  it("is not needed on a detached or unborn HEAD", () => {
    expect(needsUpstream(statusOf([], { detached: true, name: "" }))).toBe(false);
    expect(needsUpstream(statusOf([], { unborn: true }))).toBe(false);
  });
});

describe("blocking the remote operations", () => {
  it("allows a push from a branch with commits", () => {
    expect(pushBlockedReason(statusOf([]))).toBeNull();
  });

  // Ahead/behind come from the last fetch and go stale. A button disabled on a
  // stale zero is worse than one that runs and reports "Everything up-to-date".
  it("allows a push that reports nothing ahead", () => {
    expect(pushBlockedReason(statusOf([], { upstream: "origin/main", ahead: 0 }))).toBeNull();
  });

  // The status a project starts on is available-shaped and empty, so without
  // this every other check passes on it and Push is live — a network mutation
  // on a repository nothing has been read for yet.
  it("blocks a push before the first status has landed", () => {
    expect(pushBlockedReason(emptyStatus())).toBe("Reading the repository…");
  });

  it("blocks a push with no commits and on a detached HEAD", () => {
    expect(pushBlockedReason(statusOf([], { unborn: true }))).toBe(
      "There are no commits to push yet.",
    );
    expect(pushBlockedReason(statusOf([], { detached: true }))).toBe(
      "HEAD is detached — check out a branch to push.",
    );
  });

  it("allows a pull on a branch with an upstream", () => {
    expect(pullBlockedReason(statusOf([], { upstream: "origin/main" }))).toBeNull();
  });

  it("blocks a pull with nothing to pull from", () => {
    expect(pullBlockedReason(statusOf([], { upstream: "" }))).toBe(
      "This branch tracks nothing to pull from.",
    );
    expect(pullBlockedReason(statusOf([], { detached: true, upstream: "origin/main" }))).toBe(
      "HEAD is detached — check out a branch to pull.",
    );
  });
});

describe("choosing a remote to publish to", () => {
  it("prefers origin, which is what a clone creates", () => {
    expect(defaultRemote(["upstream", "origin"])).toBe("origin");
  });

  it("takes the only remote when there is exactly one", () => {
    expect(defaultRemote(["fork"])).toBe("fork");
  });

  // Two remotes and no origin is a choice m6t has no basis to make, and a
  // guess would push someone's work to the wrong place.
  it("picks nothing when there is no basis to choose", () => {
    expect(defaultRemote(["fork", "upstream"])).toBe("");
    expect(defaultRemote([])).toBe("");
  });
});
