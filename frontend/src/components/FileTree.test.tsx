import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTreeController } from "../lib/useFileTree";
import type { TreeState } from "../lib/tree";
import {
  ROOT,
  expand,
  initialTree,
  select,
  toggleChangedOnly,
  withListing,
  withManifests,
} from "../lib/tree";
import type { FileStatus, Status } from "../lib/git";
import { ADDED, DELETED, MODIFIED, UNTRACKED, emptyStatus } from "../lib/git";
import { FileTree } from "./FileTree";

afterEach(cleanup);

/** One changed path, as git reports it. */
function file(path: string, over: Partial<FileStatus> = {}): FileStatus {
  return { path, staged: "", worktree: "", conflicted: false, origPath: "", ...over };
}

function statusOf(files: readonly FileStatus[]): Status {
  return { ...emptyStatus(), files };
}

/**
 * The tree under test.
 *
 * The default status is the clean one every test that predates #8 wants, so
 * the git tests are the only ones that have to say anything about git — and
 * they say it as a status, which is what the component is actually given, so
 * the badge rollup is exercised rather than hand-written past.
 */
function renderTree(props: {
  readonly tree: FileTreeController;
  readonly status?: Status;
  readonly onOpenFile?: (path: string) => void;
}) {
  return render(
    <Harness
      tree={props.tree}
      status={props.status ?? emptyStatus()}
      onOpenFile={props.onOpenFile ?? vi.fn()}
    />,
  );
}

/**
 * The tree, with changed-only mode wired to the real reducer.
 *
 * That mode moved out of the component and into `TreeState` (#43) so a reveal
 * can clear it, which means the toggle now asks the controller to change
 * state rather than flipping a local flag. A spy would swallow the request and
 * leave every test below asserting against a tree still in the mode it
 * started in — so this holds the state the hook would hold, and applies the
 * same pure transition the hook applies. Everything else stays the spy the
 * test passed in.
 */
function Harness({
  tree,
  status,
  onOpenFile,
}: {
  readonly tree: FileTreeController;
  readonly status: Status;
  readonly onOpenFile: (path: string) => void;
}) {
  const [state, setState] = useState(tree.state);

  return (
    <FileTree
      tree={{
        ...tree,
        state,
        toggleChangedOnly: () => {
          setState(toggleChangedOnly);
        },
      }}
      status={status}
      onOpenFile={onOpenFile}
      overridden={NO_OVERRIDES}
      onBind={vi.fn()}
    />
  );
}

/** No folder carries a kube override, which is what every test here is about
 * except the two that say otherwise (#10). */
const NO_OVERRIDES: ReadonlySet<string> = new Set();

/** The tint the tree drew on a row's name, or null when it drew none. */
function toneOf(row: HTMLElement): string | null {
  return row.querySelector(".tree__name")?.getAttribute("data-tone") ?? null;
}

