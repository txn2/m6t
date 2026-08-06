import { describe, expect, it } from "vitest";
import type { Branch, FileStatus, Status } from "./git";
import {
  ADDED,
  DELETED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  RENAMED,
  UNTRACKED,
  emptyStatus,
} from "./git";
import {
  checkoutBlockedReason,
  commitBlockedReason,
  commitMessage,
  conflictedFiles,
  defaultRemote,
  hasMessage,
  isDirty,
  needsUpstream,
  pathsOf,
  pathsOfAll,
  pullBlockedReason,
  pushBlockedReason,
  stagedPaths,
} from "./gitOps";

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[], branch: Partial<Branch> = {}): Status {
  const empty = emptyStatus();
  return { ...empty, branch: { ...empty.branch, name: "main", ...branch }, files };
}

describe("building the commit message", () => {
  it("separates the subject from the body with a blank line", () => {
    expect(commitMessage({ subject: "add the deployment", body: "Because X." })).toBe(
      "add the deployment\n\nBecause X.",
    );
  });

  // A subject with two trailing newlines makes `git log --format=%b` report a
  // body of whitespace where there is none.
  it("is just the subject when there is no body", () => {
    expect(commitMessage({ subject: "add the deployment", body: "   \n" })).toBe(
      "add the deployment",
    );
  });

  it("trims each field", () => {
    expect(commitMessage({ subject: "  subject  ", body: "  body  " })).toBe("subject\n\nbody");
  });

  // The body alone is not a message: a commit with a blank subject shows up as
  // an empty row in every log.
  it("needs a subject", () => {
    expect(hasMessage({ subject: "", body: "a body" })).toBe(false);
    expect(hasMessage({ subject: "   ", body: "a body" })).toBe(false);
    expect(hasMessage({ subject: "s", body: "" })).toBe(true);
  });
});

describe("what is staged", () => {
  it("lists the paths whose index side differs", () => {
    const status = statusOf([
      file("staged.yaml", { staged: ADDED }),
      file("edited.yaml", { worktree: MODIFIED }),
      file("both.yaml", { staged: ADDED, worktree: MODIFIED }),
    ]);

    expect(stagedPaths(status)).toEqual(["staged.yaml", "both.yaml"]);
  });

  // An unmerged path has no index-versus-HEAD split to report, so counting it
  // as staged would enable a commit of a half-merged tree.
  it("excludes conflicted paths", () => {
    expect(stagedPaths(statusOf([file("a.yaml", { conflicted: true })]))).toEqual([]);
  });

  it("collects the conflicted paths on their own", () => {
    const status = statusOf([
      file("a.yaml", { conflicted: true }),
      file("b.yaml", { worktree: MODIFIED }),
    ]);

    expect(conflictedFiles(status).map((f) => f.path)).toEqual(["a.yaml"]);
  });
});

describe("the paths a row's action acts on", () => {
  it("is just the path for an ordinary change", () => {
    expect(pathsOf(file("a.yaml", { worktree: MODIFIED }))).toEqual(["a.yaml"]);
  });

  // Unstaging only `new.yaml` after a `git mv` leaves `old.yaml` staged as a
  // deletion — a change the user did not ask for, sitting in the index, that
  // the next commit would carry out.
  it("includes a rename's source, so half a rename is never left staged", () => {
    expect(pathsOf(file("new.yaml", { staged: RENAMED, origPath: "old.yaml" }))).toEqual([
      "new.yaml",
      "old.yaml",
    ]);
  });

  // A rename's source can also be another row's path, and passing the same
  // pathspec twice is a pointless argument rather than a wrong one — but the
  // group action is the one place it would happen every time.
  it("deduplicates across a group", () => {
    const files = [
      file("new.yaml", { staged: RENAMED, origPath: "old.yaml" }),
      file("old.yaml", { staged: DELETED }),
    ];

    expect(pathsOfAll(files)).toEqual(["new.yaml", "old.yaml"]);
  });
});

describe("blocking a commit", () => {
  it("allows one with a subject and something staged", () => {
    const status = statusOf([file("a.yaml", { staged: ADDED })]);

    expect(commitBlockedReason(status, { subject: "add a", body: "" })).toBeNull();
  });

  it("blocks with nothing staged", () => {
    const status = statusOf([file("a.yaml", { worktree: MODIFIED })]);

    expect(commitBlockedReason(status, { subject: "add a", body: "" })).toBe(
      "Stage something to commit.",
    );
  });

  it("blocks with no subject", () => {
    const status = statusOf([file("a.yaml", { staged: ADDED })]);

    expect(commitBlockedReason(status, { subject: "  ", body: "a body" })).toBe(
      "A commit needs a subject line.",
    );
  });

  // Committing a half-merged tree is the mistake worth naming first, so a
  // conflict outranks the other two reasons.
  it("blocks on a conflict even when something else is staged and typed", () => {
    const status = statusOf([
      file("a.yaml", { conflicted: true }),
      file("b.yaml", { staged: ADDED }),
    ]);

    expect(commitBlockedReason(status, { subject: "ship it", body: "" })).toBe(
      "Resolve the conflicted files before committing.",
    );
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
