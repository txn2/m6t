import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kubewatch as models } from "../../wailsjs/go/models";
import type { HealthSnapshot, ObjectStatus } from "../lib/health";
import type { HealthController } from "../lib/useHealth";
import { ClusterHealth } from "./ClusterHealth";

afterEach(cleanup);

/** One declared object, built through the generated model for the reason
 * NO_HEALTH is: a literal cannot supply the conversion helper Wails emits. */
function object(over: Partial<ObjectStatus> = {}): ObjectStatus {
  return models.Status.createFrom({
    apiVersion: "apps/v1",
    kind: "Deployment",
    namespace: "shop",
    name: "web",
    file: "deploy.yaml",
    health: "Current",
    message: "",
    ...over,
  });
}

function snapshot(over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return models.Snapshot.createFrom({
    phase: "watching",
    reason: "",
    objects: [],
    notices: [],
    ...over,
  });
}

function open(
  over: { snapshot?: HealthSnapshot; file?: string | null; error?: string | null } = {},
) {
  const refresh = vi.fn();
  const health: HealthController = {
    snapshot: over.snapshot ?? snapshot(),
    file: over.file === undefined ? "deploy.yaml" : over.file,
    error: over.error ?? null,
    refresh,
  };
  const view = render(<ClusterHealth health={health} />);
  return { ...view, refresh };
}

/** The section's own subtree, so a query cannot pick up the rest of a panel. */
function section() {
  return screen.getByRole("region", { name: "Cluster health" });
}

/** One row, found by the object name it shows. */
function row(name: string): HTMLElement {
  const found = within(section()).getByText(name).closest("li");
  if (found === null) {
    throw new Error(`no row for ${name}`);
  }
  return found;
}

describe("scoping to the open file", () => {
  // The pane is 280px wide and sits under three other sections. A project-wide
  // list is one whose interesting row is off the bottom.
  it("shows only the objects the open file declares", () => {
    open({
      snapshot: snapshot({
        objects: [
          object({ name: "mine", file: "deploy.yaml" }),
          object({ name: "theirs", file: "elsewhere.yaml" }),
        ],
      }),
    });

    expect(within(section()).getByText("mine")).toBeTruthy();
    expect(within(section()).queryByText("theirs")).toBeNull();
  });

  it("names the open file, by its own name rather than its path", () => {
    const { container } = open({
      snapshot: snapshot({ objects: [object({ file: "prod/api/deploy.yaml" })] }),
      file: "prod/api/deploy.yaml",
    });

    const source = container.querySelector(".health__source");
    expect(source?.textContent).toBe("deploy.yaml");
    // The path is not lost — it is on the title, and in the breadcrumb above
    // the editor.
    expect(source?.getAttribute("title")).toBe("prod/api/deploy.yaml");
  });

  it("asks the user to open a manifest when no file is open", () => {
    open({ file: null, snapshot: snapshot({ objects: [object()] }) });

    expect(section().textContent).toContain("Open a manifest to see what it declares.");
    // Not even the connection line: there is nothing for it to be about.
    expect(within(section()).queryByRole("status")).toBeNull();
  });

  it("says so when the open file declares nothing", () => {
    open({ snapshot: snapshot({ objects: [object({ file: "elsewhere.yaml" })] }) });

    expect(section().textContent).toContain("This file declares no Kubernetes objects.");
  });
});

describe("the object rows", () => {
  it("groups them by kind under a heading each", () => {
    open({
      snapshot: snapshot({
        objects: [
          object({ kind: "Deployment", name: "web" }),
          object({ kind: "Deployment", name: "worker" }),
          object({ kind: "Service", name: "api" }),
        ],
      }),
    });

    const kinds = within(section()).getAllByRole("heading", { level: 4 });
    expect(kinds.map((h) => h.textContent)).toEqual(["Deployment", "Service"]);
  });

  // The row is a mark and a name. A verdict on every row would be a second
  // column of text at a width with no room for two.
  it("leaves a healthy object to its mark, with no second line", () => {
    const { container } = open({ snapshot: snapshot({ objects: [object({ health: "Current" })] }) });

    expect(row("web").getAttribute("data-health")).toBe("Current");
    expect(container.querySelector(".health__note")).toBeNull();
  });

  it("gives an unhealthy object a second line saying why", () => {
    open({
      snapshot: snapshot({
        objects: [
          object({ name: "a", health: "NotFound" }),
          object({ name: "b", health: "InProgress", message: "Replicas: 1/3" }),
          object({ name: "c", health: "Failed", message: "back-off pulling image" }),
        ],
      }),
    });

    expect(row("a").textContent).toContain("not in the cluster");
    expect(row("b").textContent).toContain("Replicas: 1/3");
    expect(row("c").textContent).toContain("back-off pulling image");
  });

  // The visual economy above must not be information a screen reader loses.
  it("carries the full verdict on every row, including the quiet ones", () => {
    open({
      snapshot: snapshot({
        objects: [
          object({ name: "a", health: "Current" }),
          object({ name: "b", health: "NotFound" }),
        ],
      }),
    });

    expect(row("a").getAttribute("aria-label")).toBe("Deployment a: Current");
    expect(row("b").getAttribute("aria-label")).toBe("Deployment b: Not in the cluster");
  });

  it("does not repeat the namespace the section above already names", () => {
    const { container } = open({ snapshot: snapshot({ objects: [object()] }) });

    expect(container.querySelector(".health__namespace")).toBeNull();
  });
});

