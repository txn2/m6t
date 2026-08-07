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
  badgeTone,
  badgesFor,
  branchSummary,
  changedCount,
  changedRows,
  fileBadge,
  isTracked,
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
  // it reports. Which half of a doubly-changed file the letter came from is
  // the one thing a single row cannot say, and it is the badge's tooltip and
  // the terminal below that say it.
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

  // `git status` collapses a directory whose every file is untracked into one
  // record with a trailing slash — `? build/`. Filed under that name the badge
  // would be on nothing: the tree's row for it is `build`.
  it("badges a wholly untracked directory on the row that exists", () => {
    const badges = badgesFor(statusOf([file("build/", { worktree: UNTRACKED })]));

    expect(badgeAt(badges, "build", true)).toBe("?");
    expect(badges.files.has("build/")).toBe(false);
  });

  it("rolls a wholly untracked directory up to the directory above it", () => {
    const badges = badgesFor(statusOf([file("a/build/", { worktree: UNTRACKED })]));

    expect(badgeAt(badges, "a/build", true)).toBe("?");
    expect(badgeAt(badges, "a", true)).toBe("•");
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

describe("counting changes", () => {
  it("counts every reported path once", () => {
    expect(
      changedCount(statusOf([file("a.yaml", { staged: ADDED, worktree: MODIFIED }), file("b.yaml")])),
    ).toBe(2);
  });
});

describe("badge tones (#40)", () => {
  it.each([
    ["M", "modified"],
    ["R", "modified"],
    ["C", "modified"],
    ["A", "added"],
    ["?", "added"],
    ["D", "deleted"],
    ["U", "conflicted"],
    ["\u2022", "contains"],
  ])("draws %s in the %s tone", (badge, want) => {
    expect(badgeTone(badge)).toBe(want);
  });

  it("has no tone for a row git said nothing about", () => {
    expect(badgeTone(null)).toBeNull();
  });

  it("has no tone for a badge it does not know", () => {
    expect(badgeTone("Z")).toBeNull();
  });
});

describe("the changed-only rows (#40)", () => {
  /** What the mode renders, as "path@depth" pairs — the two facts a row
   * carries that a name alone would not catch. */
  function shape(status: Status): string[] {
    return changedRows(status).map((row) => `${row.path}@${String(row.depth)}`);
  }

  it("puts a change under every ancestor directory it lives in", () => {
    expect(shape(statusOf([file("a/b/one.yaml", { worktree: MODIFIED })]))).toEqual([
      "a@0",
      "a/b@1",
      "a/b/one.yaml@2",
    ]);
  });

  it("names each row by its own segment rather than its path", () => {
    expect(changedRows(statusOf([file("a/b/one.yaml", { worktree: MODIFIED })])).map((r) => r.name))
      .toEqual(["a", "b", "one.yaml"]);
  });

  it("gives every ancestor exactly one row, however many changes it holds", () => {
    const status = statusOf([
      file("a/one.yaml", { worktree: MODIFIED }),
      file("a/two.yaml", { worktree: MODIFIED }),
    ]);

    expect(shape(status)).toEqual(["a@0", "a/one.yaml@1", "a/two.yaml@1"]);
  });

  // The same order internal/watch.sortEntries lists a real directory in, so
  // switching modes does not reshuffle the paths that appear in both.
  it("orders directories before files, then case-insensitively by name", () => {
    const status = statusOf([
      file("Zebra.yaml", { worktree: MODIFIED }),
      file("apple.yaml", { worktree: MODIFIED }),
      file("dir/inner.yaml", { worktree: MODIFIED }),
    ]);

    expect(shape(status)).toEqual([
      "dir@0",
      "dir/inner.yaml@1",
      "apple.yaml@0",
      "Zebra.yaml@0",
    ]);
  });

  // A deleted file is in no directory listing, which is the whole reason this
  // mode builds its rows from the status rather than filtering the tree.
  it("includes a path that is no longer on disk", () => {
    expect(shape(statusOf([file("gone.yaml", { staged: DELETED })]))).toEqual(["gone.yaml@0"]);
  });

  // The tree's hidden toggle answers "what is in here"; hiding a changed
  // dotfile from the list of changes answers a question nobody asked.
  it("does not hide dotfiles", () => {
    expect(shape(statusOf([file(".github/workflows/ci.yml", { worktree: MODIFIED })]))).toEqual([
      ".github@0",
      ".github/workflows@1",
      ".github/workflows/ci.yml@2",
    ]);
  });

  // Its source is gone and its destination is here; two rows would read as
  // two changes where git reported one.
  it("shows a rename once, at its destination", () => {
    expect(shape(statusOf([file("new/a.yaml", { staged: RENAMED, origPath: "old/a.yaml" })])))
      .toEqual(["new@0", "new/a.yaml@1"]);
  });

  // A submodule is a directory on disk and one entry to git. One row, and it
  // is the directory — `badgeAt` is what puts git's own badge on it.
  it("gives a path that is both a directory and an entry a single row", () => {
    const status = statusOf([
      file("sub", { staged: ADDED }),
      file("sub/inner.yaml", { worktree: MODIFIED }),
    ]);

    expect(shape(status)).toEqual(["sub@0", "sub/inner.yaml@1"]);
  });

  it("has nothing to show for a clean repository", () => {
    expect(changedRows(emptyStatus())).toEqual([]);
  });

  // One record for the whole directory (`? build/`), so one row — and it is a
  // directory row, not a nameless file row under a directory of the same
  // name, which is what the trailing slash produces if it is taken literally.
  it("shows a wholly untracked directory as one directory row", () => {
    const rows = changedRows(statusOf([file("a/build/", { worktree: UNTRACKED })]));

    expect(rows.map((r) => `${r.path}@${String(r.depth)}`)).toEqual(["a@0", "a/build@1"]);
    expect(rows.map((r) => r.name)).toEqual(["a", "build"]);
    expect(rows.every((r) => r.isDir)).toBe(true);
  });
});

describe("whether a path is tracked (#52)", () => {
  // git emits a record only for a path that differs, so a path it did not
  // mention is a tracked path with nothing to report. Reading the absence the
  // other way would take the blame column off every unmodified file in the
  // repository — which is most of them.
  it("counts a path git did not mention as tracked", () => {
    expect(isTracked(statusOf([file("other.yaml", { worktree: MODIFIED })]), "deploy.yaml")).toBe(
      true,
    );
  });

  it("counts a changed path as tracked", () => {
    expect(isTracked(statusOf([file("deploy.yaml", { worktree: MODIFIED })]), "deploy.yaml")).toBe(
      true,
    );
  });

  it("counts a staged new path as tracked", () => {
    // `git add` on a new file puts it in the index, and blame answers for it:
    // every line comes back uncommitted.
    expect(isTracked(statusOf([file("new.yaml", { staged: ADDED })]), "new.yaml")).toBe(true);
  });

  it("does not count an untracked path", () => {
    expect(isTracked(statusOf([file("scratch.yaml", { worktree: UNTRACKED })]), "scratch.yaml")).toBe(
      false,
    );
  });

  it("counts nothing when git is missing or the project is not a repository", () => {
    for (const availability of [NO_GIT, NOT_A_REPOSITORY]) {
      expect(isTracked({ ...emptyStatus(), availability }, "deploy.yaml")).toBe(false);
    }
  });

  it("matches the whole path, not a suffix of it", () => {
    const status = statusOf([file("deploy/deploy.yaml", { worktree: UNTRACKED })]);

    expect(isTracked(status, "deploy.yaml")).toBe(true);
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

  // v1 ships no merge tool (DESIGN.md §7). The instruction used to sit above
  // the changes panel's conflict group; with the panel gone (#40) it belongs
  // where it is visible whatever the tree is showing.
  it("says where to resolve a conflict", () => {
    const status = statusOf(
      [file("a.yaml", { conflicted: true }), file("b.yaml", { worktree: MODIFIED })],
      { name: "main" },
    );

    expect(branchSummary(status)).toBe(
      "⎇ main · 2 changed · 1 conflicted — resolve in the terminal",
    );
  });

  it("counts every unmerged path", () => {
    const status = statusOf(
      [file("a.yaml", { conflicted: true }), file("b.yaml", { conflicted: true })],
      { name: "main" },
    );

    expect(branchSummary(status)).toContain("2 conflicted");
  });

  it("says nothing about conflicts when there are none", () => {
    expect(branchSummary(statusOf([file("a.yaml", { worktree: MODIFIED })], { name: "main" })))
      .not.toContain("conflicted");
  });
});
