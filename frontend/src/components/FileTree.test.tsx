import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeController } from "../lib/useFileTree";
import type { TreeState } from "../lib/tree";
import { ROOT, expand, initialTree, withListing } from "../lib/tree";
import type { Badges } from "../lib/gitStatus";
import { FileTree } from "./FileTree";

afterEach(cleanup);

function loadedRoot(): TreeState {
  return withListing(initialTree(), ROOT, [
    { name: "manifests", isDir: true },
    { name: "deploy.yaml", isDir: false },
  ]);
}

function loadedManifests(state: TreeState): TreeState {
  return withListing(expand(state, "manifests"), "manifests", [
    { name: "prod.yaml", isDir: false },
  ]);
}

/** No git markers — the default for the tests that predate #8 and care only
 * about tree structure. The badge-specific tests build their own. */
function noBadges(): Badges {
  return { files: new Map(), dirs: new Map() };
}

/** The icon a rendered row is showing, by the name `FileIcon` stamps on it. */
function iconOf(row: HTMLElement): string | null {
  return row.querySelector(".tree__icon [data-icon]")?.getAttribute("data-icon") ?? null;
}

function fakeController(
  state: TreeState,
  overrides: Partial<FileTreeController> = {},
): FileTreeController {
  return {
    state,
    expand: vi.fn(),
    collapse: vi.fn(),
    select: vi.fn(),
    toggleHidden: vi.fn(),
    createEntry: vi.fn().mockResolvedValue(null),
    renameEntry: vi.fn().mockResolvedValue(null),
    deleteEntry: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("rendering the tree", () => {
  it("shows root's entries, directories first", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    const items = screen.getAllByRole("treeitem");
    expect(items.map((el) => el.textContent)).toEqual(["manifests", "deploy.yaml"]);
    // With the text glyphs gone (#38) the icon is the row's only type
    // signal, so asserting the names alone would pass over a tree that
    // rendered no icons at all.
    expect(items.map(iconOf)).toEqual(["dir", "yaml"]);
  });

  it("gives a directory the open folder once it is expanded", () => {
    render(
      <FileTree badges={noBadges()} tree={fakeController(loadedManifests(loadedRoot()))} onOpenFile={vi.fn()} />,
    );

    expect(iconOf(screen.getByRole("treeitem", { name: /manifests/ }))).toBe("dir-open");
  });

  it("shows a manifest below the root as Kubernetes, and root YAML as plain", () => {
    // The rule `iconKind` implements: YAML at the repository root is
    // repository configuration, YAML under a directory is a manifest.
    render(
      <FileTree badges={noBadges()} tree={fakeController(loadedManifests(loadedRoot()))} onOpenFile={vi.fn()} />,
    );

    expect(iconOf(screen.getByRole("treeitem", { name: /prod\.yaml/ }))).toBe("kubernetes");
    expect(iconOf(screen.getByRole("treeitem", { name: /deploy\.yaml/ }))).toBe("yaml");
  });

  it("shows an expanded directory's children beneath it", () => {
    const state = loadedManifests(loadedRoot());
    render(<FileTree badges={noBadges()} tree={fakeController(state)} onOpenFile={vi.fn()} />);

    expect(screen.getByRole("treeitem", { name: /prod\.yaml/ })).toBeDefined();
  });

  it("says there is nothing to show for an empty, loaded root", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(withListing(initialTree(), ROOT, []))} onOpenFile={vi.fn()} />);

    expect(screen.getByText("No files in this project.")).toBeDefined();
  });
});

describe("selecting entries", () => {
  it("expands a collapsed directory on click rather than opening it", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("treeitem", { name: /manifests/ }));

    expect(tree.expand).toHaveBeenCalledWith("manifests");
  });

  it("selects a file and emits the open-file intent on click", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(tree.select).toHaveBeenCalledWith("deploy.yaml");
    expect(onOpenFile).toHaveBeenCalledWith("deploy.yaml");
  });
});

