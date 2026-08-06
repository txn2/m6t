import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorTab, EditorTabKind } from "../lib/editorTabs";
import { newTab, withEdit, withLoaded } from "../lib/editorTabs";
import type { FileContent } from "../lib/files";
import { EditorTabs } from "./EditorTabs";

afterEach(cleanup);

const file = (content: string, over: Partial<FileContent> = {}): FileContent =>
  ({ content, crlf: false, mixedEol: false, readOnly: false, size: content.length, ...over }) as FileContent;

const ready = (path = "deploy.yaml", kind: EditorTabKind = "yaml"): EditorTab =>
  withLoaded(newTab("k0", "infra", "/w/infra", path, kind), file("a: 1\n"));

function renderTabs(tabs: EditorTab[], over: Partial<Parameters<typeof EditorTabs>[0]> = {}) {
  const props = {
    tabs,
    activeKey: tabs[0]?.key ?? null,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(true),
    onPreview: vi.fn(),
    ...over,
  };
  const { rerender } = render(<EditorTabs {...props} />);
  return {
    props,
    rerender: (next: EditorTab[]) => {
      rerender(<EditorTabs {...props} tabs={next} />);
    },
  };
}

/** Opens the close-confirmation for the first tab. */
function requestClose(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `close ${name}` }));
}

describe("the tab's file icon (#38)", () => {
  /** The icon the first tab is showing, by the name FileIcon stamps on it. */
  function tabIcon(): string | null {
    return document.querySelector(".tab__icon [data-icon]")?.getAttribute("data-icon") ?? null;
  }

  it("shows plain YAML for a file whose content is not a manifest", () => {
    renderTabs([withLoaded(newTab("k0", "infra", "/w/infra", "deploy.yaml", "yaml"), file("a: 1\n"))]);
    expect(tabIcon()).toBe("yaml");
  });

  it("shows Kubernetes for a manifest, from the content the tab already holds", () => {
    // The tree reads a 2 KiB head to decide this; an open tab has the whole
    // file, so the same rule runs here without a round trip — and the two
    // surfaces cannot disagree about the same file.
    renderTabs([
      withLoaded(
        newTab("k0", "infra", "/w/infra", "deploy.yaml", "yaml"),
        file("apiVersion: apps/v1\nkind: Deployment\n"),
      ),
    ]);
    expect(tabIcon()).toBe("kubernetes");
  });

  it("keeps a name-derived icon whatever the content says", () => {
    renderTabs([
      withLoaded(
        newTab("k0", "infra", "/w/infra", "charts/api/values.yaml", "yaml"),
        file("apiVersion: apps/v1\nkind: Deployment\n"),
      ),
    ]);
    expect(tabIcon()).toBe("helm");
  });

  it("shows plain YAML while the file is still loading", () => {
    // newTab has no content yet: the icon must be the name's answer rather
    // than nothing at all.
    renderTabs([newTab("k0", "infra", "/w/infra", "deploy.yaml", "yaml")]);
    expect(tabIcon()).toBe("yaml");
  });
});

describe("the strip", () => {
  it("shows a tab per open file, named by its basename", () => {
    renderTabs([
      withLoaded(newTab("k0", "infra", "/w", "manifests/deploy.yaml", "yaml"), file("a\n")),
    ]);

    expect(screen.getByRole("tab", { name: /deploy\.yaml/ })).toBeDefined();
  });

  // Two files can share a basename; the full path is what tells them apart.
  it("carries the full path as the tab's tooltip", () => {
    renderTabs([
      withLoaded(newTab("k0", "infra", "/w", "base/deploy.yaml", "yaml"), file("a\n")),
    ]);

    expect(screen.getByRole("tab").getAttribute("title")).toBe("base/deploy.yaml");
  });

  it("selects a tab when it is clicked", () => {
    const { props } = renderTabs([ready()], { activeKey: null });

    fireEvent.click(screen.getByRole("tab"));

    expect(props.onSelect).toHaveBeenCalledWith("k0");
  });

  it("marks a dirty tab and leaves a clean one unmarked", () => {
    const { rerender } = renderTabs([ready()]);
    expect(screen.queryByLabelText("unsaved changes")).toBeNull();

    rerender([withEdit(ready(), "a: 2\n")]);

    expect(screen.getByLabelText("unsaved changes")).toBeDefined();
  });
});

describe("the preview toggle", () => {
  it("appears only for markdown", () => {
    renderTabs([ready("a.yaml", "yaml")]);

    expect(screen.queryByRole("button", { name: /preview|edit/ })).toBeNull();
  });

  it("switches a markdown tab into edit mode", () => {
    const { props } = renderTabs([ready("README.md", "markdown")]);

    fireEvent.click(screen.getByRole("button", { name: "edit README.md" }));

    expect(props.onPreview).toHaveBeenCalledWith("k0", false);
  });
});

describe("closing a tab", () => {
  it("closes a clean tab without asking", () => {
    const { props } = renderTabs([ready()]);

    requestClose("deploy.yaml");

    expect(props.onClose).toHaveBeenCalledWith("k0");
  });

  it("asks before discarding unsaved work", () => {
    const { props } = renderTabs([withEdit(ready(), "a: 2\n")]);

    requestClose("deploy.yaml");

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("cancelling keeps the tab and its edits", () => {
    const { props } = renderTabs([withEdit(ready(), "a: 2\n")]);
    requestClose("deploy.yaml");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("tab")).toBeDefined();
  });

  it("discarding closes the tab without writing", () => {
    const { props } = renderTabs([withEdit(ready(), "a: 2\n")]);
    requestClose("deploy.yaml");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(props.onClose).toHaveBeenCalledWith("k0");
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("saving closes the tab once the write has landed", async () => {
    const { props } = renderTabs([withEdit(ready(), "a: 2\n")]);
    requestClose("deploy.yaml");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(props.onClose).toHaveBeenCalledWith("k0");
    });
    expect(props.onSave).toHaveBeenCalledWith("k0");
  });

  // Closing on a failed write would take the only copy of the user's edits
  // with it.
  it("keeps the tab when the save fails", async () => {
    const { props } = renderTabs([withEdit(ready(), "a: 2\n")], {
      onSave: vi.fn().mockResolvedValue(false),
    });
    requestClose("deploy.yaml");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await vi.waitFor(() => {
      expect(props.onSave).toHaveBeenCalledWith("k0");
    });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  // A read-only tab cannot be written, so a Save button would do nothing.
  it("offers no save for a tab that cannot be saved", () => {
    const readOnly = {
      ...withLoaded(newTab("k0", "infra", "/w", "big.yaml", "yaml"), file("a\n", { readOnly: true })),
      content: "changed\n",
    };
    renderTabs([readOnly]);

    requestClose("big.yaml");

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDefined();
  });
});
