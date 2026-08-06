import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, Status } from "../lib/git";
import {
  ADDED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  RENAMED,
  UNTRACKED,
  emptyStatus,
} from "../lib/git";
import type { ChangesPanelProps } from "./ChangesPanel";
import { ChangesPanel } from "./ChangesPanel";

afterEach(cleanup);

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[]): Status {
  return { ...emptyStatus(), files };
}

/** Renders the panel with inert defaults for everything a test does not care
 * about, so a new prop does not have to be threaded through every case. */
function renderPanel(props: Partial<ChangesPanelProps> = {}) {
  const merged: ChangesPanelProps = {
    status: emptyStatus(),
    error: null,
    onOpenFile: vi.fn(),
    ...props,
  };
  render(<ChangesPanel {...merged} />);
  return merged;
}

describe("the changes list", () => {
  it("lists staged and unstaged work under their own headings", () => {
    renderPanel({
      status: statusOf([
        file("staged.yaml", { staged: ADDED }),
        file("edited.yaml", { worktree: MODIFIED }),
      ]),
    });

    expect(screen.getByRole("button", { name: "Staged: staged.yaml" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unstaged: edited.yaml" })).toBeDefined();
  });

  // The same path in both groups is the state a single row could not express.
  it("shows a file staged and then edited again in both groups", () => {
    renderPanel({ status: statusOf([file("a.yaml", { staged: ADDED, worktree: MODIFIED })]) });

    expect(screen.getByRole("button", { name: "Staged: a.yaml" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unstaged: a.yaml" })).toBeDefined();
  });

  it("omits a group with nothing in it rather than showing an empty heading", () => {
    renderPanel({ status: statusOf([file("a.yaml", { worktree: UNTRACKED })]) });

    expect(screen.queryByText("Staged")).toBeNull();
    expect(screen.getByText("Unstaged")).toBeDefined();
  });

  it("shows where a renamed file came from", () => {
    renderPanel({ status: statusOf([file("new.yaml", { staged: RENAMED, origPath: "old.yaml" })]) });

    expect(screen.getByText("← old.yaml")).toBeDefined();
  });

  it("says so when nothing has changed", () => {
    renderPanel();

    expect(screen.getByText("Nothing changed.")).toBeDefined();
  });

  // The same intent the file tree emits, so a row here and a row there do the
  // same thing.
  it("opens a file when its row is clicked", () => {
    const { onOpenFile } = renderPanel({
      status: statusOf([file("a/deploy.yaml", { worktree: MODIFIED })]),
    });

    fireEvent.click(screen.getByRole("button", { name: "Unstaged: a/deploy.yaml" }));

    expect(onOpenFile).toHaveBeenCalledWith("a/deploy.yaml");
  });
});

describe("what the panel does not do", () => {
  // The panel reports; the agent in the terminal writes (#39). A button here
  // would be a second writer of the index that the agent cannot see.
  it("offers no staging control on any row", () => {
    renderPanel({
      status: statusOf([
        file("a.yaml", { worktree: MODIFIED }),
        file("b.yaml", { staged: ADDED }),
        file("new.yaml", { staged: RENAMED, origPath: "old.yaml" }),
      ]),
    });

    // Exact names, not a prefix: every row's own accessible name starts with
    // "Staged:" or "Unstaged:", so a prefix match would find the rows and pass
    // for the wrong reason.
    for (const name of [
      "Stage a.yaml",
      "Unstage b.yaml",
      "Unstage new.yaml",
      "Stage all",
      "Unstage all",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  // Every row is the button that opens its file, and nothing else is.
  it("renders one button per row", () => {
    renderPanel({
      status: statusOf([
        file("a.yaml", { worktree: MODIFIED }),
        file("b.yaml", { staged: ADDED }),
      ]),
    });

    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Staged: b.yaml",
      "Unstaged: a.yaml",
    ]);
  });
});

describe("conflicts", () => {
  // v1 ships no merge tool (DESIGN.md §7), so the panel says where to go.
  it("groups unmerged paths on their own and points at the terminal", () => {
    renderPanel({ status: statusOf([file("a.yaml", { conflicted: true })]) });

    expect(screen.getByText("Conflicted")).toBeDefined();
    expect(screen.getByRole("button", { name: "Conflicted: a.yaml" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Resolve these in the terminal");
  });

  // A conflicted path groups with unstaged for badge purposes, but it belongs
  // to its own section here: an unmerged file is not an ordinary edit waiting
  // to be listed beside one.
  it("keeps a conflicted path out of the unstaged group", () => {
    renderPanel({ status: statusOf([file("a.yaml", { conflicted: true })]) });

    expect(screen.queryByText("Unstaged")).toBeNull();
  });

  // The conflicted path still counts as a change: "Nothing changed." beside a
  // conflict list would be two contradictory statements.
  it("does not claim nothing changed while a conflict is open", () => {
    renderPanel({ status: statusOf([file("a.yaml", { conflicted: true })]) });

    expect(screen.queryByText("Nothing changed.")).toBeNull();
  });
});

describe("the degraded states", () => {
  it.each([
    [NO_GIT, "git was not found on your PATH."],
    [NOT_A_REPOSITORY, "This project is not a git repository."],
  ])("explains the %s state", (availability, want) => {
    renderPanel({ status: { ...emptyStatus(), availability } });

    expect(screen.getByText(want)).toBeDefined();
    // No "nothing changed" alongside it: there is nothing to have changed,
    // and two messages would read as two separate facts.
    expect(screen.queryByText("Nothing changed.")).toBeNull();
  });

  it("shows a real failure as an alert", () => {
    renderPanel({ error: "fatal: bad object HEAD" });

    expect(screen.getByRole("alert").textContent).toBe("fatal: bad object HEAD");
  });
});
