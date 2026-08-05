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
import { ChangesPanel } from "./ChangesPanel";

afterEach(cleanup);

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[]): Status {
  return { ...emptyStatus(), files };
}

describe("the changes list", () => {
  it("lists staged and unstaged work under their own headings", () => {
    render(
      <ChangesPanel
        status={statusOf([
          file("staged.yaml", { staged: ADDED }),
          file("edited.yaml", { worktree: MODIFIED }),
        ])}
        error={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Staged: staged.yaml" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unstaged: edited.yaml" })).toBeDefined();
  });

  // The same path in both groups is the state a single row could not express.
  it("shows a file staged and then edited again in both groups", () => {
    render(
      <ChangesPanel
        status={statusOf([file("a.yaml", { staged: ADDED, worktree: MODIFIED })])}
        error={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Staged: a.yaml" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unstaged: a.yaml" })).toBeDefined();
  });

  it("omits a group with nothing in it rather than showing an empty heading", () => {
    render(
      <ChangesPanel
        status={statusOf([file("a.yaml", { worktree: UNTRACKED })])}
        error={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.queryByText("Staged")).toBeNull();
    expect(screen.getByText("Unstaged")).toBeDefined();
  });

  it("shows where a renamed file came from", () => {
    render(
      <ChangesPanel
        status={statusOf([file("new.yaml", { staged: RENAMED, origPath: "old.yaml" })])}
        error={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText("← old.yaml")).toBeDefined();
  });

  it("says so when nothing has changed", () => {
    render(<ChangesPanel status={emptyStatus()} error={null} onOpenFile={vi.fn()} />);

    expect(screen.getByText("Nothing changed.")).toBeDefined();
  });

  // The same intent the file tree emits, so a row here and a row there do the
  // same thing.
  it("opens a file when its row is clicked", () => {
    const onOpenFile = vi.fn();
    render(
      <ChangesPanel
        status={statusOf([file("a/deploy.yaml", { worktree: MODIFIED })])}
        error={null}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unstaged: a/deploy.yaml" }));

    expect(onOpenFile).toHaveBeenCalledWith("a/deploy.yaml");
  });
});

describe("the degraded states", () => {
  it.each([
    [NO_GIT, "git was not found on your PATH."],
    [NOT_A_REPOSITORY, "This project is not a git repository."],
  ])("explains the %s state", (availability, want) => {
    render(
      <ChangesPanel
        status={{ ...emptyStatus(), availability }}
        error={null}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByText(want)).toBeDefined();
    // No "nothing changed" alongside it: there is nothing to have changed,
    // and two messages would read as two separate facts.
    expect(screen.queryByText("Nothing changed.")).toBeNull();
  });

  it("shows a real failure as an alert", () => {
    render(
      <ChangesPanel status={emptyStatus()} error="fatal: bad object HEAD" onOpenFile={vi.fn()} />,
    );

    expect(screen.getByRole("alert").textContent).toBe("fatal: bad object HEAD");
  });
});