describe("keyboard navigation", () => {
  it("moves focus down and up between rows", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);
    const treeEl = screen.getByRole("tree");
    // Arrow-key navigation only moves DOM focus once the tree already has it
    // (so a background refresh never steals focus elsewhere) — a real user
    // reaches this by tabbing in or clicking a row first.
    screen.getByRole("treeitem", { name: /manifests/ }).focus();

    fireEvent.keyDown(treeEl, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    fireEvent.keyDown(treeEl, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /manifests/ }));
  });

  it("expands a collapsed directory with ArrowRight", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });

    expect(tree.expand).toHaveBeenCalledWith("manifests");
  });

  it("collapses an expanded directory with ArrowLeft", () => {
    const tree = fakeController(loadedManifests(loadedRoot()));
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);
    // Focus is on manifests (row 0) by default; expand it via ArrowRight
    // first is not needed — moving onto its own row and pressing left when
    // already expanded collapses it directly.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });

    expect(tree.collapse).toHaveBeenCalledWith("manifests");
  });

  it("moves left from a child row to its parent directory's row", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedManifests(loadedRoot()))} onOpenFile={vi.fn()} />);
    const treeEl = screen.getByRole("tree");
    screen.getByRole("treeitem", { name: /manifests/ }).focus();

    fireEvent.keyDown(treeEl, { key: "ArrowDown" }); // manifests -> prod.yaml
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /prod\.yaml/ }));

    fireEvent.keyDown(treeEl, { key: "ArrowLeft" }); // prod.yaml -> manifests
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: /manifests/ }));
  });

  it("activates the focused row on Enter", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={onOpenFile} />);
    const treeEl = screen.getByRole("tree");
    screen.getByRole("treeitem", { name: /manifests/ }).focus();

    fireEvent.keyDown(treeEl, { key: "ArrowDown" }); // -> deploy.yaml
    fireEvent.keyDown(treeEl, { key: "Enter" });

    expect(onOpenFile).toHaveBeenCalledWith("deploy.yaml");
  });
});

describe("the hidden-files toggle", () => {
  it("calls toggleHidden and reflects the current state", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    const toggle = screen.getByRole("button", { name: "show dotfiles" });
    fireEvent.click(toggle);

    expect(tree.toggleHidden).toHaveBeenCalled();
  });

  it("labels the button by whether hidden files are already shown", () => {
    const shown = { ...loadedRoot(), showHidden: true };
    render(<FileTree badges={noBadges()} tree={fakeController(shown)} onOpenFile={vi.fn()} />);

    expect(screen.getByRole("button", { name: "hide dotfiles" })).toBeDefined();
  });
});

describe("creating an entry", () => {
  it("creates a file at root from the header action", async () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []));
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "new file" }));
    const field = screen.getByRole("textbox", { name: "new file name" });
    fireEvent.change(field, { target: { value: "values.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(tree.createEntry).toHaveBeenCalledWith(ROOT, "values.yaml", false);
  });

  it("shows the backend's error and keeps the field open on failure", async () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []), {
      createEntry: vi.fn().mockResolvedValue("path already exists"),
    });
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "new file" }));
    const field = screen.getByRole("textbox", { name: "new file name" });
    fireEvent.change(field, { target: { value: "deploy.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(await screen.findByText("path already exists")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "new file name" })).toBeDefined();
  });

  it("cancels on Escape without creating anything", () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []));
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "new folder" }));
    const field = screen.getByRole("textbox", { name: "new folder name" });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "new folder name" })).toBeNull();
    expect(tree.createEntry).not.toHaveBeenCalled();
  });
});

describe("the row context menu", () => {
  it("opens on right-click and offers the real actions plus the deferred-scope note", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDefined();
    expect(screen.getByText(/Git and Kubernetes actions arrive in later tickets/)).toBeDefined();
  });

  it("only offers New File/New Folder for a directory", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    expect(screen.queryByRole("menuitem", { name: "New File" })).toBeNull();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /manifests/ }));
    expect(screen.getByRole("menuitem", { name: "New File" })).toBeDefined();
  });
});

