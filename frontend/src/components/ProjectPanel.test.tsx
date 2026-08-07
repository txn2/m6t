import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  kubeconfig as kubeModels,
  kubeexec as execModels,
  project as models,
  tools as toolModels,
} from "../../wailsjs/go/models";
import { ProjectPanel } from "./ProjectPanel";
import { UNBOUND } from "../lib/kube";
import type { Binding, CheckResult, Kube, Tool } from "../lib/kube";
import type { Project } from "../lib/projects";
import type { KubeController } from "../lib/useKube";

afterEach(cleanup);

function binding(over: Partial<Binding> = {}): Binding {
  return models.Binding.createFrom({ ...UNBOUND, ...over });
}

function project(kube: Record<string, unknown> = {}): Project {
  return models.Project.createFrom({
    name: "infra",
    path: "/w/infra",
    displayName: "",
    color: "",
    kube: { context: "", namespace: "", protected: false, scopes: null, ...kube },
    helm: { defaultValues: [] },
  });
}

const CONTEXTS = [
  kubeModels.Context.createFrom({ name: "dev-cluster", namespace: "dev", current: true }),
  kubeModels.Context.createFrom({ name: "prod-us-west", namespace: "", current: false }),
];

function controller(over: Partial<KubeController> = {}): KubeController {
  return {
    binding: UNBOUND,
    contexts: CONTEXTS,
    sources: ["/home/u/.kube/config"],
    tools: [],
    result: null,
    error: null,
    checking: false,
    check: vi.fn(),
    refresh: vi.fn(),
    ...over,
  };
}

function seam(over: Partial<Kube> = {}): Kube {
  return {
    contexts: () => Promise.resolve(kubeModels.Config.createFrom({ contexts: [], sources: [] })),
    binding: () => Promise.resolve(UNBOUND),
    namespaces: () => Promise.resolve(["default", "kube-system", "platform", "dev"]),
    check: () => Promise.reject(new Error("not used here")),
    bindFolder: () => Promise.reject(new Error("not used here")),
    unbindFolder: () => Promise.reject(new Error("not used here")),
    tools: () => Promise.resolve([]),
    ...over,
  };
}

function open(over: {
  project?: Project;
  kube?: Partial<KubeController>;
  seam?: Partial<Kube>;
  scope?: string;
  onDefault?: Write;
  onOverride?: Write;
} = {}) {
  const onDefault: Write = over.onDefault ?? vi.fn(() => Promise.resolve());
  const onOverride: Write = over.onOverride ?? vi.fn(() => Promise.resolve());
  const view = render(
    <ProjectPanel
      project={over.project ?? project()}
      kube={controller(over.kube)}
      seam={seam(over.seam)}
      scope={over.scope ?? ""}
      onDefault={onDefault}
      onOverride={onOverride}
    />,
  );
  return { ...view, onDefault, onOverride };
}

type Write = Mock<(context: string, namespace: string, guarded: boolean) => Promise<void>>;

const kubeSection = () => screen.getByLabelText("Kubernetes");

describe("the panel's identity", () => {
  it("says what it is", () => {
    open();

    expect(screen.getByRole("heading", { name: "Project" })).toBeDefined();
  });

  // A panel that opens with a cluster name and never says which project it
  // belongs to reads the same for every tab.
  it("names the project and where its checkout lives", () => {
    const attributes = () => {
      open({
        project: models.Project.createFrom({
          name: "k8s",
          path: "/Users/u/workspace/ops/k8s",
          shortPath: "~/workspace/ops/k8s",
          displayName: "Production infra",
          color: "",
          kube: { context: "", namespace: "", protected: false, scopes: null },
          helm: { defaultValues: [] },
        }),
      });
      return screen.getByLabelText("Project attributes");
    };

    const section = attributes();
    expect(within(section).getByText("Production infra")).toBeDefined();
    expect(within(section).getByText("~/workspace/ops/k8s")).toBeDefined();
  });

  // The label, not the registry key: the key is a directory basename the user
  // never chose (#41).
  it("falls back to the registry name when there is no label", () => {
    open();

    expect(within(screen.getByLabelText("Project attributes")).getByText("infra")).toBeDefined();
  });
});

