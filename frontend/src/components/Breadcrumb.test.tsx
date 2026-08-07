import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorTab } from "../lib/editorTabs";
import { newTab } from "../lib/editorTabs";
import { Breadcrumb } from "./Breadcrumb";

afterEach(cleanup);

/** A tab for one path, built the way the strip builds them so the title and
 * the path cannot disagree. */
function tabFor(path: string): EditorTab {
  return newTab("editor-1", "infra", "/w/infra", path, "yaml");
}

/** The breadcrumb's segments, in order, as they read on screen. */
function segments(): string[] {
  return [...screen.getByRole("navigation").querySelectorAll("button, .breadcrumb__leaf")].map(
    (el) => el.textContent ?? "",
  );
}

describe("the breadcrumb above the editor (#43)", () => {
  it("shows the active file's path from the project root", () => {
    render(<Breadcrumb tab={tabFor("manifests/prod/ingress.yaml")} onReveal={vi.fn()} />);

    expect(segments()).toEqual(["manifests", "prod", "ingress.yaml"]);
  });

  // The project root is what every path in the strip is relative to, so a
  // crumb for it would be the same word above every file in the project.
  it("does not name the project root", () => {
    render(<Breadcrumb tab={tabFor("README.md")} onReveal={vi.fn()} />);

    expect(segments()).toEqual(["README.md"]);
  });

  it("follows the tab that is showing", () => {
    const view = render(
      <Breadcrumb tab={tabFor("manifests/prod/ingress.yaml")} onReveal={vi.fn()} />,
    );

    view.rerender(<Breadcrumb tab={tabFor("charts/api/values.yaml")} onReveal={vi.fn()} />);

    expect(segments()).toEqual(["charts", "api", "values.yaml"]);
  });

  it("shows nothing at all when no file is open", () => {
    render(<Breadcrumb tab={null} onReveal={vi.fn()} />);

    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("reveals the directory a segment stands for, not the segment's own name", () => {
    const onReveal = vi.fn();
    render(<Breadcrumb tab={tabFor("manifests/prod/ingress.yaml")} onReveal={onReveal} />);

    fireEvent.click(screen.getByRole("button", { name: "prod" }));

    expect(onReveal).toHaveBeenCalledWith("manifests/prod");
  });

  it("reveals the outermost directory from the first segment", () => {
    const onReveal = vi.fn();
    render(<Breadcrumb tab={tabFor("manifests/prod/ingress.yaml")} onReveal={onReveal} />);

    fireEvent.click(screen.getByRole("button", { name: "manifests" }));

    expect(onReveal).toHaveBeenCalledWith("manifests");
  });

  // The file is the thing already on screen. A button there would be a
  // control that does nothing, and the ticket puts file navigation from the
  // breadcrumb out of scope.
  it("leaves the file itself unclickable", () => {
    const onReveal = vi.fn();
    render(<Breadcrumb tab={tabFor("manifests/prod/ingress.yaml")} onReveal={onReveal} />);

    expect(screen.queryByRole("button", { name: "ingress.yaml" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("leaves a root-level file with nothing to click", () => {
    render(<Breadcrumb tab={tabFor("README.md")} onReveal={vi.fn()} />);

    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
