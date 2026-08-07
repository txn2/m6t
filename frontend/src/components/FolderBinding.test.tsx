import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kubeconfig as kubeModels, project as models } from "../../wailsjs/go/models";
import { FolderBinding } from "./FolderBinding";
import { UNBOUND } from "../lib/kube";
import type { Kube, KubeContext, Scope } from "../lib/kube";

afterEach(cleanup);

const CONTEXTS: KubeContext[] = [
  kubeModels.Context.createFrom({ name: "dev-cluster", namespace: "dev", current: false }),
  kubeModels.Context.createFrom({ name: "prod-us-west", namespace: "", current: true }),
];

function scope(over: Partial<Scope> = {}): Scope {
  return models.Scope.createFrom({
    path: "dev",
    context: "dev-cluster",
    namespace: "dev",
    protected: false,
    ...over,
  });
}

function seam(over: Partial<Kube> = {}): Kube {
  return {
    contexts: () => Promise.resolve(kubeModels.Config.createFrom({ contexts: [], sources: [] })),
    binding: () => Promise.resolve(UNBOUND),
    namespaces: () => Promise.resolve(["default", "api"]),
    check: () => Promise.reject(new Error("not used here")),
    bindFolder: () => Promise.reject(new Error("not used here")),
    unbindFolder: () => Promise.reject(new Error("not used here")),
    tools: () => Promise.resolve([]),
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

type SaveSpy = Mock<(context: string, namespace: string, guarded: boolean) => Promise<void>>;
type RemoveSpy = Mock<() => Promise<void>>;

function open(over: {
  path?: string;
  existing?: Scope | null;
  inherited?: string;
  inheritedContext?: string;
  seam?: Partial<Kube>;
  onSave?: SaveSpy;
  onRemove?: RemoveSpy;
  onClose?: () => void;
} = {}) {
  const onSave: SaveSpy = over.onSave ?? vi.fn(() => Promise.resolve());
  const onRemove: RemoveSpy = over.onRemove ?? vi.fn(() => Promise.resolve());
  const onClose = over.onClose ?? vi.fn();
  render(
    <FolderBinding
      path={over.path ?? "dev"}
      existing={over.existing ?? null}
      inherited={over.inherited ?? "prod-us-west / default"}
      inheritedContext={over.inheritedContext ?? ""}
      contexts={CONTEXTS}
      kube={seam(over.seam)}
      onSave={onSave}
      onRemove={onRemove}
      onClose={onClose}
    />,
  );
  return { onSave, onRemove, onClose };
}

const save = () => {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
};

describe("a folder with no override yet", () => {
  it("names the folder and what it inherits today", () => {
    open({ path: "prod/api", inherited: "prod-us-west / default" });

    expect(screen.getByRole("dialog", { name: "Kubernetes binding for prod/api" })).toBeDefined();
    expect(screen.getByText("prod-us-west / default")).toBeDefined();
  });

  // Both fields default to inheriting, which is what makes the commonest case
  // one field: environments on one cluster differing only in namespace.
  it("starts both fields inheriting", () => {
    open();

    expect((screen.getByLabelText("context") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("namespace") as HTMLInputElement).value).toBe("");
  });

  it("writes a full override", async () => {
    const { onSave } = open({ seam: { namespaces: () => Promise.resolve(["default", "dev"]) } });

    fireEvent.change(screen.getByLabelText("context"), { target: { value: "dev-cluster" } });
    // Awaited: the namespace options are the cluster's, so there is nothing to
    // pick until the listing lands.
    await screen.findByRole("option", { name: "dev" });
    fireEvent.change(screen.getByLabelText("namespace"), { target: { value: "dev" } });
    save();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("dev-cluster", "dev", false);
    });
  });

  // The case the whole mechanism exists for: environments on one cluster,
  // separated only by namespace. The context stays inherited, so the namespaces
  // on offer are the ones the folder already resolves to.
  it("writes a namespace-only override, leaving the context inherited", async () => {
    const { onSave } = open({ inheritedContext: "prod-us-west" });

    await screen.findByRole("option", { name: "api" });
    fireEvent.change(screen.getByLabelText("namespace"), { target: { value: "api" } });
    save();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("", "api", false);
    });
  });

  it("turns protection on for the folder", async () => {
    const { onSave } = open();

    fireEvent.click(screen.getByRole("checkbox"));
    save();

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("", "", true);
    });
  });

  // Nothing to remove, so the action is absent rather than present and inert.
  it("offers no removal", () => {
    open();

    expect(screen.queryByRole("button", { name: "Remove override" })).toBeNull();
  });
});