describe("the selection", () => {
  const selection = () => screen.getByLabelText("Selection");

  it("names the folder the selection sits in", () => {
    open({ scope: "prod/api" });

    expect(within(selection()).getByText("prod/api")).toBeDefined();
  });

  // The root's binding IS the project default, so a second pair of controls
  // here would be two ways to write one value.
  it("edits nothing at the project root and says where the controls are", () => {
    open({ scope: "" });

    expect(within(selection()).getByText("project root")).toBeDefined();
    expect(within(selection()).queryByLabelText("selection context")).toBeNull();
    expect(within(selection()).getByText(/takes the default above/)).toBeDefined();
  });

  // The fields show the resolved target, because the question the section
  // answers is "where does this go", not "what did I put here".
  it("shows the resolved target rather than the folder's own override", () => {
    open({
      scope: "prod/api",
      project: project({
        context: "prod-us-west",
        namespace: "default",
        scopes: [{ path: "prod/api", context: "", namespace: "api", protected: false }],
      }),
      kube: {
        binding: binding({
          context: "prod-us-west",
          namespace: "api",
          scope: "prod/api",
        }),
      },
    });

    expect(
      (within(selection()).getByLabelText("selection context") as HTMLSelectElement).value,
    ).toBe("prod-us-west");
    expect(
      (within(selection()).getByLabelText("selection namespace") as HTMLSelectElement).value,
    ).toBe("api");
  });

  it("writes an override when the context is changed", async () => {
    const { onOverride } = open({
      scope: "prod/api",
      project: project({ context: "prod-us-west", namespace: "default" }),
      kube: { binding: binding({ context: "prod-us-west", namespace: "default" }) },
    });

    fireEvent.change(within(selection()).getByLabelText("selection context"), {
      target: { value: "dev-cluster" },
    });

    await waitFor(() => {
      expect(onOverride).toHaveBeenCalledWith("dev-cluster", "", false);
    });
  });

  // Changing one field leaves the other's own value alone, so a namespace set
  // on a folder that inherits its context keeps the context inheriting.
  it("keeps the other field inheriting when only one is changed", async () => {
    const { onOverride } = open({
      scope: "prod/api",
      project: project({ context: "prod-us-west", namespace: "default" }),
      kube: { binding: binding({ context: "prod-us-west", namespace: "default" }) },
    });

    await within(selection()).findByRole("option", { name: "platform" });
    fireEvent.change(within(selection()).getByLabelText("selection namespace"), {
      target: { value: "platform" },
    });

    await waitFor(() => {
      expect(onOverride).toHaveBeenCalledWith("", "platform", false);
    });
  });

  it("keeps an existing override's other half when one field changes", async () => {
    const { onOverride } = open({
      scope: "prod/api",
      project: project({
        context: "prod-us-west",
        namespace: "default",
        scopes: [{ path: "prod/api", context: "dev-cluster", namespace: "api", protected: true }],
      }),
      kube: {
        binding: binding({ context: "dev-cluster", namespace: "api", protected: true, scope: "prod/api" }),
      },
    });

    fireEvent.change(within(selection()).getByLabelText("selection context"), {
      target: { value: "prod-us-west" },
    });

    await waitFor(() => {
      expect(onOverride).toHaveBeenCalledWith("prod-us-west", "api", true);
    });
  });

  // The mark is the whole safety argument for editing here: a control that
  // quietly sent one directory to a different cluster from the rest of the
  // project would be the most dangerous thing in the window.
  it("marks a field pointing somewhere other than the project default", () => {
    const { container } = open({
      scope: "dev",
      project: project({ context: "prod-us-west", namespace: "default" }),
      kube: { binding: binding({ context: "dev-cluster", namespace: "default", scope: "dev" }) },
    });

    const fields = [...container.querySelectorAll(".panel__field")];
    expect(fields.map((f) => f.getAttribute("data-diverged"))).toEqual(["true", null]);
  });

  it("marks neither field while the folder goes where the project does", () => {
    const { container } = open({
      scope: "dev",
      project: project({ context: "prod-us-west", namespace: "default" }),
      kube: { binding: binding({ context: "prod-us-west", namespace: "default" }) },
    });

    expect(
      [...container.querySelectorAll(".panel__field")].map((f) => f.getAttribute("data-diverged")),
    ).toEqual([null, null]);
  });

  it("says which rule decided it", () => {
    open({
      scope: "prod/api",
      kube: {
        binding: binding({ context: "prod-us-west", namespace: "api", scope: "prod/api" }),
      },
    });

    expect(within(selection()).getByText("the prod/api override")).toBeDefined();
  });

  // A project laid out as per-folder bindings with no default at all is a
  // normal project. Crediting "the project default" for a folder nothing binds
  // is technically where it fell through to and tells the user nothing.
  it("says nothing binds the folder rather than crediting an empty default", () => {
    open({ scope: "fuse/30-cs-corp/090-nifi" });

    expect(within(selection()).getByText("no rule covers this folder")).toBeDefined();
    expect(within(selection()).queryByText("the project default")).toBeNull();
  });

  it("marks a protected binding", () => {
    const { container } = open({
      scope: "prod",
      kube: { binding: binding({ context: "prod", namespace: "api", protected: true }) },
    });

    expect(container.querySelector('[data-protected="true"]')).not.toBeNull();
    expect(within(selection()).getByText(/asks for the context name/)).toBeDefined();
  });

  it("shows the registry's refusal without changing what is on screen", async () => {
    open({
      scope: "prod/api",
      project: project({ context: "prod-us-west", namespace: "default" }),
      kube: { binding: binding({ context: "prod-us-west", namespace: "default" }) },
      onOverride: vi.fn(() => Promise.reject(new Error("binding prod/api in infra: refused"))),
    });

    fireEvent.change(within(selection()).getByLabelText("selection context"), {
      target: { value: "dev-cluster" },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("refused");
    expect(
      (within(selection()).getByLabelText("selection context") as HTMLSelectElement).value,
    ).toBe("prod-us-west");
  });
});

describe("the Kubernetes section", () => {
  it("offers the contexts the kubeconfig holds", () => {
    open();
    const select = within(kubeSection()).getByLabelText("project context") as HTMLSelectElement;

    expect([...select.options].map((o) => o.value)).toEqual([
      "",
      "dev-cluster",
      "prod-us-west",
    ]);
  });

  // Binding stays something the user does on purpose (DESIGN.md §4).
  it("labels kubectl's current context without selecting it", () => {
    open();
    const select = within(kubeSection()).getByLabelText("project context") as HTMLSelectElement;

    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: /dev-cluster \(kubectl's current\)/ })).toBeDefined();
  });

  // No save button: every control writes the moment it changes.
  it("offers nothing to press", () => {
    open();

    expect(within(kubeSection()).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("writes the context as soon as it is chosen", async () => {
    const { onDefault } = open();

    fireEvent.change(within(kubeSection()).getByLabelText("project context"), {
      target: { value: "prod-us-west" },
    });

    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("prod-us-west", "", false);
    });
  });

  it("writes the namespace as soon as it is chosen", async () => {
    const { onDefault } = open({ project: project({ context: "prod-us-west" }) });

    // Awaited: the namespace options are the cluster's, so there is nothing to
    // pick until the listing lands.
    await screen.findByRole("option", { name: "platform" });
    fireEvent.change(within(kubeSection()).getByLabelText("project namespace"), {
      target: { value: "platform" },
    });

    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("prod-us-west", "platform", false);
    });
  });

  it("writes the protected toggle as soon as it moves", async () => {
    const { onDefault } = open({ project: project({ context: "prod", namespace: "default" }) });

    fireEvent.click(within(kubeSection()).getByRole("checkbox"));

    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("prod", "default", true);
    });
  });

  // The field is driven by what is stored, so a refused write leaves it showing
  // the value that is actually in force rather than the one that was picked.
  it("keeps showing the stored value when a write is refused", async () => {
    open({
      project: project({ context: "prod-us-west", namespace: "default" }),
      onDefault: vi.fn(() => Promise.reject(new Error("updating infra: no such project"))),
    });

    fireEvent.change(within(kubeSection()).getByLabelText("project context"), {
      target: { value: "dev-cluster" },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("no such project");
    expect(
      (within(kubeSection()).getByLabelText("project context") as HTMLSelectElement).value,
    ).toBe("prod-us-west");
  });

  it("takes the chosen context's own default namespace when there is none", async () => {
    const { onDefault } = open();

    fireEvent.change(within(kubeSection()).getByLabelText("project context"), {
      target: { value: "dev-cluster" },
    });

    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("dev-cluster", "dev", false);
    });
  });

  // Overwriting a namespace already set would undo the user's work every time
  // they corrected the context above it.
  it("leaves a namespace that is already set alone", async () => {
    const { onDefault } = open({ project: project({ namespace: "platform" }) });

    fireEvent.change(within(kubeSection()).getByLabelText("project context"), {
      target: { value: "dev-cluster" },
    });

    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("dev-cluster", "platform", false);
    });
  });

  // The namespaces the bound cluster actually has, not a name the user has to
  // remember.
  it("lists the namespaces the context's cluster has", async () => {
    open({ project: project({ context: "prod-us-west" }) });

    await waitFor(() => {
      const list = screen.getByTestId("namespaces-project namespace");
      expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
        "",
        "default",
        "kube-system",
        "platform",
        "dev",
      ]);
    });
  });

  // A select whose value is not among its options renders blank and reports ""
  // on the next change, which would turn "the cluster did not list it" into
  // "this project has no namespace" on a binding that was correct.
  it("keeps a stored namespace the cluster did not list", async () => {
    open({ project: project({ context: "prod-us-west", namespace: "legacy" }) });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "legacy" })).toBeDefined();
    });
    expect(
      (within(kubeSection()).getByLabelText("project namespace") as HTMLSelectElement).value,
    ).toBe("legacy");
  });

  // Listing namespaces is a distinct permission from using one. A dropdown
  // that came back empty would lock a user out of a namespace they can deploy
  // to, so a failed listing falls back to a field carrying kubectl's reason.
  it("falls back to a typed namespace when the cluster will not list them", async () => {
    const { onDefault } = open({
      project: project({ context: "prod-us-west" }),
      seam: {
        namespaces: () =>
          Promise.reject(new Error("listing namespaces in prod-us-west: forbidden")),
      },
    });

    // The reason arriving is what swaps the select for the field, so the note
    // is what says the fallback is on screen.
    await screen.findByText(/forbidden/);
    fireEvent.change(within(kubeSection()).getByLabelText("project namespace"), {
      target: { value: "typed-by-hand" },
    });

    // The write is the assertion, not the field: every control here is driven
    // by what is stored, so what a typed namespace produces is a call.
    await waitFor(() => {
      expect(onDefault).toHaveBeenCalledWith("prod-us-west", "typed-by-hand", false);
    });
  });

  it("names where it looked when there are no contexts", () => {
    open({ kube: { contexts: [] } });

    expect(screen.getByText(/No contexts found in \/home\/u\/\.kube\/config/)).toBeDefined();
  });
});

