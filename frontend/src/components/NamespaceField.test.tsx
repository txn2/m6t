import { describe, expect, it } from "vitest";
import { namespaceSource, options } from "./NamespaceField";

describe("which cluster a namespace list comes from", () => {
  it("uses the chosen context when there is one", () => {
    expect(namespaceSource("dev-cluster", "prod-us-west")).toBe("dev-cluster");
  });

  // A namespace-only override leaves the context field empty on purpose. It is
  // the commonest override there is, and it still has a cluster: the one the
  // folder already resolves to.
  it("falls back to the inherited context while nothing is chosen", () => {
    expect(namespaceSource("", "prod-us-west")).toBe("prod-us-west");
  });

  it("has nothing to list when neither is set", () => {
    expect(namespaceSource("", "")).toBe("");
  });
});

describe("the namespaces a picker offers", () => {
  it("offers what the cluster listed", () => {
    expect(options(["default", "kube-system"], "default")).toEqual([
      "default",
      "kube-system",
    ]);
  });

  // A select whose value is not among its options renders blank and reports ""
  // on the next change, which would turn "the cluster did not list it" into
  // "this project has no namespace" on a binding that was correct.
  it("keeps a bound namespace the listing did not include", () => {
    expect(options(["default"], "legacy")).toEqual(["legacy", "default"]);
  });

  it("adds nothing for an unset namespace", () => {
    expect(options(["default"], "")).toEqual(["default"]);
  });

  it("survives a listing that has not arrived", () => {
    expect(options([], "legacy")).toEqual(["legacy"]);
    expect(options([], "")).toEqual([]);
  });
});