describe("the connection state", () => {
  it("says it is watching, which is what makes the rows a claim about now", () => {
    open({ snapshot: snapshot({ objects: [object()] }) });

    expect(within(section()).getByRole("status").textContent).toContain("watching");
  });

  // The list is kept and marked, not blanked: the last thing anyone knew is
  // worth showing, and must not be shown as though it were current.
  it("keeps the rows and marks them stale while reconnecting", () => {
    const { container } = open({
      snapshot: snapshot({
        phase: "reconnecting",
        reason: "dial tcp 10.0.0.1:443: connect: network is unreachable",
        objects: [object()],
      }),
    });

    expect(within(section()).getByText("web")).toBeTruthy();
    expect(container.querySelector(".health__kinds")?.getAttribute("data-stale")).toBe("true");
    expect(section().textContent).toContain("network is unreachable");
  });

  it("leaves a live list unmarked", () => {
    const { container } = open({ snapshot: snapshot({ objects: [object()] }) });

    expect(container.querySelector(".health__kinds")?.getAttribute("data-stale")).toBeNull();
  });

  // A refusal reads differently from an outage: it sends the user to their
  // login rather than to their network.
  it("names a refusal as its own state and shows the cluster's words", () => {
    open({
      snapshot: snapshot({ phase: "unauthorized", reason: "Unauthorized: token expired" }),
    });

    expect(within(section()).getByRole("status").textContent).toContain(
      "cluster refused this user",
    );
    expect(section().textContent).toContain("token expired");
  });

  it("offers no retry while everything is well", () => {
    open({ snapshot: snapshot({ objects: [object()] }) });

    expect(within(section()).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry when the connection is failing", () => {
    const { refresh } = open({ snapshot: snapshot({ phase: "reconnecting" }) });

    fireEvent.click(within(section()).getByRole("button", { name: "Try again" }));

    expect(refresh).toHaveBeenCalled();
  });

  it("reports a failure of the bridge itself beside the phase", () => {
    open({ snapshot: snapshot({ phase: "idle" }), error: "the backend is not reachable" });

    expect(section().textContent).toContain("the backend is not reachable");
    expect(within(section()).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("gives an idle session the backend's own reason", () => {
    open({
      snapshot: snapshot({ phase: "idle", reason: "no kube context and namespace are bound" }),
    });

    expect(within(section()).getByRole("status").textContent).toContain(
      "no kube context and namespace are bound",
    );
    expect(section().textContent).toContain("Nothing to watch here.");
  });
});

describe("the indexer's notices", () => {
  // A document in this file that would not parse is the reason an object the
  // user expected is not in the list above. The two belong on screen together.
  it("shows what could not be indexed in this file", () => {
    open({
      snapshot: snapshot({
        objects: [object()],
        notices: [
          models.Notice.createFrom({ file: "deploy.yaml", reason: "yaml: line 4: found a tab" }),
          models.Notice.createFrom({ file: "elsewhere.yaml", reason: "not this file's problem" }),
        ],
      }),
    });

    expect(section().textContent).toContain("yaml: line 4: found a tab");
    expect(section().textContent).not.toContain("not this file's problem");
  });

  // "Declares no objects" over the top of "this file would not parse" would be
  // the panel contradicting itself.
  it("does not claim a file declares nothing when it could not be read", () => {
    open({
      snapshot: snapshot({
        notices: [
          models.Notice.createFrom({ file: "deploy.yaml", reason: "yaml: line 4: found a tab" }),
        ],
      }),
    });

    expect(section().textContent).toContain("Nothing could be indexed in this file.");
    expect(section().textContent).not.toContain("declares no Kubernetes objects");
  });

  it("shows no notices when there is nothing to say", () => {
    const { container } = open({ snapshot: snapshot({ objects: [object()] }) });

    expect(container.querySelector(".health__notice")).toBeNull();
  });
});
