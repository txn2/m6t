import { describe, expect, it } from "vitest";
import type { Branch, FileStatus, Status } from "./git";
import {
  ADDED,
  AVAILABLE,
  COPIED,
  DELETED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  RENAMED,
  UNTRACKED,
  emptyStatus,
} from "./git";
import {
  badgeAt,
  badgeTitle,
  badgesFor,
  branchSummary,
  changedCount,
  fileBadge,
  groupChanges,
} from "./gitStatus";

/** One changed path, defaulting every field the case under test is not
 * about. */
function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[], branch: Partial<Branch> = {}): Status {
  const empty = emptyStatus();
  return { ...empty, branch: { ...empty.branch, ...branch }, files };
}

describe("a file's badge", () => {
  it.each([
    ["a worktree modification", { worktree: MODIFIED }, "M"],
    ["a staged addition", { staged: ADDED }, "A"],
    ["a deletion", { worktree: DELETED }, "D"],
    ["a rename", { staged: RENAMED, origPath: "old.yaml" }, "R"],
    ["a copy", { staged: COPIED, origPath: "src.yaml" }, "C"],
    ["an untracked file", { worktree: UNTRACKED }, "?"],
    ["a conflict", { conflicted: true }, "U"],
  ])("shows %s as %s", (_name, status, want) => {
    expect(fileBadge(file("a.yaml", status))).toBe(want);
  });

  // The tree row shows the file on disk, so the working tree's state is what
  // it reports. The changes panel is where both halves are visible.
  it("prefers the worktree side when a staged file was edited again", () => {
    expect(fileBadge(file("a.yaml", { staged: ADDED, worktree: MODIFIED }))).toBe("M");
  });

  // A conflict outranks both sides: it is the one state that blocks work.
  it("shows a conflict even when both sides carry a state", () => {
    expect(fileBadge(file("a.yaml", { staged: ADDED, worktree: MODIFIED, conflicted: true }))).toBe("U");
  });
});

describe("the directory rollup", () => {
  it("marks every directory above a changed file", () => {
    const badges = badgesFor(statusOf([file("a/b/one.yaml", { worktree: MODIFIED })]));

    expect(badgeAt(badges, "a/b/one.yaml", false)).toBe("M");
    expect(badgeAt(badges, "a/b", true)).toBe("•");
    expect(badgeAt(badges, "a", true)).toBe("•");
  });

  it("leaves a directory with no changed descendant unmarked", () => {
    const badges = badgesFor(statusOf([file("a/one.yaml", { worktree: MODIFIED })]));

    expect(badgeAt(badges, "b", true)).toBeNull();
  });

  // A conflict inside a collapsed directory is the case where "something
  // changed in here" is not enough to act on.
  it("escalates to a conflict marker when a descendant is unmerged", () => {
    const badges = badgesFor(
      statusOf([file("a/one.yaml", { worktree: MODIFIED }), file("a/two.yaml", { conflicted: true })]),
    );

    expect(badgeAt(badges, "a", true)).toBe("U");
  });

  // Order must not decide the answer: the conflict is second above and first
  // here, and both have to escalate.
  it("escalates regardless of the order the files arrive in", () => {
    const badges = badgesFor(
      statusOf([file("a/two.yaml", { conflicted: true }), file("a/one.yaml", { worktree: MODIFIED })]),
    );

    expect(badgeAt(badges, "a", true)).toBe("U");
  });

  // Moving a file out of a directory changes that directory too. Without
  // this, a collapsed source directory looks untouched after a rename.
  it("marks the directory a renamed file came from", () => {
    const badges = badgesFor(
      statusOf([file("new/a.yaml", { staged: RENAMED, origPath: "old/a.yaml" })]),
    );

    expect(badgeAt(badges, "old", true)).toBe("•");
    expect(badgeAt(badges, "new", true)).toBe("•");
  });

  // A submodule is a directory on disk and a single entry to git, so the
  // badge git reported for it must win over the rollup marker.
  it("prefers git's own entry over the rollup for a path that is both", () => {
    const badges = badgesFor(
      statusOf([file("sub", { staged: ADDED }), file("sub/inner.yaml", { worktree: MODIFIED })]),
    );

    expect(badgeAt(badges, "sub", true)).toBe("A");
  });

  it("gives a file row no directory badge", () => {
    const badges = badgesFor(statusOf([file("a/one.yaml", { worktree: MODIFIED })]));

    expect(badgeAt(badges, "a/one.yaml", false)).toBe("M");
    expect(badgeAt(badges, "untouched.yaml", false)).toBeNull();
  });

  it("marks nothing for a clean repository", () => {
    const badges = badgesFor(emptyStatus());

    expect(badges.files.size).toBe(0);
    expect(badges.dirs.size).toBe(0);
  });
});

