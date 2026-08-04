import { describe, expect, it } from "vitest";
import type { Entry } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  collapse,
  expand,
  iconKind,
  initialTree,
  isHidden,
  joinPath,
  parentPath,
  select,
  toggleHidden,
  visibleChildren,
  visibleRows,
  withError,
  withListing,
  withLoading,
} from "./tree";

function entry(name: string, isDir = false): Entry {
  return { name, isDir };
}

describe("paths", () => {
  it("joins a name onto root with no separator", () => {
    expect(joinPath(ROOT, "a.yaml")).toBe("a.yaml");
  });

  it("joins a name onto a nested directory with a separator", () => {
    expect(joinPath("manifests", "deploy.yaml")).toBe("manifests/deploy.yaml");
  });

  it("finds a top-level entry's parent as root", () => {
    expect(parentPath("a.yaml")).toBe(ROOT);
  });

  it("finds a nested entry's parent", () => {
    expect(parentPath("manifests/prod/deploy.yaml")).toBe("manifests/prod");
  });
});

describe("icon buckets", () => {
  it("buckets a directory regardless of name", () => {
    expect(iconKind(entry("a.yaml", true))).toBe("dir");
  });

  it.each([
    ["deploy.yaml", "yaml"],
    ["deploy.yml", "yaml"],
    ["README.md", "md"],
    ["notes.markdown", "md"],
    ["values.YAML", "yaml"],
    ["Makefile", "file"],
  ])("buckets %s as %s", (name, want) => {
    expect(iconKind(entry(name))).toBe(want);
  });
});

describe("hidden files", () => {
  it("treats a dot-prefixed name as hidden", () => {
    expect(isHidden(entry(".env"))).toBe(true);
    expect(isHidden(entry("env"))).toBe(false);
  });

  it("filters hidden entries out unless the tree shows them", () => {
    const state = withListing(initialTree(), ROOT, [entry(".env"), entry("a.yaml")]);
    expect(visibleChildren(state, ROOT).map((e) => e.name)).toEqual(["a.yaml"]);

    const shown = toggleHidden(state);
    expect(visibleChildren(shown, ROOT).map((e) => e.name)).toEqual([".env", "a.yaml"]);
  });
});

describe("loading a directory", () => {
  it("starts with root pre-expanded and nothing loaded", () => {
    const state = initialTree();
    expect(state.expanded.has(ROOT)).toBe(true);
    expect(state.dirs).toEqual({});
  });

  it("records a listing and computes each entry's path", () => {
    const state = withListing(initialTree(), "manifests", [entry("deploy.yaml"), entry("prod", true)]);
    expect(state.dirs.manifests).toEqual({
      status: "loaded",
      error: null,
      children: [
        { name: "deploy.yaml", isDir: false, path: "manifests/deploy.yaml" },
        { name: "prod", isDir: true, path: "manifests/prod" },
      ],
    });
  });

  it("keeps the last-known children while a directory reloads", () => {
    const loaded = withListing(initialTree(), ROOT, [entry("a.yaml")]);
    const reloading = withLoading(loaded, ROOT);
    expect(reloading.dirs[ROOT].status).toBe("loading");
    expect(reloading.dirs[ROOT].children).toEqual(loaded.dirs[ROOT].children);
  });

  it("keeps the last-known children when a reload fails", () => {
    const loaded = withListing(initialTree(), ROOT, [entry("a.yaml")]);
    const failed = withError(loaded, ROOT, "permission denied");
    expect(failed.dirs[ROOT].status).toBe("error");
    expect(failed.dirs[ROOT].error).toBe("permission denied");
    expect(failed.dirs[ROOT].children).toEqual(loaded.dirs[ROOT].children);
  });
});

describe("expand and collapse", () => {
  it("expands a directory once", () => {
    const state = expand(initialTree(), "manifests");
    expect(state.expanded.has("manifests")).toBe(true);
  });

  it("is a no-op expanding an already-expanded directory", () => {
    const state = expand(initialTree(), "manifests");
    expect(expand(state, "manifests")).toBe(state);
  });

  it("collapses a directory without discarding its listing", () => {
    const loaded = withListing(expand(initialTree(), "manifests"), "manifests", [entry("a.yaml")]);
    const collapsed = collapse(loaded, "manifests");
    expect(collapsed.expanded.has("manifests")).toBe(false);
    expect(collapsed.dirs.manifests).toEqual(loaded.dirs.manifests);
  });

  it("is a no-op collapsing an already-collapsed directory", () => {
    const state = initialTree();
    expect(collapse(state, "manifests")).toBe(state);
  });
});

describe("selection", () => {
  it("selects and clears a path", () => {
    const selected = select(initialTree(), "a.yaml");
    expect(selected.selected).toBe("a.yaml");
    expect(select(selected, null).selected).toBeNull();
  });
});

describe("flattening the tree for rendering", () => {
  it("shows only root's children when nothing is expanded", () => {
    const state = withListing(initialTree(), ROOT, [entry("manifests", true), entry("a.yaml")]);
    expect(visibleRows(state).map((r) => [r.path, r.depth])).toEqual([
      ["manifests", 0],
      ["a.yaml", 0],
    ]);
  });

  it("inlines an expanded directory's children depth-first", () => {
    let state = withListing(initialTree(), ROOT, [entry("manifests", true), entry("z.yaml")]);
    state = expand(state, "manifests");
    state = withListing(state, "manifests", [entry("deploy.yaml")]);

    expect(visibleRows(state).map((r) => [r.path, r.depth])).toEqual([
      ["manifests", 0],
      ["manifests/deploy.yaml", 1],
      ["z.yaml", 0],
    ]);
  });

  it("does not descend into a collapsed directory even if it was loaded once", () => {
    let state = withListing(initialTree(), ROOT, [entry("manifests", true)]);
    state = expand(state, "manifests");
    state = withListing(state, "manifests", [entry("deploy.yaml")]);
    state = collapse(state, "manifests");

    expect(visibleRows(state).map((r) => r.path)).toEqual(["manifests"]);
  });
});

describe("applying a tree-changed event", () => {
  it("reports only directories the tree has actually loaded", () => {
    const state = withListing(initialTree(), "manifests", [entry("a.yaml")]);
    expect(affectedTrackedDirs(state, ["manifests", "untouched"])).toEqual(["manifests"]);
  });

  it("translates the wire's root marker to this package's ROOT", () => {
    const state = withListing(initialTree(), ROOT, [entry("a.yaml")]);
    expect(affectedTrackedDirs(state, ["."])).toEqual([ROOT]);
  });

  it("reports nothing for a directory that was never loaded", () => {
    expect(affectedTrackedDirs(initialTree(), ["manifests"])).toEqual([]);
  });
});
