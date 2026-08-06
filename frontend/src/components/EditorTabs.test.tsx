import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorTab, EditorTabKind } from "../lib/editorTabs";
import { newTab, withEdit, withLoaded } from "../lib/editorTabs";
import type { FileContent } from "../lib/files";
import { EditorTabs } from "./EditorTabs";

afterEach(cleanup);

const file = (content: string, over: Partial<FileContent> = {}): FileContent =>
  ({ content, crlf: false, mixedEol: false, readOnly: false, size: content.length, ...over }) as FileContent;

const ready = (path = "deploy.yaml", kind: EditorTabKind = "yaml"): EditorTab =>
  withLoaded(newTab("k0", "infra", "/w/infra", path, kind), file("a: 1\n"));

/** A saved tab under /w/infra, with a key of its own. */
const saved = (key: string, path: string): EditorTab =>
  withLoaded(newTab(key, "infra", "/w/infra", path, "yaml"), file("a: 1\n"));

/** The same, with an unsaved edit in its buffer. */
const unsaved = (key: string, path: string): EditorTab =>
  withEdit(saved(key, path), "a: 2\n");

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

/** Right-clicks a tab and waits for its context menu. */
async function openMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole("tab", { name: new RegExp(name) }));
  return await screen.findByRole("menu", { name: `${name} actions` });
}

/** Picks an item from an open context menu. */
function choose(item: string) {
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** The tab the unsaved-changes prompt is currently asking about, or null. */
function prompted(): string | null {
  const dialog = screen.queryByRole("alertdialog");
  return dialog?.getAttribute("aria-label")?.replace(" has unsaved changes", "") ?? null;
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

describe("the tab context menu (#42)", () => {
  it("offers the four closes and the two copies", async () => {
    renderTabs([ready()]);

    const menu = await openMenu("deploy.yaml");

    expect(
      [...menu.querySelectorAll("[role='menuitem']")].map((item) => item.textContent),
    ).toEqual([
      "Close",
      "Close Others",
      "Close All",
      "Close Saved",
      "Copy Path",
      "Copy Relative Path",
    ]);
  });

  it("closes the right-clicked tab from the menu", async () => {
    const onClose = vi.fn();
    renderTabs([saved("k0", "deploy.yaml")], { onClose });

    await openMenu("deploy.yaml");
    choose("Close");

    expect(onClose.mock.calls).toEqual([["k0"]]);
  });

  // The issue's first acceptance criterion, and the reason bulk closes go
  // through the same path a single close does.
  it("closes the clean others and asks about the dirty one", async () => {
    const onClose = vi.fn();
    renderTabs(
      [saved("k0", "deploy.yaml"), saved("k1", "service.yaml"), unsaved("k2", "ingress.yaml")],
      { onClose },
    );

    await openMenu("deploy.yaml");
    choose("Close Others");

    // The right-clicked tab is not in the set, and the dirty one is waiting
    // on an answer rather than gone.
    expect(onClose.mock.calls).toEqual([["k1"]]);
    expect(prompted()).toBe("ingress.yaml");
  });

  it("asks about every dirty tab a Close All would take", async () => {
    const onClose = vi.fn();
    renderTabs(
      [unsaved("k0", "deploy.yaml"), saved("k1", "service.yaml"), unsaved("k2", "ingress.yaml")],
      { onClose },
    );

    await openMenu("service.yaml");
    choose("Close All");

    expect(onClose.mock.calls).toEqual([["k1"]]);
    expect(prompted()).toBe("deploy.yaml");

    // Answering the first moves the prompt to the second rather than ending
    // the operation on it.
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(onClose.mock.calls).toEqual([["k1"], ["k0"]]);
    expect(prompted()).toBe("ingress.yaml");
  });

  // Having declined once, the user should not have to decline again per file.
  it("cancelling a bulk close keeps that tab and drops the rest of the queue", async () => {
    const onClose = vi.fn();
    renderTabs([unsaved("k0", "deploy.yaml"), unsaved("k1", "ingress.yaml")], { onClose });

    await openMenu("deploy.yaml");
    choose("Close All");
    expect(prompted()).toBe("deploy.yaml");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(prompted()).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  // The strip is handed one project's tabs at a time, and a project switch
  // replaces them wholesale. A queued key with no tab left to render it would
  // otherwise sit at the head of the queue holding up every close behind it.
  it("drops queued tabs the strip no longer shows", async () => {
    const { rerender } = renderTabs([unsaved("k0", "deploy.yaml")]);
    await openMenu("deploy.yaml");
    choose("Close All");
    expect(prompted()).toBe("deploy.yaml");

    rerender([saved("k9", "other.yaml")]);

    expect(prompted()).toBeNull();
    expect(screen.getByRole("tab", { name: /other\.yaml/ })).toBeDefined();
  });

  it("closes only what is saved, and asks nothing", async () => {
    const onClose = vi.fn();
    renderTabs(
      [saved("k0", "deploy.yaml"), unsaved("k1", "ingress.yaml"), saved("k2", "service.yaml")],
      { onClose },
    );

    await openMenu("ingress.yaml");
    choose("Close Saved");

    expect(onClose.mock.calls).toEqual([["k0"], ["k2"]]);
    expect(prompted()).toBeNull();
  });

  describe("the copies", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();

    beforeEach(() => {
      writeText.mockReset();
      writeText.mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });
    });

    it("copies the absolute path", async () => {
      renderTabs([withLoaded(newTab("k0", "infra", "/w/infra", "base/deploy.yaml", "yaml"), file("a\n"))]);

      await openMenu("deploy.yaml");
      choose("Copy Path");

      expect(writeText).toHaveBeenCalledWith("/w/infra/base/deploy.yaml");
    });

    it("copies the project-root-relative path", async () => {
      renderTabs([withLoaded(newTab("k0", "infra", "/w/infra", "base/deploy.yaml", "yaml"), file("a\n"))]);

      await openMenu("deploy.yaml");
      choose("Copy Relative Path");

      expect(writeText).toHaveBeenCalledWith("base/deploy.yaml");
    });

    // A clipboard the webview refuses is not something the strip can report
    // and not something the user can act on; what it must not do is leave the
    // rejection unhandled.
    it("survives a refused clipboard", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      renderTabs([ready()]);

      await openMenu("deploy.yaml");
      choose("Copy Path");

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalled();
      });
      expect(screen.getByRole("tab", { name: /deploy\.yaml/ })).toBeDefined();
    });
  });
});
