import { describe, expect, it } from "vitest";
import type { Entry } from "./tree";
import {
  ROOT,
  affectedTrackedDirs,
  baseName,
  collapse,
  expand,
  iconKind,
  initialTree,
  isHidden,
  joinPath,
  looksLikeManifest,
  parentPath,
  resolveIconKind,
  select,
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
