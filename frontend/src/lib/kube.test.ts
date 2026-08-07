import { describe, expect, it } from "vitest";
import { project as models, tools as toolModels } from "../../wailsjs/go/models";
import {
  UNBOUND,
  bindingSummary,
  overrideAt,
  overriddenPaths,
  isBound,
  isUsable,
  scopeOf,
  settingsWithKube,
  toolProblem,
  withKube,
} from "./kube";
import type { Binding, Tool } from "./kube";

function binding(over: Partial<Binding> = {}): Binding {
  return models.Binding.createFrom({ ...UNBOUND, ...over });
}

function tool(over: Partial<Tool> = {}): Tool {
  return toolModels.Tool.createFrom({
    name: "helm",
    path: "/usr/bin/helm",
    version: "v3.14.0",
    found: true,
    problem: "",
    ...over,
  });
}

function project(kube: Record<string, unknown> = {}) {
  return models.Project.createFrom({
    name: "infra",
    path: "/w/infra",
    displayName: "Production",
    color: "amber",
    kube: { context: "", namespace: "", protected: false, scopes: null, ...kube },
    helm: { defaultValues: ["values.yaml"] },
  });
}

// Both halves are required. A context with no namespace still reaches a
// cluster — kubectl falls back to the context's own default — so treating it
// as bound would enable every control against an implicit target.
describe("whether a binding can target a cluster", () => {
  it("needs a context and a namespace", () => {
    expect(isBound(binding({ context: "prod", namespace: "default" }))).toBe(true);
    expect(isBound(binding({ context: "prod" }))).toBe(false);
    expect(isBound(binding({ namespace: "default" }))).toBe(false);
    expect(isBound(UNBOUND)).toBe(false);
  });

  it("says so in one line", () => {
    expect(bindingSummary(binding({ context: "prod-us-west", namespace: "api" }))).toBe(
      "prod-us-west / api",
    );
    expect(bindingSummary(binding({ context: "prod-us-west" }))).toBe("not bound");
    expect(bindingSummary(UNBOUND)).toBe("not bound");
  });
});

// A file inherits from its directory, which is the whole of how a folder
// binding works: `prod/api/deploy.yaml` resolves against `prod/api`.
describe("the folder a selection belongs to", () => {
  it("reduces a file path to its directory", () => {
    expect(scopeOf("prod/api/deployment.yaml")).toBe("prod/api");
    expect(scopeOf("README.md")).toBe("");
    expect(scopeOf("")).toBe("");
  });

  it("reads a Windows path the tree reported", () => {
    expect(scopeOf(String.raw`prod\api\deployment.yaml`)).toBe("prod/api");
  });

  it("ignores a trailing separator", () => {
    expect(scopeOf("prod/api/")).toBe("prod");
  });
});

describe("editing a project's binding", () => {
  // Update replaces the mutable half whole. A rebind that sent only the
  // binding would drop the tab's name — the mirror of the failure the label
  // helper exists to prevent.
  it("carries the label, colour and helm defaults through a rebind", () => {
    const settings = settingsWithKube(
      project(),
      models.Kube.createFrom({ context: "prod", namespace: "default" }),
    );

    expect(settings.displayName).toBe("Production");
    expect(settings.color).toBe("amber");
    expect(settings.helm.defaultValues).toEqual(["values.yaml"]);
    expect(settings.kube.context).toBe("prod");
  });

  it("replaces one field and keeps the rest", () => {
    const next = withKube(project({ context: "prod", namespace: "default" }), {
      namespace: "api",
    });

    expect(next.context).toBe("prod");
    expect(next.namespace).toBe("api");
  });

  // Go marshals an empty slice as null, so a project that has never had a
  // scope arrives with `scopes: null` and the panel still has to be able to
  // write a project default without erasing the overrides it cannot see.
  it("turns an absent scope list into an empty one", () => {
    expect(withKube(project(), {}).scopes).toEqual([]);
  });

  it("carries the existing overrides through a project-default write", () => {
    const bound = project({
      scopes: [{ path: "dev", context: "dev-cluster", namespace: "dev", protected: false }],
    });

    expect(withKube(bound, { context: "prod" }).scopes).toHaveLength(1);
  });
});

describe("the folder overrides a project carries", () => {
  const scoped = () =>
    project({
      scopes: [
        { path: "prod", context: "", namespace: "", protected: true },
        { path: "dev", context: "dev-cluster", namespace: "dev", protected: false },
      ],
    });

  // The override on exactly this folder, not one it inherits: the panel has to
  // be able to say "this folder has no rule of its own" while the binding it
  // resolves to came from a rule further up.
  it("finds the override on exactly one folder", () => {
    expect(overrideAt(scoped(), "dev")?.context).toBe("dev-cluster");
    expect(overrideAt(scoped(), "dev/api")).toBeNull();
    expect(overrideAt(project(), "dev")).toBeNull();
  });

  it("names the folders carrying one, for the tree to mark", () => {
    expect([...overriddenPaths(scoped())].sort()).toEqual(["dev", "prod"]);
    expect(overriddenPaths(project()).size).toBe(0);
    expect(overriddenPaths(null).size).toBe(0);
  });
});

describe("what the UI says about a missing tool", () => {
  it("treats a found tool with no problem as usable", () => {
    expect(isUsable(tool())).toBe(true);
    expect(toolProblem(tool())).toBe("");
  });

  // Found but degraded is still installed: reporting it as absent would
  // disable features the user can in fact use.
  it("keeps a found tool whose probe failed", () => {
    const degraded = tool({ version: "", problem: "unknown flag: --short" });
    expect(isUsable(degraded)).toBe(false);
    expect(toolProblem(degraded)).toBe("unknown flag: --short. Helm features are disabled.");
  });

  it("adds the consequence to the tool's own sentence", () => {
    expect(toolProblem(tool({ name: "kubectl", found: false, problem: "kubectl was not found on PATH" }))).toBe(
      "kubectl was not found on PATH. Every cluster action is disabled.",
    );
  });

  // A tool this build has no consequence written for still reports its own
  // problem rather than an empty line.
  it("falls back to the bare problem for an unknown tool", () => {
    expect(toolProblem(tool({ name: "kustomize", found: false, problem: "not found" }))).toBe(
      "not found",
    );
  });
});