describe("the connection check", () => {
  const bound = binding({ context: "prod-us-west", namespace: "api" });

  // Nothing to check until there is a target.
  it("is absent while the selection is unbound", () => {
    open();

    expect(screen.queryByRole("button", { name: "Check connection" })).toBeNull();
  });

  it("runs on demand", () => {
    const check = vi.fn();
    open({ kube: { binding: bound, check } });

    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));

    expect(check).toHaveBeenCalled();
  });

  it("reports a cluster that answered", () => {
    open({ kube: { binding: bound, result: result() } });

    expect(screen.getByText("The cluster answered.")).toBeDefined();
  });

  // kubectl's own message, verbatim (CLAUDE.md).
  it("shows kubectl's stderr on a failure rather than a summary", () => {
    open({
      kube: {
        binding: bound,
        result: result({ exitCode: 1, stderr: "error: You must be logged in to the server" }),
      },
    });

    expect(screen.getByText("kubectl exited 1")).toBeDefined();
    expect(screen.getByText("error: You must be logged in to the server")).toBeDefined();
  });

  // DESIGN.md §1: everything m6t does is something the user could have typed.
  it("shows the command it ran", () => {
    open({ kube: { binding: bound, result: result() } });

    expect(
      screen.getByText("kubectl --context=prod-us-west --namespace=api version -o json"),
    ).toBeDefined();
  });
});

describe("tool availability", () => {
  it("stays out of the way when every tool is usable", () => {
    open({ kube: { tools: [tool({ found: true, version: "v3.14.0", problem: "" })] } });

    expect(screen.queryByLabelText("Tool availability")).toBeNull();
  });

  it("names what stops working when a tool is missing", () => {
    open({ kube: { tools: [tool()] } });

    expect(
      screen.getByText("helm was not found on PATH. Helm features are disabled."),
    ).toBeDefined();
  });

  it("re-reads the tool list on demand", () => {
    const refresh = vi.fn();
    open({ kube: { tools: [tool()], refresh } });

    fireEvent.click(screen.getByRole("button", { name: "Look again" }));

    expect(refresh).toHaveBeenCalled();
  });
});

function result(over: Partial<CheckResult> = {}): CheckResult {
  return execModels.Result.createFrom({
    argv: ["kubectl", "--context=prod-us-west", "--namespace=api", "version", "-o", "json"],
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    ...over,
  });
}

function tool(over: Partial<Tool> = {}): Tool {
  return toolModels.Tool.createFrom({
    name: "helm",
    path: "",
    version: "",
    found: false,
    problem: "helm was not found on PATH",
    ...over,
  });
}