function showChangedOnly(): void {
  fireEvent.click(screen.getByRole("button", { name: "Changed only" }));
}

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
    reveal: vi.fn(),
    locate: vi.fn(),
    restore: vi.fn(),
    closeProject: vi.fn(),
    toggleHidden: vi.fn(),
    toggleChangedOnly: vi.fn(),
    createEntry: vi.fn().mockResolvedValue(null),
    renameEntry: vi.fn().mockResolvedValue(null),
    deleteEntry: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe("rendering the tree", () => {
  it("shows root's entries, directories first", () => {
    renderTree({ tree: fakeController(loadedRoot()) });

    const items = screen.getAllByRole("treeitem");
    expect(items.map((el) => el.textContent)).toEqual(["manifests", "deploy.yaml"]);
    // With the text glyphs gone (#38) the icon is the row's only type
    // signal, so asserting the names alone would pass over a tree that
    // rendered no icons at all.
    expect(items.map(iconOf)).toEqual(["dir", "yaml"]);
  });

  it("gives a directory the open folder once it is expanded", () => {
    renderTree({ tree: fakeController(loadedManifests(loadedRoot())) });

    expect(iconOf(screen.getByRole("treeitem", { name: /manifests/ }))).toBe("dir-open");
  });

  it("shows YAML as plain until its content has been classified", () => {
    // Nothing in a name says "manifest" (#38), so both rows start here and
    // only the one whose head said apiVersion+kind moves.
    renderTree({ tree: fakeController(loadedManifests(loadedRoot())) });

    expect(iconOf(screen.getByRole("treeitem", { name: /prod\.yaml/ }))).toBe("yaml");
    expect(iconOf(screen.getByRole("treeitem", { name: /deploy\.yaml/ }))).toBe("yaml");
  });

  it("upgrades a row to Kubernetes once its content says so", () => {
    const listed = loadedManifests(loadedRoot());
    const classified = withManifests(
      listed,
      { "manifests/prod.yaml": "apiVersion: v1\nkind: Service\n", "deploy.yaml": "x: 1\n" },
      ["manifests/prod.yaml", "deploy.yaml"],
    );
    renderTree({ tree: fakeController(classified) });

    expect(iconOf(screen.getByRole("treeitem", { name: /prod\.yaml/ }))).toBe("kubernetes");
    // Read, and it is not one — which must look the same as never read.
    expect(iconOf(screen.getByRole("treeitem", { name: /deploy\.yaml/ }))).toBe("yaml");
  });

  it("shows an expanded directory's children beneath it", () => {
    const state = loadedManifests(loadedRoot());
    renderTree({ tree: fakeController(state) });

    expect(screen.getByRole("treeitem", { name: /prod\.yaml/ })).toBeDefined();
  });

  it("says there is nothing to show for an empty, loaded root", () => {
    renderTree({ tree: fakeController(withListing(initialTree(), ROOT, [])) });

    expect(screen.getByText("No files in this project.")).toBeDefined();
  });
});

describe("selecting entries", () => {
  it("expands a collapsed directory on click rather than opening it", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.click(screen.getByRole("treeitem", { name: /manifests/ }));

    expect(tree.expand).toHaveBeenCalledWith("manifests");
  });

  it("selects a file and emits the open-file intent on click", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    renderTree({ tree, onOpenFile });

    fireEvent.click(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(tree.select).toHaveBeenCalledWith("deploy.yaml");
    expect(onOpenFile).toHaveBeenCalledWith("deploy.yaml");
  });
});

describe("keyboard navigation", () => {
  it("moves focus down and up between rows", () => {
    renderTree({ tree: fakeController(loadedRoot()) });
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
    renderTree({ tree });

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowRight" });

    expect(tree.expand).toHaveBeenCalledWith("manifests");
  });

  it("collapses an expanded directory with ArrowLeft", () => {
    const tree = fakeController(loadedManifests(loadedRoot()));
    renderTree({ tree });
    // Focus is on manifests (row 0) by default; expand it via ArrowRight
    // first is not needed — moving onto its own row and pressing left when
    // already expanded collapses it directly.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });

    expect(tree.collapse).toHaveBeenCalledWith("manifests");
  });

  it("moves left from a child row to its parent directory's row", () => {
    renderTree({ tree: fakeController(loadedManifests(loadedRoot())) });
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
    renderTree({ tree, onOpenFile });
    const treeEl = screen.getByRole("tree");
    screen.getByRole("treeitem", { name: /manifests/ }).focus();

    fireEvent.keyDown(treeEl, { key: "ArrowDown" }); // -> deploy.yaml
    fireEvent.keyDown(treeEl, { key: "Enter" });

    expect(onOpenFile).toHaveBeenCalledWith("deploy.yaml");
  });
});