describe("badge titles", () => {
  it.each([
    ["M", "modified"],
    ["A", "added"],
    ["D", "deleted"],
    ["R", "renamed"],
    ["C", "copied"],
    ["U", "conflicted"],
    ["?", "untracked"],
    ["•", "contains changes"],
  ])("describes %s as %s", (badge, want) => {
    expect(badgeTitle(badge)).toBe(want);
  });

  it("falls back to the badge itself for one it does not know", () => {
    expect(badgeTitle("Z")).toBe("Z");
  });
});

describe("the changes panel's groups", () => {
  it("puts a staged file in the staged group only", () => {
    const groups = groupChanges(statusOf([file("a.yaml", { staged: ADDED })]));

    expect(groups.staged.map((f) => f.path)).toEqual(["a.yaml"]);
    expect(groups.unstaged).toEqual([]);
  });

  it("puts an unstaged file in the unstaged group only", () => {
    const groups = groupChanges(statusOf([file("a.yaml", { worktree: MODIFIED })]));

    expect(groups.staged).toEqual([]);
    expect(groups.unstaged.map((f) => f.path)).toEqual(["a.yaml"]);
  });

  // The reason there are two groups rather than one list: staging a file and
  // then editing it again is a state a single row could not express.
  it("puts a file staged and then edited again in both", () => {
    const groups = groupChanges(statusOf([file("a.yaml", { staged: ADDED, worktree: MODIFIED })]));

    expect(groups.staged.map((f) => f.path)).toEqual(["a.yaml"]);
    expect(groups.unstaged.map((f) => f.path)).toEqual(["a.yaml"]);
  });

  // A conflict has no staged half to show: what git holds is three competing
  // versions, not an index entry the user chose.
  it("groups a conflict with the unstaged work", () => {
    const groups = groupChanges(statusOf([file("a.yaml", { conflicted: true })]));

    expect(groups.staged).toEqual([]);
    expect(groups.unstaged.map((f) => f.path)).toEqual(["a.yaml"]);
  });

  it("counts every reported path once", () => {
    expect(
      changedCount(statusOf([file("a.yaml", { staged: ADDED, worktree: MODIFIED }), file("b.yaml")])),
    ).toBe(2);
  });
});

describe("the status bar's branch line", () => {
  it("shows the branch, its counts and the change total", () => {
    const status = statusOf([file("a.yaml", { worktree: MODIFIED }), file("b.yaml", { worktree: MODIFIED })], {
      name: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
    });

    expect(branchSummary(status)).toBe("⎇ main ↑1 ↓2 · 2 changed");
  });

  // git reports no counts without an upstream, so printing ↑0 ↓0 would be
  // inventing a comparison rather than reporting one.
  it("omits the counts when the branch tracks nothing", () => {
    expect(branchSummary(statusOf([], { name: "main" }))).toBe("⎇ main · no changes");
  });

  it("counts one change in the singular", () => {
    expect(branchSummary(statusOf([file("a.yaml", { worktree: MODIFIED })], { name: "main" })))
      .toBe("⎇ main · 1 changed");
  });

  it("says so for a detached HEAD", () => {
    expect(branchSummary(statusOf([], { detached: true }))).toBe("⎇ detached HEAD · no changes");
  });

  it("names the branch a first commit would create", () => {
    expect(branchSummary(statusOf([], { name: "main", unborn: true })))
      .toBe("⎇ main (no commits yet) · no changes");
  });

  it("has something to say when there is no branch name at all", () => {
    expect(branchSummary(statusOf([]))).toBe("⎇ no branch · no changes");
  });

  it.each([
    [NO_GIT, "git was not found on your PATH"],
    [NOT_A_REPOSITORY, "not a git repository"],
  ])("explains the %s state instead of a branch", (availability, want) => {
    expect(branchSummary({ ...emptyStatus(), availability })).toBe(want);
  });

  it("reports a normal status for the available state", () => {
    expect(branchSummary({ ...emptyStatus(), availability: AVAILABLE })).toContain("⎇");
  });
});
