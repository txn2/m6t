import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorTab, EditorTabKind } from "../lib/editorTabs";
import { newTab, withBlame, withLoaded, withMode } from "../lib/editorTabs";
import type { FileStatus, Status } from "../lib/git";
import { NOT_A_REPOSITORY, NO_GIT, UNTRACKED, emptyStatus } from "../lib/git";
import { ViewToolbar } from "./ViewToolbar";

afterEach(cleanup);

function tab(path = "deploy.yaml", kind: EditorTabKind = "yaml"): EditorTab {
  return withLoaded(newTab("k0", "infra", "/w/infra", path, kind), {
    content: "a: 1\n",
    crlf: false,
    mixedEol: false,
    readOnly: false,
    size: 5,
  });
}

function statusOf(files: FileStatus[] = []): Status {
  return { ...emptyStatus(), files };
}

function untracked(path: string): FileStatus {
  return { path, staged: "", worktree: UNTRACKED, conflicted: false, origPath: "" };
}

function renderBar(open: EditorTab | null, status: Status = statusOf()) {
  const onToggleBlame = vi.fn();
  const onLocate = vi.fn();
  render(
    <ViewToolbar
      tab={open}
      status={status}
      onLocate={onLocate}
      onToggleBlame={onToggleBlame}
    />,
  );
  return { onToggleBlame, onLocate };
}

const blameButton = () => screen.queryByRole("button", { name: "Blame" });
const locateButton = () => screen.queryByRole("button", { name: "Locate" });

describe("the locate control (#56)", () => {
  it("is offered for any open file", () => {
    renderBar(tab());

    expect(locateButton()).not.toBeNull();
  });

  // It is not a git control, so nothing about the repository takes it away.
  it("is offered for a file git is not tracking", () => {
    renderBar(tab(), statusOf([untracked("deploy.yaml")]));

    expect(locateButton()).not.toBeNull();
    expect(blameButton()).toBeNull();
  });

  it("is offered when there is no git at all", () => {
    renderBar(tab(), { ...emptyStatus(), availability: NO_GIT });

    expect(locateButton()).not.toBeNull();
  });

  it("is offered for a markdown file in preview, which has no gutter", () => {
    renderBar(tab("README.md", "markdown"));

    expect(locateButton()).not.toBeNull();
    expect(blameButton()).toBeNull();
  });

  it("asks for the open file by its own path", () => {
    const { onLocate } = renderBar(tab("deploy/base/svc.yaml"));

    fireEvent.click(locateButton() as HTMLElement);

    expect(onLocate).toHaveBeenCalledWith("deploy/base/svc.yaml");
  });

  it("acts rather than toggles, so it reports no pressed state", () => {
    renderBar(tab());

    expect(locateButton()?.hasAttribute("aria-pressed")).toBe(false);
  });
});

describe("when the toolbar appears", () => {
  it("offers blame for a file git is tracking", () => {
    renderBar(tab());

    expect(blameButton()).not.toBeNull();
  });

  // A tracked file with no local changes is absent from the status entirely —
  // git emits a record only for a path that differs — so "not mentioned" has
  // to mean tracked.
  it("offers blame for a tracked file that has not been touched", () => {
    renderBar(tab(), statusOf([untracked("other.yaml")]));

    expect(blameButton()).not.toBeNull();
  });

  it("drops blame for an untracked file, keeping the row", () => {
    renderBar(tab(), statusOf([untracked("deploy.yaml")]));

    expect(blameButton()).toBeNull();
    expect(screen.getByRole("toolbar")).toBeDefined();
  });

  it("drops blame when git is not installed", () => {
    renderBar(tab(), { ...emptyStatus(), availability: NO_GIT });

    expect(blameButton()).toBeNull();
  });

  it("drops blame when the project is not a repository", () => {
    renderBar(tab(), { ...emptyStatus(), availability: NOT_A_REPOSITORY });

    expect(blameButton()).toBeNull();
  });

  // The row goes when it would hold nothing, which is when no file is open —
  // not when one particular control does not apply.
  it("is absent when no file is open", () => {
    renderBar(null);

    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  // The column is a CodeMirror gutter, and a rendered markdown preview has no
  // gutter to put it in. A toggle there would visibly do nothing.
  it("drops blame for a markdown file showing its preview", () => {
    renderBar(tab("README.md", "markdown"));

    expect(blameButton()).toBeNull();
  });

  it("offers blame for a markdown file being edited", () => {
    renderBar(withMode(tab("README.md", "markdown"), "edit"));

    expect(blameButton()).not.toBeNull();
  });
});

describe("the blame toggle", () => {
  it("reports whether the column is on", () => {
    renderBar(tab());

    expect(blameButton()?.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports a column that is on", () => {
    renderBar(withBlame(tab(), true));

    expect(blameButton()?.getAttribute("aria-pressed")).toBe("true");
  });

  it("asks for the column when it is off", () => {
    const { onToggleBlame } = renderBar(tab());

    fireEvent.click(blameButton() as HTMLElement);

    expect(onToggleBlame).toHaveBeenCalledWith("k0", true);
  });

  it("asks to take the column away when it is on", () => {
    const { onToggleBlame } = renderBar(withBlame(tab(), true));

    fireEvent.click(blameButton() as HTMLElement);

    expect(onToggleBlame).toHaveBeenCalledWith("k0", false);
  });
});
