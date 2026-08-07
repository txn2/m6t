import { describe, expect, it } from "vitest";
import type { Entry, TreeState } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  ancestry,
  baseName,
  collapse,
  expand,
  iconKind,
  initialTree,
  isHidden,
  joinPath,
  looksLikeManifest,
  openDirs,
  parentPath,
  resolveIconKind,
  locate,
  reveal,
  select,
  toggleChangedOnly,
  toggleHidden,
  visibleChildren,
  visibleRows,
  withError,
  withListing,
  withLoading,
  withManifests,
  yamlPaths,
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

describe("base names", () => {
  it("returns a top-level path unchanged", () => {
    expect(baseName("deploy.yaml")).toBe("deploy.yaml");
  });

  it("returns the last segment of a nested path", () => {
    expect(baseName("charts/api/values.yaml")).toBe("values.yaml");
  });
});

describe("icon buckets", () => {
  it("buckets a directory regardless of name", () => {
    expect(iconKind("manifests/deploy.yaml", true)).toBe("dir");
  });

  it.each([
    // Names that settle it on their own.
    ["Dockerfile", "docker"],
    ["ops/Containerfile", "docker"],
    ["build.dockerfile", "docker"],
    ["Makefile", "make"],
    ["GNUmakefile", "make"],
    ["build/rules.mk", "make"],
    // Extensions.
    ["README.md", "md"],
    ["notes.markdown", "md"],
    ["internal/app/app.go", "go"],
    ["src/lib/tree.ts", "ts"],
    ["src/components/FileTree.tsx", "tsx"],
    ["vite.config.mts", "ts"],
    ["scripts/gate.js", "js"],
    ["scripts/gate.mjs", "js"],
    ["package.json", "json"],
    ["scripts/run.sh", "shell"],
    ["Cargo.toml", "toml"],
    // Neither: a generic file.
    ["LICENSE", "file"],
    ["frontend/dist/.gitkeep", "file"],
    ["notes.txt", "file"],
  ])("buckets %s as %s", (path, want) => {
    expect(iconKind(path, false)).toBe(want);
  });

  it("matches names and extensions case-insensitively", () => {
    expect(iconKind("charts/api/VALUES.YAML", false)).toBe("helm");
    expect(iconKind("DOCKERFILE", false)).toBe("docker");
    expect(iconKind("READ.MD", false)).toBe("md");
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "buckets a file named %s as a plain file",
    (name) => {
      // A name that collides with Object.prototype: an object-literal lookup
      // answers "present" for every one of these and returns a function,
      // which TypeScript cannot catch behind an index signature typed as
      // IconKind. The result would be an icon with no artwork behind it.
      expect(iconKind(name, false)).toBe("file");
      expect(iconKind(`src/${name}.ts`, false)).toBe("ts");
    },
  );

  it("does not read a leading dot as an extension", () => {
    // `.gitignore` is a dotfile, not a file of type "gitignore" — but a
    // dotfile with a real suffix still has one.
    expect(iconKind(".gitignore", false)).toBe("file");
    expect(iconKind(".golangci.yml", false)).toBe("yaml");
  });
});

describe("YAML dialects", () => {
  it.each([
    // Helm: the chart's own files, its values, anything it templates.
    ["charts/api/Chart.yaml", "helm"],
    ["charts/api/Chart.lock", "helm"],
    ["charts/api/values.yaml", "helm"],
    ["charts/api/values-prod.yaml", "helm"],
    ["charts/api/templates/deployment.yaml", "helm"],
    // Kustomize.
    ["overlays/prod/kustomization.yaml", "kustomize"],
    ["overlays/prod/kustomization.yml", "kustomize"],
    // CI, which lives at one known path.
    [".github/workflows/ci.yml", "actions"],
    [".github/workflows/release.yaml", "actions"],
  ])("reads %s as %s", (path, want) => {
    expect(iconKind(path, false)).toBe(want);
  });

  it.each([
    // Everything a name cannot settle is plain YAML, wherever it sits. Only
    // content promotes one of these to a manifest.
    ["manifests/prod/ingress.yaml", "yaml"],
    ["deploy/svc.yml", "yaml"],
    ["codecov.yml", "yaml"],
    ["docker-compose.yaml", "yaml"],
    [".golangci.yml", "yaml"],
    ["ops/workflows/argo.yaml", "yaml"],
  ])("leaves %s for content to settle", (path, want) => {
    expect(iconKind(path, false)).toBe(want);
  });

  it("never guesses Kubernetes from a path", () => {
    // The gate on the rule this replaced, which read any YAML below the
    // repository root as a manifest.
    for (const path of ["manifests/prod/ingress.yaml", "deploy/svc.yml", "k8s/a.yaml"]) {
      expect(iconKind(path, false)).not.toBe("kubernetes");
    }
  });
});

describe("classifying a manifest by content", () => {
  it.each([
    ["apiVersion: apps/v1\nkind: Deployment\n"],
    ["kind: Deployment\napiVersion: apps/v1\n"],
    ["# a comment first\n---\napiVersion: v1\nkind: Service\n"],
    ["apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n"],
  ])("reads %j as a manifest", (head) => {
    expect(looksLikeManifest(head)).toBe(true);
  });

  it.each([
    [""],
    ["coverage:\n  status: off\n"],
    // Both keys are required: a chart's values file can carry its own kind.
    ["apiVersion: v2\nname: api\nversion: 0.1.0\n"],
    ["kind: pipeline\ntype: docker\n"],
    // Nested is not top level — this is a pod spec fragment inside a chart
    // value, not an object.
    ["controller:\n  apiVersion: apps/v1\n  kind: Deployment\n"],
    // A key with no value is not a declaration.
    ["apiVersion:\nkind:\n"],
  ])("reads %j as plain YAML", (head) => {
    expect(looksLikeManifest(head)).toBe(false);
  });

  it("upgrades only plain YAML", () => {
    expect(resolveIconKind("yaml", true)).toBe("kubernetes");
    expect(resolveIconKind("yaml", false)).toBe("yaml");
    // A path rule that fired is the stronger statement; content cannot
    // overrule it, or every chart template would stop looking like Helm.
    expect(resolveIconKind("helm", true)).toBe("helm");
    expect(resolveIconKind("kustomize", true)).toBe("kustomize");
    expect(resolveIconKind("actions", true)).toBe("actions");
    expect(resolveIconKind("md", true)).toBe("md");
  });
});

describe("the lazy classification's bookkeeping", () => {
  const listing = [
    { name: "deploy.yaml", isDir: false },
    { name: "notes.md", isDir: false },
    { name: "Chart.yaml", isDir: false },
    { name: "templates", isDir: true },
  ];

  it("asks only about the files whose icon content can change", () => {
    const state = withListing(initialTree(), "charts/api", listing);
    // Chart.yaml is Helm by name and templates/ is a directory; neither is
    // worth a read, and notes.md is not YAML at all.
    expect(yamlPaths("charts/api", state.dirs["charts/api"].children)).toEqual([
      "charts/api/deploy.yaml",
    ]);
  });

  it("records both answers, so a negative is not asked again in vain", () => {
    const asked = ["a.yaml", "b.yaml", "gone.yaml"];
    const state = withManifests(initialTree(), { "a.yaml": "apiVersion: v1\nkind: Pod\n", "b.yaml": "x: 1\n" }, asked);

    expect(state.manifests.get("a.yaml")).toBe(true);
    expect(state.manifests.get("b.yaml")).toBe(false);
    // A path the backend could not answer for is still recorded — absence
    // from the map means "not read", and this one was.
    expect(state.manifests.get("gone.yaml")).toBe(false);
  });

  it("keeps earlier answers when a later batch lands", () => {
    const first = withManifests(initialTree(), { "a.yaml": "apiVersion: v1\nkind: Pod\n" }, ["a.yaml"]);
    const second = withManifests(first, { "b.yaml": "apiVersion: v1\nkind: Service\n" }, ["b.yaml"]);

    expect(second.manifests.get("a.yaml")).toBe(true);
    expect(second.manifests.get("b.yaml")).toBe(true);
  });

  it("lets a re-read change its mind about a file", () => {
    // The reason yamlPaths does not exclude what is already classified: a
    // file edited into a manifest must stop showing the plain YAML icon.
    const before = withManifests(initialTree(), { "a.yaml": "x: 1\n" }, ["a.yaml"]);
    const after = withManifests(before, { "a.yaml": "apiVersion: v1\nkind: Pod\n" }, ["a.yaml"]);

    expect(before.manifests.get("a.yaml")).toBe(false);
    expect(after.manifests.get("a.yaml")).toBe(true);
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

describe("the ancestor chain (#43)", () => {
  it("walks a nested path outermost first, ending at the path itself", () => {
    expect(ancestry("manifests/prod/ingress.yaml")).toEqual([
      "manifests",
      "manifests/prod",
      "manifests/prod/ingress.yaml",
    ]);
  });

  it("gives a top-level path one segment", () => {
    expect(ancestry("README.md")).toEqual(["README.md"]);
  });

  it("gives root no segments at all", () => {
    expect(ancestry(ROOT)).toEqual([]);
  });

  it("drops empty segments rather than emitting a nameless one", () => {
    expect(ancestry("a//b")).toEqual(["a", "a/b"]);
  });
});

describe("locating a file (#56)", () => {
  it("expands the directories above it and selects the file", () => {
    const state = locate(initialTree(), "manifests/prod/ingress.yaml");

    expect([...state.expanded].sort()).toEqual([ROOT, "manifests", "manifests/prod"]);
    expect(state.selected).toBe("manifests/prod/ingress.yaml");
  });

  // The difference from `reveal`, and the reason this is not just a call to
  // it: a file in the expanded set is a directory listing nobody will fetch,
  // and the hook would ask the backend to list a file.
  it("does not expand the file itself", () => {
    const state = locate(initialTree(), "manifests/prod/ingress.yaml");

    expect(state.expanded.has("manifests/prod/ingress.yaml")).toBe(false);
  });

  it("selects a file at the root without expanding anything new", () => {
    const state = locate(initialTree(), "README.md");

    expect(state.selected).toBe("README.md");
    expect([...state.expanded]).toEqual([ROOT]);
  });

  it("leaves changed-only mode, which would otherwise hide the file", () => {
    const filtered = toggleChangedOnly(initialTree());

    expect(locate(filtered, "manifests/ingress.yaml").changedOnly).toBe(false);
  });

  // The case a parent-only hidden check gets wrong: this file has no hidden
  // ancestor, so revealing its parent alone would leave the filter on and the
  // locate would do nothing at all.
  it("shows hidden files for a dotfile at the root", () => {
    expect(locate(initialTree(), ".gitignore").showHidden).toBe(true);
  });

  it("shows hidden files for a file under a hidden directory", () => {
    const state = locate(initialTree(), ".github/workflows/ci.yml");

    expect(state.showHidden).toBe(true);
    expect(state.expanded.has(".github/workflows")).toBe(true);
  });

  it("leaves the filter alone for an ordinary file", () => {
    expect(locate(initialTree(), "manifests/ingress.yaml").showHidden).toBe(false);
  });

  // The view scrolls a located row to the middle of the pane and an ordinary
  // selection only into view, and it cannot tell the two apart from `selected`
  // alone — locating a file that is already selected changes nothing else.
  it("records a request every time, including for the file already selected", () => {
    const first = locate(initialTree(), "manifests/ingress.yaml");
    const again = locate(first, "manifests/ingress.yaml");

    expect(first.locateRequest).toBe(initialTree().locateRequest + 1);
    expect(again.locateRequest).toBe(first.locateRequest + 1);
    expect(again.selected).toBe(first.selected);
  });

  it("is the only thing that records one", () => {
    const located = locate(initialTree(), "manifests/ingress.yaml");

    for (const state of [
      select(located, "other.yaml"),
      reveal(located, "manifests"),
      expand(located, "manifests"),
      toggleHidden(located),
      toggleChangedOnly(located),
    ]) {
      expect(state.locateRequest).toBe(located.locateRequest);
    }
  });
});

describe("revealing a directory (#43)", () => {
  it("expands the directory and every directory above it", () => {
    const state = reveal(initialTree(), "manifests/prod");

    expect([...state.expanded].sort()).toEqual([ROOT, "manifests", "manifests/prod"]);
    expect(state.selected).toBe("manifests/prod");
  });

  it("keeps directories that were already open", () => {
    const state = reveal(expand(initialTree(), "charts"), "manifests");

    expect(state.expanded.has("charts")).toBe(true);
  });

  // Both of these are filters that would otherwise swallow the reveal whole:
  // the row would be expanded in a list that does not contain it.
  it("leaves changed-only mode so a directory with no changes can be seen", () => {
    const filtered = toggleChangedOnly(initialTree());

    expect(reveal(filtered, "manifests").changedOnly).toBe(false);
  });

  it("shows dotfiles when a segment of the path is one", () => {
    const state = reveal(initialTree(), ".github/workflows");

    expect(state.showHidden).toBe(true);
  });

  it("leaves the dotfile filter alone for a path with nothing hidden in it", () => {
    expect(reveal(initialTree(), "manifests/prod").showHidden).toBe(false);
  });

  // The listing is useFileTree's job (it is the half that can call a backend);
  // this must not invent an empty one, which would render the directory as
  // loaded and empty rather than as loading.
  it("fetches nothing and claims no listing", () => {
    expect(reveal(initialTree(), "manifests").dirs).toEqual({});
  });
});

describe("the changed-only filter (#40)", () => {
  it("starts off and flips both ways", () => {
    const on = toggleChangedOnly(initialTree());
    expect(initialTree().changedOnly).toBe(false);
    expect(on.changedOnly).toBe(true);
    expect(toggleChangedOnly(on).changedOnly).toBe(false);
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

describe("the directories a returning project re-lists", () => {
  /** A tree with `manifests` and `manifests/prod` listed and expanded. */
  function opened(): TreeState {
    let state = withListing(initialTree(), ROOT, [entry("manifests", true)]);
    state = withListing(expand(state, "manifests"), "manifests", [entry("prod", true)]);
    return withListing(expand(state, "manifests/prod"), "manifests/prod", [entry("a.yaml")]);
  }

  it("names root even when nothing has been loaded", () => {
    expect(openDirs(initialTree())).toEqual([ROOT]);
  });

  it("names every expanded directory on screen, outermost first", () => {
    expect(openDirs(opened())).toEqual([ROOT, "manifests", "manifests/prod"]);
  });

  it("skips a directory whose parent is collapsed", () => {
    // `manifests/prod` is still expanded and still loaded, but it draws
    // nothing while `manifests` is closed — re-listing it would be a round
    // trip for rows nobody can see.
    expect(openDirs(collapse(opened(), "manifests"))).toEqual([ROOT]);
  });

  it("skips a directory the hidden-file filter is keeping off screen", () => {
    let state = withListing(initialTree(), ROOT, [entry(".github", true)]);
    state = withListing(expand(state, ".github"), ".github", [entry("workflows", true)]);

    expect(openDirs(state)).toEqual([ROOT]);
    expect(openDirs(toggleHidden(state))).toEqual([ROOT, ".github"]);
  });
});