describe("scrolling the selected row (#56)", () => {
  /**
   * The tree without the changed-only Harness above.
   *
   * These re-render with a new state, and the Harness pins its own copy at
   * mount — so through it the component would never see the second state and
   * every assertion here would pass over a tree that had not moved.
   */
  function renderPlain(state: TreeState) {
    const { rerender } = render(
      <FileTree
        tree={fakeController(state)}
        status={emptyStatus()}
        onOpenFile={vi.fn()}
        overridden={NO_OVERRIDES}
        onBind={vi.fn()}
      />,
    );
    return (next: TreeState) => {
      rerender(
        <FileTree
          tree={fakeController(next)}
          status={emptyStatus()}
          onOpenFile={vi.fn()}
          overridden={NO_OVERRIDES}
          onBind={vi.fn()}
        />,
      );
    };
  }

  const at = (path: string | null, locateRequest: number): TreeState => ({
    ...loadedManifests(loadedRoot()),
    selected: path,
    locateRequest,
  });

  /** The alignment each scrollIntoView call asked for, in order. */
  const blocks = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map(([options]) => (options as ScrollIntoViewOptions).block);

  it("puts a located row in the middle of the pane", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const rerender = renderPlain(at(null, 0));
    spy.mockClear();

    rerender(at("manifests/prod.yaml", 1));

    expect(blocks(spy)).toContain("center");
  });

  // Centring every selection would drag the tree out from under someone
  // arrowing through it.
  it("moves an ordinarily selected row only as far as it must", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const rerender = renderPlain(at("manifests", 0));
    spy.mockClear();

    rerender(at("manifests/prod.yaml", 0));

    expect(blocks(spy)).toContain("nearest");
    expect(blocks(spy)).not.toContain("center");
  });

  // Pressing Locate on the file already selected must still centre it: the
  // selection does not change, so only the request tells the two apart.
  it("centres again when the same file is located twice", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const rerender = renderPlain(at("manifests/prod.yaml", 1));
    spy.mockClear();

    rerender(at("manifests/prod.yaml", 2));

    expect(blocks(spy)).toContain("center");
  });

  // The row a locate asks for often does not exist yet: its directory is
  // still being listed. The centring has to survive until it does, or the
  // file arrives on screen pinned to whichever edge it came in on.
  it("centres the row when it arrives after the locate", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const rerender = renderPlain(at(null, 0));
    spy.mockClear();

    // The locate lands first: the file is selected, but the directory holding
    // it has not been listed, so it has no row to scroll to.
    rerender({ ...loadedRoot(), selected: "manifests/prod.yaml", locateRequest: 1 });
    expect(blocks(spy)).toEqual([]);

    // The listing arrives.
    rerender(at("manifests/prod.yaml", 1));

    expect(blocks(spy)).toContain("center");
  });
});

describe("the hidden-files toggle", () => {
  const toggle = () => screen.getByRole("button", { name: "Show hidden" });

  it("calls toggleHidden", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.click(toggle());

    expect(tree.toggleHidden).toHaveBeenCalled();
  });

  // It used to rename itself — `show dotfiles`, then `hide dotfiles` — which
  // leaves a user unable to tell whether the words describe the state they are
  // in or the one the click leads to, and a screen reader announcing a
  // different control each time it is pressed (#54).
  it("keeps its name in both states and reports the state as pressed", () => {
    renderTree({ tree: fakeController(loadedRoot()) });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");

    cleanup();
    renderTree({ tree: fakeController({ ...loadedRoot(), showHidden: true }) });

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("creating an entry", () => {
  it("creates a file at root from the header action", async () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []));
    renderTree({ tree });

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const field = screen.getByRole("textbox", { name: "new file name" });
    fireEvent.change(field, { target: { value: "values.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(tree.createEntry).toHaveBeenCalledWith(ROOT, "values.yaml", false);
  });

  it("shows the backend's error and keeps the field open on failure", async () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []), {
      createEntry: vi.fn().mockResolvedValue("path already exists"),
    });
    renderTree({ tree });

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const field = screen.getByRole("textbox", { name: "new file name" });
    fireEvent.change(field, { target: { value: "deploy.yaml" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(await screen.findByText("path already exists")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "new file name" })).toBeDefined();
  });

  it("cancels on Escape without creating anything", () => {
    const tree = fakeController(withListing(initialTree(), ROOT, []));
    renderTree({ tree });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const field = screen.getByRole("textbox", { name: "new folder name" });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "new folder name" })).toBeNull();
    expect(tree.createEntry).not.toHaveBeenCalled();
  });
});

