import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branch, FileStatus, Status } from "../lib/git";
import { MODIFIED, NOT_A_REPOSITORY, UNTRACKED, emptyStatus } from "../lib/git";
import type { BranchBarProps } from "./BranchBar";
import { BranchBar } from "./BranchBar";

afterEach(cleanup);

function file(path: string, overrides: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...overrides };
}

function statusOf(branch: Partial<Branch> = {}, files: FileStatus[] = []): Status {
  const empty = emptyStatus();
  return {
    ...empty,
    branch: { ...empty.branch, name: "main", upstream: "origin/main", ...branch },
    files,
  };
}

function renderBar(props: Partial<BranchBarProps> = {}) {
  const merged: BranchBarProps = {
    status: statusOf(),
    branches: ["feature/x", "main"],
    remotes: ["origin"],
    error: null,
    busy: false,
    onCheckout: vi.fn(),
    onPull: vi.fn(),
    onPush: vi.fn(),
    onDismissError: vi.fn(),
    ...props,
  };
  render(<BranchBar {...merged} />);
  return merged;
}

const branchSelect = () => screen.getByRole("combobox", { name: "Branch" }) as HTMLSelectElement;

describe("switching branches", () => {
  it("offers the local branches with the current one selected", () => {
    renderBar();

    expect(branchSelect().value).toBe("main");
    expect(screen.getByRole("option", { name: "feature/x" })).toBeDefined();
  });

  it("checks out the branch that is chosen", () => {
    const { onCheckout } = renderBar();

    fireEvent.change(branchSelect(), { target: { value: "feature/x" } });

    expect(onCheckout).toHaveBeenCalledWith("feature/x");
  });

  // The dirty check is m6t's, made before git runs, so it can say what to do
  // about it — git would only refuse for the files that actually collide.
  it("is blocked on a dirty worktree, with the reason on screen", () => {
    const { onCheckout } = renderBar({
      status: statusOf({}, [file("a.yaml", { worktree: MODIFIED })]),
    });

    expect(branchSelect().disabled).toBe(true);
    expect(screen.getByTestId("checkout-blocked").textContent).toBe(
      "Commit or stash your changes before switching branches.",
    );

    fireEvent.change(branchSelect(), { target: { value: "feature/x" } });
    expect(onCheckout).not.toHaveBeenCalled();
  });

  // git carries untracked files across a checkout untouched.
  it("is not blocked by untracked files alone", () => {
    renderBar({ status: statusOf({}, [file("dist/o.yaml", { worktree: UNTRACKED })]) });

    expect(branchSelect().disabled).toBe(false);
    expect(screen.queryByTestId("checkout-blocked")).toBeNull();
  });

  // A detached HEAD is not one of the options, so without an entry for it the
  // select would display the first branch in the list as if it were checked
  // out — which is a claim about the working tree that is simply false.
  it("shows a detached HEAD as itself rather than as the first branch", () => {
    renderBar({ status: statusOf({ detached: true, name: "", upstream: "" }) });

    expect(branchSelect().value).toBe("");
    expect(screen.getByRole("option", { name: "detached HEAD" })).toBeDefined();
  });

  it("is disabled while an operation is in flight", () => {
    renderBar({ busy: true });

    expect(branchSelect().disabled).toBe(true);
  });
});

describe("pull", () => {
  it("pulls on click", () => {
    const { onPull } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Pull" }));

    expect(onPull).toHaveBeenCalled();
  });

  it("is disabled with no upstream to pull from", () => {
    renderBar({ status: statusOf({ upstream: "" }) });

    expect((screen.getByRole("button", { name: "Pull" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("push", () => {
  it("pushes without naming a remote when the branch already tracks one", () => {
    const { onPush } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Push" }));

    expect(onPush).toHaveBeenCalledWith("", false);
    expect(screen.queryByRole("combobox", { name: "Remote" })).toBeNull();
  });

  // A branch created locally and never pushed: `git push` alone would fail, so
  // the remote picker appears and the push carries --set-upstream.
  it("prompts for a remote when the branch tracks nothing", () => {
    const { onPush } = renderBar({ status: statusOf({ name: "feature/x", upstream: "" }) });

    expect((screen.getByRole("combobox", { name: "Remote" }) as HTMLSelectElement).value).toBe(
      "origin",
    );

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(onPush).toHaveBeenCalledWith("origin", true);
  });

  it("publishes to the remote the user picks", () => {
    const { onPush } = renderBar({
      status: statusOf({ name: "feature/x", upstream: "" }),
      remotes: ["origin", "fork"],
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Remote" }), {
      target: { value: "fork" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(onPush).toHaveBeenCalledWith("fork", true);
  });

  // Nothing to publish to, and no name worth guessing: the picker says so
  // rather than offering a remote that would fail at the network.
  it("cannot publish with no remotes configured", () => {
    renderBar({ status: statusOf({ name: "feature/x", upstream: "" }), remotes: [] });

    expect(
      (screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("option", { name: "no remotes configured" })).toBeDefined();
  });

  // An unborn branch has no commit to publish, so there is no upstream to
  // prompt for either — the plain Push button is shown, disabled and saying
  // why.
  it("is disabled on a repository with no commits", () => {
    renderBar({ status: statusOf({ unborn: true, upstream: "" }) });

    const push = screen.getByRole("button", { name: "Push" }) as HTMLButtonElement;
    expect(push.disabled).toBe(true);
    expect(push.title).toBe("There are no commits to push yet.");
    expect(screen.queryByRole("combobox", { name: "Remote" })).toBeNull();
  });
});

describe("a failed operation", () => {
  // git's stderr reaches the user as git wrote it (DESIGN.md §7), which means
  // preserving its line breaks — a multi-line git error folded into one line
  // is harder to read than the original.
  it("shows git's own message and can be dismissed", () => {
    const { onDismissError } = renderBar({
      error: "error: failed to push some refs\nhint: Updates were rejected",
    });

    expect(screen.getByRole("alert").textContent).toContain("hint: Updates were rejected");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismissError).toHaveBeenCalled();
  });
});

// The changes panel already explains a project that is not a repository. A row
// of branch controls beside that message would be controls that cannot work.
it("renders nothing when git has no answer for the project", () => {
  renderBar({ status: { ...emptyStatus(), availability: NOT_A_REPOSITORY } });

  expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
});
