import { describe, expect, it } from "vitest";
import { project as models } from "../../wailsjs/go/models";
import type { Project } from "./projects";
import {
  directoryName,
  findProject,
  orderAfterDrag,
  orderProjects,
  projectColor,
  projectLabel,
  selectionAfterReload,
  selectionAfterRemove,
  settingsFor,
} from "./projects";

const named = (...names: string[]): Project[] =>
  names.map((name) =>
    models.Project.createFrom({
      name,
      path: `/w/${name}`,
      displayName: "",
      color: "",
      kube: { context: "", namespace: "", protected: false },
      helm: { defaultValues: [] },
    }),
  );

const order = (projects: readonly Project[]) => projects.map((p) => p.name);

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

describe("what a project tab says (#41)", () => {
  const labelled = (displayName: string) =>
    models.Project.createFrom({
      name: "k8s",
      path: "/w/ops/k8s",
      displayName,
      color: "",
      kube: { context: "", namespace: "", protected: false },
      helm: { defaultValues: [] },
    });

  it("shows the label the user gave the project", () => {
    expect(projectLabel(labelled("Production infra"))).toBe("Production infra");
  });

  // Every registry written before this ticket, and every project added without
  // typing a name, has no label at all.
  it("falls back to the registry name when there is no label", () => {
    expect(projectLabel(labelled(""))).toBe("k8s");
    expect(projectLabel(labelled("   "))).toBe("k8s");
  });

  // The generated model copies keys straight out of the bridge payload, so a
  // record produced without the field arrives as undefined rather than "".
  it("survives a record with no label field at all", () => {
    expect(projectLabel(models.Project.createFrom({ name: "k8s" }))).toBe("k8s");
  });
});

describe("the tab colour", () => {
  it("resolves a palette name", () => {
    expect(projectColor("amber")).toBe("amber");
  });

  // projects.yaml is editable by hand (DESIGN.md §4), and the value in it must
  // never become a colour this build did not define.
  it("rejects anything the palette does not hold", () => {
    expect(projectColor("chartreuse")).toBeNull();
    expect(projectColor("")).toBeNull();
    expect(projectColor(undefined)).toBeNull();
  });
});

describe("the settings sent with a rename", () => {
  const bound = models.Project.createFrom({
    name: "k8s",
    path: "/w/k8s",
    displayName: "Old",
    color: "blue",
    kube: { context: "prod-us-west", namespace: "platform", protected: true },
    helm: { defaultValues: ["values.yaml"] },
  });

  // Update replaces the mutable half whole. A rename that sent only the name
  // would unbind the cluster of every project the user renamed.
  it("carries the kube binding and helm defaults through", () => {
    const settings = settingsFor(bound, { displayName: "New" });

    expect(settings.displayName).toBe("New");
    expect(settings.color).toBe("blue");
    expect(settings.kube.context).toBe("prod-us-west");
    expect(settings.kube.protected).toBe(true);
    expect(settings.helm.defaultValues).toEqual(["values.yaml"]);
  });

  it("keeps the label when only the colour changes", () => {
    expect(settingsFor(bound, { color: "red" })).toMatchObject({
      displayName: "Old",
      color: "red",
    });
  });

  // Clearing is a colour of "", which is a value and not an absent patch.
  it("clears the colour rather than treating it as unset", () => {
    expect(settingsFor(bound, { color: "" }).color).toBe("");
  });
});

describe("the name suggested for a chosen directory", () => {
  it("is the directory's own name", () => {
    expect(directoryName("/w/ops/k8s")).toBe("k8s");
    expect(directoryName("/w/ops/k8s/")).toBe("k8s");
  });

  // The path comes from the OS picker and m6t runs on Windows too.
  it("handles a Windows path", () => {
    expect(directoryName("C:\\work\\ops\\k8s")).toBe("k8s");
  });

  it("has nothing better to offer for a root", () => {
    expect(directoryName("/")).toBe("/");
  });
});

describe("the order a finished drag settled on", () => {
  const NAMES = ["alpha", "beta", "gamma"];

  it("moves the dragged tab to where it was dropped", () => {
    expect(orderAfterDrag(NAMES, "gamma", "alpha")).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(orderAfterDrag(NAMES, "alpha", "gamma")).toEqual([
      "beta",
      "gamma",
      "alpha",
    ]);
  });

  // Every click that drifted past the sensor's threshold ends here. Treating
  // it as a reorder would write projects.yaml each time a project was opened.
  it("is not a reorder when the tab lands back on itself", () => {
    expect(orderAfterDrag(NAMES, "beta", "beta")).toBeNull();
  });

  // A drag let go outside the strip has nothing under it.
  it("is not a reorder when it was dropped over nothing", () => {
    expect(orderAfterDrag(NAMES, "beta", undefined)).toBeNull();
  });

  // The list can change underneath a drag: projects.yaml is editable by hand
  // while m6t runs (DESIGN.md §4).
  it("is not a reorder when either end is no longer registered", () => {
    expect(orderAfterDrag(NAMES, "ghost", "alpha")).toBeNull();
    expect(orderAfterDrag(NAMES, "alpha", "ghost")).toBeNull();
  });

  it("does not mutate the names it was given", () => {
    const before = [...NAMES];
    orderAfterDrag(before, "gamma", "alpha");
    expect(before).toEqual(NAMES);
  });
});

describe("putting the projects in the order a drag settled on", () => {
  it("orders them as the names say", () => {
    expect(order(orderProjects(named("a", "b", "c"), ["c", "a", "b"]))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  // The list can change underneath a drag: projects.yaml is editable by hand
  // while m6t runs, and a reload can land between the grab and the drop. A
  // project the order has not heard of keeps its place instead of vanishing.
  it("keeps a project the order does not mention", () => {
    expect(order(orderProjects(named("a", "b", "c"), ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("skips a name that no longer matches a project", () => {
    expect(order(orderProjects(named("a", "b"), ["ghost", "b", "a"]))).toEqual([
      "b",
      "a",
    ]);
  });

  it("does not mutate the list it was given", () => {
    const before = named("a", "b", "c");
    orderProjects(before, ["c", "b", "a"]);
    expect(order(before)).toEqual(["a", "b", "c"]);
  });
});
