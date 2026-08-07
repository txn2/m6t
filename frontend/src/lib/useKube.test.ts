import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  kubeconfig as kubeModels,
  kubeexec as execModels,
  project as models,
  tools as toolModels,
} from "../../wailsjs/go/models";
import { UNBOUND } from "./kube";
import type { Binding, Kube } from "./kube";
import { useKube } from "./useKube";

/** The dev/prod layout scopes exist for, as the backend would resolve it. */
const RESOLVED: Record<string, Partial<Binding>> = {
  "": { context: "prod-us-west", namespace: "default" },
  dev: { context: "dev-cluster", namespace: "dev", scope: "dev" },
  "prod/api": {
    context: "prod-us-west",
    namespace: "api",
    protected: true,
    scope: "prod/api",
  },
};

function stubKube(over: Partial<Kube> = {}): Kube {
  return {
    binding: (_name, rel) =>
      Promise.resolve(models.Binding.createFrom({ ...UNBOUND, ...(RESOLVED[rel] ?? {}) })),
    contexts: () =>
      Promise.resolve(
        kubeModels.Config.createFrom({
          contexts: [kubeModels.Context.createFrom({ name: "dev-cluster" })],
          sources: ["/home/u/.kube/config"],
        }),
      ),
    namespaces: () => Promise.resolve(["default", "kube-system"]),
    check: () =>
      Promise.resolve(execModels.Result.createFrom({ argv: ["kubectl"], exitCode: 0 })),
    bindFolder: () => Promise.reject(new Error("not used here")),
    unbindFolder: () => Promise.reject(new Error("not used here")),
    tools: () =>
      Promise.resolve([toolModels.Tool.createFrom({ name: "helm", found: true })]),
    // The pipeline (#11) is not this file's subject; a test that needs it
    // overrides these. Rejecting rather than resolving keeps an accidental
    // reliance on them visible.
    validate: () => Promise.reject(new Error("not used here")),
    diff: () => Promise.reject(new Error("not used here")),
    apply: () => Promise.reject(new Error("not used here")),
    deletePreview: () => Promise.reject(new Error("not used here")),
    remove: () => Promise.reject(new Error("not used here")),
    ...over,
  };
}

function hook(rel: string, kube = stubKube(), project: string | null = "infra") {
  return renderHook(({ r }: { r: string }) => useKube({ project, rel: r }, kube), {
    initialProps: { r: rel },
  });
}

describe("resolving the selection's binding", () => {
  it("asks the backend rather than working it out", async () => {
    const kube = stubKube();
    const spy = vi.spyOn(kube, "binding");
    const { result } = hook("prod/api", kube);

    await waitFor(() => {
      expect(result.current.binding.namespace).toBe("api");
    });
    expect(spy).toHaveBeenCalledWith("infra", "prod/api");
    expect(result.current.binding.scope).toBe("prod/api");
    expect(result.current.binding.protected).toBe(true);
  });

  // The whole point of a folder binding: moving between two directories in one
  // project changes the cluster the panel names.
  it("follows the selection from one folder to another", async () => {
    const { result, rerender } = hook("dev");

    await waitFor(() => {
      expect(result.current.binding.context).toBe("dev-cluster");
    });

    rerender({ r: "prod/api" });

    await waitFor(() => {
      expect(result.current.binding.context).toBe("prod-us-west");
    });
    expect(result.current.binding.namespace).toBe("api");
  });

  // Showing a stale binding while the current one cannot be read would name a
  // cluster the apply button no longer targets — the worst thing this can do.
  it("falls back to unbound when the binding cannot be read", async () => {
    const kube = stubKube({ binding: () => Promise.reject(new Error("registry unreadable")) });
    const { result } = hook("dev", kube);

    await waitFor(() => {
      expect(result.current.binding).toEqual(UNBOUND);
    });
  });

  it("stays unbound with no project selected", async () => {
    const kube = stubKube();
    const spy = vi.spyOn(kube, "binding");
    const { result } = hook("", kube, null);

    await waitFor(() => {
      expect(result.current.contexts).toHaveLength(1);
    });
    expect(result.current.binding).toEqual(UNBOUND);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the smoke check", () => {
  it("aims at the current selection", async () => {
    const kube = stubKube();
    const spy = vi.spyOn(kube, "check");
    const { result } = hook("prod/api", kube);

    await waitFor(() => {
      expect(result.current.binding.namespace).toBe("api");
    });
    act(() => {
      result.current.check();
    });

    await waitFor(() => {
      expect(result.current.result?.exitCode).toBe(0);
    });
    expect(spy).toHaveBeenCalledWith("infra", "prod/api");
  });

  it("reports a refusal that never reached kubectl", async () => {
    const kube = stubKube({
      check: () => Promise.reject(new Error("no kube context and namespace are bound")),
    });
    const { result } = hook("", kube);

    act(() => {
      result.current.check();
    });

    await waitFor(() => {
      expect(result.current.error).toBe("no kube context and namespace are bound");
    });
    expect(result.current.result).toBeNull();
  });

  // A verdict about the previous folder sitting above a new folder's name is
  // the panel claiming a cluster answered when it was asked about another one.
  it("drops a verdict when the selection moves", async () => {
    const { result, rerender } = hook("dev");

    act(() => {
      result.current.check();
    });
    await waitFor(() => {
      expect(result.current.result).not.toBeNull();
    });

    rerender({ r: "prod/api" });

    await waitFor(() => {
      expect(result.current.result).toBeNull();
    });
  });

  it("does nothing with no project selected", () => {
    const kube = stubKube();
    const spy = vi.spyOn(kube, "check");
    const { result } = hook("", kube, null);

    act(() => {
      result.current.check();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the kubeconfig and the tool list", () => {
  it("reads both at mount", async () => {
    const { result } = hook("");

    await waitFor(() => {
      expect(result.current.contexts.map((c) => c.name)).toEqual(["dev-cluster"]);
    });
    expect(result.current.sources).toEqual(["/home/u/.kube/config"]);
    expect(result.current.tools.map((t) => t.name)).toEqual(["helm"]);
  });

  // A broken kubeconfig is reported; a tool probe that fell over is not
  // allowed to take the context list down with it, and vice versa.
  it("keeps the tool list when the kubeconfig will not parse", async () => {
    const kube = stubKube({ contexts: () => Promise.reject(new Error("line 3: bad yaml")) });
    const { result } = hook("", kube);

    await waitFor(() => {
      expect(result.current.error).toBe("line 3: bad yaml");
    });
    expect(result.current.contexts).toEqual([]);
    expect(result.current.tools).toHaveLength(1);
  });

  it("re-reads everything on demand", async () => {
    const kube = stubKube();
    const spy = vi.spyOn(kube, "tools");
    const { result } = hook("", kube);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