describe("renaming from the menu", () => {
  it("commits a rename on Enter", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    const field = screen.getByRole("textbox", { name: "rename deploy.yaml" });
    fireEvent.change(field, { target: { value: "service.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(tree.renameEntry).toHaveBeenCalledWith("deploy.yaml", "service.yaml");
  });

  // A keystroke in the rename field must not also reach the tree's own
  // keyboard handler — otherwise Enter both commits the rename AND
  // activates whatever row the keyboard cursor happens to be on.
  it("does not also activate a row when Enter commits a rename", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={onOpenFile} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "rename deploy.yaml" });
    fireEvent.change(field, { target: { value: "service.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(tree.select).not.toHaveBeenCalled();
    expect(tree.expand).not.toHaveBeenCalled();
  });

  it("does not navigate the tree while arrow keys are used to edit the name", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "rename deploy.yaml" });

    fireEvent.keyDown(field, { key: "ArrowLeft" });
    fireEvent.keyDown(field, { key: "ArrowRight" });

    expect(tree.expand).not.toHaveBeenCalled();
    expect(tree.collapse).not.toHaveBeenCalled();
  });
});

describe("deleting with confirmation", () => {
  it("does not delete until the confirmation is accepted", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(screen.getByText("Delete deploy.yaml?")).toBeDefined();
    expect(tree.deleteEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(tree.deleteEntry).toHaveBeenCalledWith("deploy.yaml");
  });

  it("cancels the confirmation without deleting", () => {
    const tree = fakeController(loadedRoot());
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete deploy.yaml?")).toBeNull();
    expect(tree.deleteEntry).not.toHaveBeenCalled();
  });

  // A native <button> activates on Enter; that keydown must not also reach
  // the tree's own handler and activate the row underneath the confirm UI.
  it("does not also activate a row when a key is pressed inside the confirmation", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    render(<FileTree badges={noBadges()} tree={tree} onOpenFile={onOpenFile} />);

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Enter" });

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(tree.select).not.toHaveBeenCalled();
    // The keyboard cursor defaults to row 0 (manifests, a directory) — the
    // bug this guards against activates whichever row the cursor is on, not
    // necessarily the one being deleted, so a directory's expand is the call
    // that actually catches a regression here.
    expect(tree.expand).not.toHaveBeenCalled();
  });
});

describe("git badges (#8)", () => {
  it("marks a changed file with its own badge", () => {
    const badges: Badges = { files: new Map([["deploy.yaml", "M"]]), dirs: new Map() };
    render(<FileTree badges={badges} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    const row = screen.getByRole("treeitem", { name: /deploy\.yaml/ });
    expect(row.textContent).toContain("M");
  });

  it("says in words what a badge means", () => {
    const badges: Badges = { files: new Map([["deploy.yaml", "?"]]), dirs: new Map() };
    render(<FileTree badges={badges} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    expect(screen.getByTitle("untracked").textContent).toBe("?");
  });

  it("rolls a change up to the directory that holds it", () => {
    const badges: Badges = { files: new Map(), dirs: new Map([["manifests", "•"]]) };
    render(<FileTree badges={badges} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    expect(screen.getByRole("treeitem", { name: /manifests/ }).textContent).toContain("•");
  });

  it("leaves a row with no git state unmarked", () => {
    render(<FileTree badges={noBadges()} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    expect(screen.getByRole("treeitem", { name: /deploy\.yaml/ }).textContent).toBe("deploy.yaml");
  });

  // A submodule is a directory on disk and one entry to git, so git's own
  // badge for the path has to win over the rollup marker.
  it("prefers git's own badge over the rollup on a directory row", () => {
    const badges: Badges = {
      files: new Map([["manifests", "A"]]),
      dirs: new Map([["manifests", "•"]]),
    };
    render(<FileTree badges={badges} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    const row = screen.getByRole("treeitem", { name: /manifests/ });
    expect(row.textContent).toContain("A");
    expect(row.textContent).not.toContain("•");
  });

  // The badge sits beside the name; neither may displace the other.
  it("keeps the name and the action button alongside the badge", () => {
    const badges: Badges = { files: new Map([["deploy.yaml", "M"]]), dirs: new Map() };
    render(<FileTree badges={badges} tree={fakeController(loadedRoot())} onOpenFile={vi.fn()} />);

    expect(screen.getByText("deploy.yaml")).toBeDefined();
    expect(screen.getByRole("button", { name: "actions for deploy.yaml" })).toBeDefined();
  });
});
