import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileStatus, Status } from "../lib/git";
import { ADDED, MODIFIED, NOT_A_REPOSITORY, emptyStatus } from "../lib/git";
import { CommitBox } from "./CommitBox";

afterEach(cleanup);

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(files: FileStatus[]): Status {
  return { ...emptyStatus(), files };
}

function renderBox(status: Status, onCommit = vi.fn(() => Promise.resolve(true)), busy = false) {
  render(<CommitBox status={status} onCommit={onCommit} busy={busy} />);
  return onCommit;
}

const subjectField = () => screen.getByRole("textbox", { name: "Commit subject" });
const bodyField = () => screen.getByRole("textbox", { name: "Commit body" });
const commitButton = () => screen.getByRole("button", { name: "Commit" });

describe("committing", () => {
  it("sends the subject and body as one message", async () => {
    const onCommit = renderBox(statusOf([file("a.yaml", { staged: ADDED })]));

    fireEvent.change(subjectField(), { target: { value: "add the deployment" } });
    fireEvent.change(bodyField(), { target: { value: "Because X." } });
    fireEvent.click(commitButton());

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledWith("add the deployment\n\nBecause X.");
    });
  });

  it("clears the editor once the commit is recorded", async () => {
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]));

    fireEvent.change(subjectField(), { target: { value: "add the deployment" } });
    fireEvent.click(commitButton());

    await waitFor(() => {
      expect((subjectField() as HTMLInputElement).value).toBe("");
    });
  });

  // A draft thrown away on a failed commit is a draft the user has to retype,
  // and "nothing to commit" is a failure they will immediately want to retry.
  it("keeps the draft when the commit fails", async () => {
    const onCommit = vi.fn(() => Promise.resolve(false));
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]), onCommit);

    fireEvent.change(subjectField(), { target: { value: "add the deployment" } });
    fireEvent.click(commitButton());

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalled();
    });
    expect((subjectField() as HTMLInputElement).value).toBe("add the deployment");
  });
});

describe("the disabled button", () => {
  it("is enabled with a subject and something staged", () => {
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]));
    fireEvent.change(subjectField(), { target: { value: "s" } });

    expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("commit-blocked")).toBeNull();
  });

  // A disabled control with no explanation is the thing users file bugs about.
  it("says why with nothing staged", () => {
    const onCommit = renderBox(statusOf([file("a.yaml", { worktree: MODIFIED })]));
    fireEvent.change(subjectField(), { target: { value: "s" } });

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("commit-blocked").textContent).toBe("Stage something to commit.");

    fireEvent.click(commitButton());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("says why with no subject typed", () => {
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]));

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("commit-blocked").textContent).toBe("A commit needs a subject line.");
  });

  it("says why while a conflict is open", () => {
    renderBox(
      statusOf([file("a.yaml", { conflicted: true }), file("b.yaml", { staged: ADDED })]),
    );
    fireEvent.change(subjectField(), { target: { value: "s" } });

    expect(screen.getByTestId("commit-blocked").textContent).toBe(
      "Resolve the conflicted files before committing.",
    );
  });

  it("is disabled while an operation is in flight", () => {
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]), vi.fn(() => Promise.resolve(true)));
    fireEvent.change(subjectField(), { target: { value: "s" } });
    cleanup();

    renderBox(
      statusOf([file("a.yaml", { staged: ADDED })]),
      vi.fn(() => Promise.resolve(true)),
      true,
    );

    expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("what is staged", () => {
  it("counts the staged files", () => {
    renderBox(
      statusOf([file("a.yaml", { staged: ADDED }), file("b.yaml", { staged: MODIFIED })]),
    );

    expect(screen.getByTestId("commit-staged").textContent).toBe("2 files staged");
  });

  it("uses the singular for one", () => {
    renderBox(statusOf([file("a.yaml", { staged: ADDED })]));

    expect(screen.getByTestId("commit-staged").textContent).toBe("1 file staged");
  });

  it("says nothing is staged when nothing is", () => {
    renderBox(emptyStatus());

    expect(screen.getByTestId("commit-staged").textContent).toBe("nothing staged");
  });
});

// A project that is not a repository has nothing to commit to. The changes
// panel already explains why; a commit form beside that message would be a
// control that could never work.
it("renders nothing when git has no answer for the project", () => {
  render(
    <CommitBox
      status={{ ...emptyStatus(), availability: NOT_A_REPOSITORY }}
      onCommit={vi.fn(() => Promise.resolve(true))}
      busy={false}
    />,
  );

  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
});
