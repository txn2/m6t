import { describe, expect, it } from "vitest";
import { project as models } from "../../wailsjs/go/models";
import type { Project } from "./projects";
import {
  findProject,
  selectionAfterReload,
  selectionAfterRemove,
} from "./projects";

const named = (...names: string[]): Project[] =>
  names.map((name) =>
    models.Project.createFrom({
      name,
      path: `/w/${name}`,
      kube: { context: "", namespace: "", protected: false },
      helm: { defaultValues: [] },
    }),
  );

describe("the selection after a project is removed", () => {
  // Removing a project the user is not looking at must not move them.
  it("leaves an unrelated selection alone", () => {
    expect(selectionAfterRemove(named("a", "b", "c"), "c", "a")).toBe("a");
  });

  it("moves to the right-hand neighbour", () => {
    expect(selectionAfterRemove(named("a", "b", "c"), "b", "b")).toBe("c");
  });

  it("falls back to the left at the end of the strip", () => {
    expect(selectionAfterRemove(named("a", "b", "c"), "c", "c")).toBe("b");
  });

  it("selects nothing when the last project goes", () => {
    expect(selectionAfterRemove(named("a"), "a", "a")).toBeNull();
  });

  it("leaves the selection alone when the name is not registered", () => {
    expect(selectionAfterRemove(named("a", "b"), "ghost", "ghost")).toBe(
      "ghost",
    );
  });
});

describe("the selection after the list reloads", () => {
  it("stays on the project the user is working in", () => {
    expect(selectionAfterReload(named("a", "b"), "b")).toBe("b");
  });

  // projects.yaml is editable by hand while m6t runs (DESIGN.md §4), so the
  // active project can vanish underneath the selection.
  it("falls back to the first when the active project is gone", () => {
    expect(selectionAfterReload(named("a", "b"), "removed")).toBe("a");
  });

  it("selects the first project when nothing was selected", () => {
    expect(selectionAfterReload(named("a", "b"), null)).toBe("a");
  });

  it("selects nothing when the registry is empty", () => {
    expect(selectionAfterReload([], "a")).toBeNull();
  });
});

describe("finding a project by name", () => {
  it("returns the project", () => {
    expect(findProject(named("a", "b"), "b")?.path).toBe("/w/b");
  });

  // The selection and the list are separate state; a render between a removal
  // and the selection catching up must not crash.
  it("returns null for a name that is gone", () => {
    expect(findProject(named("a"), "b")).toBeNull();
  });

  it("returns null when nothing is selected", () => {
    expect(findProject(named("a"), null)).toBeNull();
  });
});