describe("the row context menu", () => {
  it("opens on right-click and offers the actions that work", () => {
    renderTree({ tree: fakeController(loadedRoot()) });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDefined();
  });

  // A menu does not advertise what a later ticket will add. Work announces
  // itself by working, and a note about what is missing is something the user
  // has to read past on every open.
  it("says nothing about scope it does not have yet", () => {
    renderTree({ tree: fakeController(loadedRoot()) });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(screen.queryByText(/later ticket|coming soon|not yet/i)).toBeNull();
  });

  it("only offers New File/New Folder for a directory", () => {
    renderTree({ tree: fakeController(loadedRoot()) });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    expect(screen.queryByRole("menuitem", { name: "New File" })).toBeNull();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /manifests/ }));
    expect(screen.getByRole("menuitem", { name: "New File" })).toBeDefined();
  });
});

describe("renaming from the menu", () => {
  it("commits a rename on Enter", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

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
    renderTree({ tree, onOpenFile });

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
    renderTree({ tree });

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
    renderTree({ tree });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(screen.getByText("Delete deploy.yaml?")).toBeDefined();
    expect(tree.deleteEntry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(tree.deleteEntry).toHaveBeenCalledWith("deploy.yaml");
  });

  it("cancels the confirmation without deleting", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

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
    renderTree({ tree, onOpenFile });

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


describe("git in the tree (#8, #40)", () => {
  it("marks a changed file with its badge and its tint", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("deploy.yaml", { worktree: MODIFIED })]),
    });

    const row = screen.getByRole("treeitem", { name: /deploy\.yaml/ });
    expect(row.textContent).toContain("M");
    expect(toneOf(row)).toBe("modified");
  });

  it("says in words what a badge means", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("deploy.yaml", { worktree: UNTRACKED })]),
    });

    expect(screen.getByTitle("untracked").textContent).toBe("?");
  });

  // Green is "git has never seen this", and to someone reading the tree an
  // untracked file and a staged new one are the same fact.
  it("draws an untracked file in the added tint", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("deploy.yaml", { worktree: UNTRACKED })]),
    });

    expect(toneOf(screen.getByRole("treeitem", { name: /deploy\.yaml/ }))).toBe("added");
  });

  // The acceptance criterion this ticket turns on: the rollup comes from the
  // status, not from what the tree has fetched, so a change inside a
  // directory nobody has opened still tints the directory.
  it("tints a collapsed directory holding a change it has never listed", () => {
    const tree = fakeController(loadedRoot());
    renderTree({
      tree,
      status: statusOf([file("manifests/prod.yaml", { worktree: MODIFIED })]),
    });

    const row = screen.getByRole("treeitem", { name: /manifests/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(toneOf(row)).toBe("contains");
    expect(row.textContent).toContain("•");
    // Nothing was fetched to work that out.
    expect(tree.expand).not.toHaveBeenCalled();
  });

  it("escalates a directory holding a conflict to the conflict tint", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("manifests/prod.yaml", { conflicted: true })]),
    });

    const row = screen.getByRole("treeitem", { name: /manifests/ });
    expect(toneOf(row)).toBe("conflicted");
    expect(row.textContent).toContain("U");
  });

  it("leaves a row with no git state unmarked and untinted", () => {
    renderTree({ tree: fakeController(loadedRoot()) });

    const row = screen.getByRole("treeitem", { name: /deploy\.yaml/ });
    expect(row.textContent).toBe("deploy.yaml");
    expect(toneOf(row)).toBeNull();
  });

  // A submodule is a directory on disk and one entry to git, so git's own
  // badge for the path has to win over the rollup marker.
  it("prefers git's own badge over the rollup on a directory row", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([
        file("manifests", { worktree: ADDED }),
        file("manifests/prod.yaml", { worktree: MODIFIED }),
      ]),
    });

    const row = screen.getByRole("treeitem", { name: /manifests/ });
    expect(row.textContent).toContain("A");
    expect(row.textContent).not.toContain("•");
    expect(toneOf(row)).toBe("added");
  });

  // The badge sits beside the name; neither may displace the other.
  it("keeps the name and the action button alongside the badge", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("deploy.yaml", { worktree: MODIFIED })]),
    });

    expect(screen.getByText("deploy.yaml")).toBeDefined();
    expect(screen.getByRole("button", { name: "actions for deploy.yaml" })).toBeDefined();
  });
});

