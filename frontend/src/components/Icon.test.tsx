import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { IconKind } from "../lib/tree";
import { FileIcon, UiIcon } from "./Icon";

afterEach(cleanup);

/** Every bucket `iconKind` can return, so a new one added to the union
 * without artwork behind it fails here rather than rendering nothing. */
const ALL_KINDS: readonly IconKind[] = [
  "dir",
  "kubernetes",
  "helm",
  "kustomize",
  "actions",
  "yaml",
  "md",
  "go",
  "ts",
  "tsx",
  "js",
  "json",
  "shell",
  "toml",
  "docker",
  "make",
  "file",
];

function iconElement(): HTMLElement {
  const icon = document.querySelector("[data-icon]");
  if (icon === null) {
    throw new Error("nothing rendered a [data-icon] element");
  }
  return icon as HTMLElement;
}

describe("FileIcon", () => {
  it.each(ALL_KINDS)("renders artwork for %s", (kind) => {
    render(<FileIcon kind={kind} />);
    const icon = iconElement();
    expect(icon.getAttribute("data-icon")).toBe(kind);
    expect(icon.classList.contains("icon")).toBe(true);
  });

  it("draws a vendored SVG for every kind but kustomize", () => {
    for (const kind of ALL_KINDS.filter((k) => k !== "kustomize")) {
      const { unmount } = render(<FileIcon kind={kind} />);
      const icon = iconElement();
      expect(icon.tagName).toBe("IMG");
      expect(icon.getAttribute("src")).toMatch(/\.svg$|^data:image\/svg\+xml/);
      unmount();
    }
  });

  it("gives each kind its own artwork", () => {
    const sources = new Set<string>();
    for (const kind of ALL_KINDS.filter((k) => k !== "kustomize" && k !== "dir")) {
      const { unmount } = render(<FileIcon kind={kind} />);
      sources.add(iconElement().getAttribute("src") ?? "");
      unmount();
    }
    // Without this, mapping two buckets to the same file would look correct
    // in every other test here: a Go file and a shell script would both
    // render, just identically.
    expect(sources.size).toBe(ALL_KINDS.length - 2);
  });

  it("shows the open folder only for an expanded directory", () => {
    const { unmount } = render(<FileIcon kind="dir" expanded />);
    const open = iconElement();
    expect(open.getAttribute("data-icon")).toBe("dir-open");
    const openSrc = open.getAttribute("src");
    unmount();

    render(<FileIcon kind="dir" />);
    const shut = iconElement();
    expect(shut.getAttribute("data-icon")).toBe("dir");
    expect(shut.getAttribute("src")).not.toBe(openSrc);
  });

  it("ignores expanded for a file, which has no open state", () => {
    render(<FileIcon kind="yaml" expanded />);
    expect(iconElement().getAttribute("data-icon")).toBe("yaml");
  });

  it("is decorative — the row's own text names the file", () => {
    render(<FileIcon kind="go" />);
    expect(iconElement().getAttribute("alt")).toBe("");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("UiIcon", () => {
  it.each(["chevron-right", "chevron-down", "close", "plus", "menu", "dirty", "edit", "preview", "up", "down"] as const)(
    "renders %s in currentColor so its button can colour it",
    (name) => {
      render(<UiIcon name={name} />);
      const icon = iconElement();
      expect(icon.tagName).toBe("svg");
      expect(icon.getAttribute("data-icon")).toBe(name);
      expect(icon.getAttribute("stroke")).toBe("currentColor");
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    },
  );

  it("gives each name its own artwork", () => {
    const paths = new Set<string>();
    for (const name of ["chevron-right", "chevron-down", "close", "plus", "menu", "dirty", "edit", "preview", "up", "down"] as const) {
      const { unmount } = render(<UiIcon name={name} />);
      paths.add(iconElement().innerHTML);
      unmount();
    }
    expect(paths.size).toBe(10);
  });

  it("keeps the shared class when a call site adds its own", () => {
    render(<UiIcon name="close" className="tab__close-icon" />);
    const icon = iconElement();
    expect(icon.classList.contains("icon")).toBe(true);
    expect(icon.classList.contains("tab__close-icon")).toBe(true);
  });
});