describe("a folder that already has one", () => {
  it("opens on what is stored", () => {
    open({ existing: scope({ protected: true }), inheritedContext: "dev-cluster" });

    expect((screen.getByLabelText("context") as HTMLSelectElement).value).toBe("dev-cluster");
    expect((screen.getByLabelText("namespace") as HTMLInputElement).value).toBe("dev");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("removes it on demand", async () => {
    const { onRemove, onClose } = open({ existing: scope() });

    fireEvent.click(screen.getByRole("button", { name: "Remove override" }));

    await waitFor(() => {
      expect(onRemove).toHaveBeenCalled();
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the namespace field", () => {
  it("lists the namespaces the chosen context's cluster has", async () => {
    const namespaces = vi.fn((context: string) =>
      Promise.resolve(context === "dev-cluster" ? ["default", "api"] : []),
    );
    open({ seam: { namespaces } });

    fireEvent.change(screen.getByLabelText("context"), { target: { value: "dev-cluster" } });

    await waitFor(() => {
      const list = screen.getByTestId("namespaces-namespace");
      expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
        "",
        "default",
        "api",
      ]);
    });
    expect(namespaces).toHaveBeenCalledWith("dev-cluster");
  });

  // A folder inheriting its context still has a cluster: the one it resolves
  // to. Listing nothing there would make the commonest override — namespace
  // only — the one case with no dropdown.
  it("lists the inherited context's namespaces while the context is inherited", async () => {
    const namespaces = vi.fn(() => Promise.resolve(["default", "api"]));
    open({ inheritedContext: "prod-us-west", seam: { namespaces } });

    await waitFor(() => {
      expect(namespaces).toHaveBeenCalledWith("prod-us-west");
    });
    expect(screen.getByRole("option", { name: "api" })).toBeDefined();
  });

  // A select whose value is not among its options renders blank and reports ""
  // on the next change, which would silently drop a stored namespace.
  it("keeps a stored namespace the cluster did not list", async () => {
    open({
      existing: scope({ namespace: "legacy" }),
      inheritedContext: "dev-cluster",
      seam: { namespaces: () => Promise.resolve(["default"]) },
    });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "legacy" })).toBeDefined();
    });
    expect((screen.getByLabelText("namespace") as HTMLSelectElement).value).toBe("legacy");
  });

  // Listing namespaces is a distinct permission from using one, so a refused
  // listing leaves a field rather than an empty dropdown.
  it("falls back to a typed namespace when the cluster refuses", async () => {
    open({
      inheritedContext: "dev-cluster",
      seam: { namespaces: () => Promise.reject(new Error("namespaces is forbidden")) },
    });

    await screen.findByText(/forbidden/);
    const field = screen.getByLabelText("namespace");
    fireEvent.change(field, { target: { value: "typed-by-hand" } });

    expect((field as HTMLInputElement).value).toBe("typed-by-hand");
  });
});

describe("a refused write", () => {
  it("shows the registry's own message and keeps the dialog open", async () => {
    const onSave: SaveSpy = vi.fn(() =>
      Promise.reject(
        new Error("binding dev in infra: a scope path must be a relative path inside the repository"),
      ),
    );
    const onClose = vi.fn();
    open({ onSave, onClose });

    save();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "a scope path must be a relative path inside the repository",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes once the write lands", async () => {
    const { onClose } = open();

    save();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe("dismissing the dialog", () => {
  it("closes on Escape", () => {
    const { onClose } = open();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  // The backdrop is found by class rather than by role: the Kubernetes mark in
  // the title is a decorative img, which is also role="presentation".
  it("closes on a click outside the form but not inside it", () => {
    const { onClose } = open();
    const dialog = screen.getByRole("dialog");

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
