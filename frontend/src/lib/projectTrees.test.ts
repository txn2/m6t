import { describe, expect, it } from "vitest";
import type { Entry } from "./tree";
import { ROOT, initialTree, select, toggleChangedOnly, withListing } from "./tree";
import { treeFor, withTree, withoutTree } from "./projectTrees";

function entry(name: string, isDir = false): Entry {
  return { name, isDir };
}

describe("holding one tree per project (#59)", () => {
  it("answers with a blank tree for a project it has never held", () => {
    const blank = treeFor({}, "/w/infra");
    expect(blank.dirs).toEqual({});
    expect([...blank.expanded]).toEqual([ROOT]);
    expect(blank.selected).toBeNull();
  });

  it("answers with a blank tree when there is no project at all", () => {
    expect(treeFor({}, null).dirs).toEqual({});
  });

  it("keeps each project's listings under its own root", () => {
    const infra = withListing(initialTree(), "manifests", [entry("infra.yaml")]);
    const apps = withListing(initialTree(), "manifests", [entry("apps.yaml")]);
    const trees = withTree(withTree({}, "/w/infra", infra), "/w/apps", apps);

    // The same relative path in two checkouts. A map that did not distinguish
    // them would show one project's listing under the other.
    expect(treeFor(trees, "/w/infra").dirs.manifests.children[0].name).toBe("infra.yaml");
    expect(treeFor(trees, "/w/apps").dirs.manifests.children[0].name).toBe("apps.yaml");
  });

  it("moves the changed-files filter for every project at once", () => {
    const trees = withTree(
      withTree({}, "/w/infra", initialTree()),
      "/w/apps",
      initialTree(),
    );

    const filtered = withTree(trees, "/w/infra", toggleChangedOnly(treeFor(trees, "/w/infra")));

    expect(filtered["/w/infra"].changedOnly).toBe(true);
    expect(filtered["/w/apps"].changedOnly).toBe(true);
  });

  it("gives a project it has never held the filter the others are showing", () => {
    const trees = withTree({}, "/w/infra", toggleChangedOnly(initialTree()));
    expect(treeFor(trees, "/w/apps").changedOnly).toBe(true);
  });

  it("leaves the other projects' state alone when one changes", () => {
    const apps = withListing(initialTree(), ROOT, [entry("a.yaml")]);
    const trees = withTree(withTree({}, "/w/apps", apps), "/w/infra", initialTree());

    const next = withTree(trees, "/w/infra", select(treeFor(trees, "/w/infra"), "b.yaml"));

    expect(next["/w/apps"]).toBe(apps);
  });

  it("drops a project's tree", () => {
    const trees = withTree({}, "/w/infra", initialTree());
    expect(withoutTree(trees, "/w/infra")).toEqual({});
  });

  it("leaves the map untouched when the project was never held", () => {
    const trees = withTree({}, "/w/infra", initialTree());
    expect(withoutTree(trees, "/w/apps")).toBe(trees);
  });
});