describe("bringing the selected row on screen (#43)", () => {
  /** Every element `scrollIntoView` was called on, in order. */
  function watchScrolling(): Element[] {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    return scrolled;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A reveal from the breadcrumb expands its way to a row that can be well
  // past the bottom of a scrolled tree; a highlight nobody can see is not a
  // reveal.
  it("scrolls the row a reveal selected into view", () => {
    const scrolled = watchScrolling();
    const state = select(loadedManifests(loadedRoot()), "manifests");

    renderTree({ tree: fakeController(state) });

    expect(scrolled).toEqual([screen.getByRole("treeitem", { name: /manifests/ })]);
  });

  it("scrolls nothing when the tree has no selection", () => {
    const scrolled = watchScrolling();

    renderTree({ tree: fakeController(loadedRoot()) });

    expect(scrolled).toEqual([]);
  });

  // The reveal expands a directory the tree may never have listed, so the row
  // does not exist on the render the selection arrives on. Giving up there
  // would leave the reveal off screen for every directory that had to be
  // fetched — which is exactly the case it is most needed in.
  it("scrolls once the row the selection names finally appears", () => {
    const scrolled = watchScrolling();
    const view = render(
      <FileTree
        tree={fakeController(select(loadedRoot(), "manifests/prod.yaml"))}
        status={emptyStatus()}
        onOpenFile={vi.fn()}
        overridden={NO_OVERRIDES}
        onBind={vi.fn()}
      />,
    );
    expect(scrolled).toEqual([]);

    view.rerender(
      <FileTree
        tree={fakeController(select(loadedManifests(loadedRoot()), "manifests/prod.yaml"))}
        status={emptyStatus()}
        onOpenFile={vi.fn()}
        overridden={NO_OVERRIDES}
        onBind={vi.fn()}
      />,
    );

    expect(scrolled).toEqual([screen.getByRole("treeitem", { name: /prod\.yaml/ })]);
  });
});

describe("the changed-only mode (#40)", () => {
  /** A change three levels down, in a tree that has listed only its root. */
  const deep = statusOf([file("manifests/prod/app.yaml", { worktree: MODIFIED })]);

  it("shows a change under its ancestors without anything being expanded", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree, status: deep });
    // The full tree has no row for it: neither directory has been listed.
    expect(screen.queryByRole("treeitem", { name: /app\.yaml/ })).toBeNull();

    showChangedOnly();

    expect(screen.getAllByRole("treeitem").map((el) => el.textContent)).toEqual([
      "manifests•",
      "prod•",
      "app.yamlM",
    ]);
    expect(tree.expand).not.toHaveBeenCalled();
  });

  it("goes back to the full tree when the toggle is pressed again", () => {
    renderTree({ tree: fakeController(loadedRoot()), status: deep });

    showChangedOnly();
    fireEvent.click(screen.getByRole("button", { name: "Changed only" }));

    expect(screen.getAllByRole("treeitem").map((el) => el.textContent)).toEqual([
      "manifests•",
      "deploy.yaml",
    ]);
  });

  it("shows deletions, struck through, and only in this mode", () => {
    const status = statusOf([file("gone.yaml", { staged: DELETED })]);
    renderTree({ tree: fakeController(loadedRoot()), status });
    // Not on disk, so no listing contains it.
    expect(screen.queryByRole("treeitem", { name: /gone\.yaml/ })).toBeNull();

    showChangedOnly();

    const row = screen.getByRole("treeitem", { name: /gone\.yaml/ });
    expect(toneOf(row)).toBe("deleted");
    expect(row.textContent).toContain("D");
  });

  it("does not try to open a file git says is gone", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    renderTree({ tree, status: statusOf([file("gone.yaml", { staged: DELETED })]), onOpenFile });
    showChangedOnly();

    fireEvent.click(screen.getByRole("treeitem", { name: /gone\.yaml/ }));

    expect(onOpenFile).not.toHaveBeenCalled();
    expect(tree.select).not.toHaveBeenCalled();
  });

  it("still opens a changed file that is on disk", () => {
    const tree = fakeController(loadedRoot());
    const onOpenFile = vi.fn();
    renderTree({ tree, status: statusOf([file("deploy.yaml", { worktree: MODIFIED })]), onOpenFile });
    showChangedOnly();

    fireEvent.click(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(onOpenFile).toHaveBeenCalledWith("deploy.yaml");
  });

  // The mode's rows are built with their ancestors in place; a twisty here
  // would hide changes from the list whose whole job is to show them, and
  // collapsing a directory the tree may never have listed would send it off
  // to fetch one for a row it is not rendering from a listing.
  it("does not expand or collapse the directories it synthesises", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree, status: deep });
    showChangedOnly();

    const row = screen.getByRole("treeitem", { name: /manifests/ });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(row);
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowLeft" });

    expect(tree.expand).not.toHaveBeenCalled();
    expect(tree.collapse).not.toHaveBeenCalled();
  });

  it("keeps a conflict marked in this mode too", () => {
    renderTree({
      tree: fakeController(loadedRoot()),
      status: statusOf([file("deploy.yaml", { conflicted: true })]),
    });
    showChangedOnly();

    const row = screen.getByRole("treeitem", { name: /deploy\.yaml/ });
    expect(toneOf(row)).toBe("conflicted");
    expect(row.textContent).toContain("U");
  });

  it("says the repository is clean rather than that it is empty", () => {
    renderTree({ tree: fakeController(loadedRoot()) });
    showChangedOnly();

    expect(screen.getByText("Nothing has changed in this project.")).toBeDefined();
    expect(screen.queryByText("No files in this project.")).toBeNull();
  });
});

/**
 * The row menu (#10, and the placement bug that came with it).
 *
 * It used to be `position: fixed` with no coordinates at all, which resolves to
 * the element's static position: inside a flex row that has already laid out,
 * that is hundreds of pixels below the pointer, and wrong again the moment the
 * tree scrolled.
 */
describe("the row context menu", () => {
  it("opens where the pointer was", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /manifests/ }), {
      clientX: 240,
      clientY: 310,
    });

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("240px");
    expect(menu.style.top).toBe("310px");
  });

  // Without this a right-click near the bottom of a tall tree opens a menu
  // whose last item is off screen, and the item most likely to be cut off is
  // Delete.
  it("holds the menu inside the window", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /manifests/ }), {
      clientX: window.innerWidth - 4,
      clientY: window.innerHeight - 4,
    });

    const menu = screen.getByRole("menu");
    expect(Number.parseInt(menu.style.left, 10)).toBeLessThan(window.innerWidth - 4);
    expect(Number.parseInt(menu.style.top, 10)).toBeLessThan(window.innerHeight - 4);
  });

  // Kubernetes is the reason to open this menu on a directory; the file
  // operations below it are the ones every tree has.
  it("puts Kubernetes first on a directory, with its own mark", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /manifests/ }));

    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Kubernetes",
      "New File",
      "New Folder",
      "Rename",
      "Delete",
    ]);
    expect(items[0].querySelector('[data-icon="kubernetes"]')).not.toBeNull();
  });

  it("offers no Kubernetes entry on a file", () => {
    const tree = fakeController(loadedRoot());
    renderTree({ tree });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /deploy\.yaml/ }));

    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Kubernetes" }),
    ).toBeNull();
  });
});
