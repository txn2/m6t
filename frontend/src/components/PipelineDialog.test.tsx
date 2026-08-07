import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Binding, CheckResult } from "../lib/kube";
import { UNBOUND } from "../lib/kube";
import type { PipelineRun, PipelineTarget } from "../lib/usePipeline";
import { PipelineDialog } from "./PipelineDialog";

afterEach(cleanup);

const result = (over: Partial<CheckResult> = {}): CheckResult =>
  ({ argv: ["kubectl", "apply"], exitCode: 0, stdout: "", stderr: "", ...over }) as CheckResult;

const bound: Binding = {
  ...UNBOUND,
  context: "prod-us-west",
  namespace: "platform",
  scope: "prod",
};

const target: PipelineTarget = {
  project: "infra",
  path: "prod/api/deploy.yaml",
  action: "apply",
};

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    target,
    phase: "ready",
    binding: bound,
    preview: result({ stdout: "deployment.apps/api configured (server dry run)\n" }),
    diff: result({ exitCode: 1, stdout: "-  replicas: 2\n+  replicas: 3\n" }),
    outcome: null,
    error: null,
    ...over,
  };
}

function open(over: Partial<PipelineRun> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<PipelineDialog run={run(over)} onConfirm={onConfirm} onClose={onClose} />);
  return { onConfirm, onClose };
}

/** The button that reaches the cluster, or null when it is not offered. */
function goButton(name: string): HTMLButtonElement | null {
  return screen.queryByRole("button", { name });
}

// Step 3 of DESIGN.md §6.1: the dialog restates the target. It is the question
// a mistake gets wrong, so it is at the top of every phase rather than only of
// the confirm.
describe("restating the target", () => {
  it("names the cluster, the namespace and the rule that chose them", () => {
    open();

    const shown = within(screen.getByLabelText("Target"));
    expect(shown.getByText("prod-us-west")).toBeDefined();
    expect(shown.getByText("platform")).toBeDefined();
    expect(shown.getByText("the prod override")).toBeDefined();
  });

  it("says when the binding is the project's own default", () => {
    open({ binding: { ...bound, scope: "" } });

    expect(within(screen.getByLabelText("Target")).getByText("the project default")).toBeDefined();
  });

  it("is on screen while the preview is still running", () => {
    open({ phase: "previewing", preview: null, diff: null });

    expect(within(screen.getByLabelText("Target")).getByText("prod-us-west")).toBeDefined();
    expect(goButton("Apply")).toBeNull();
  });

  // The one line the user is supposed to check must not be the line that
  // changes under them: a dialog that opened saying "not bound" and became
  // "prod-us-west" a moment later teaches them to stop reading it.
  it("says it is still resolving rather than claiming nothing is bound", () => {
    open({ phase: "previewing", binding: UNBOUND, preview: null, diff: null });

    const shown = within(screen.getByLabelText("Target"));
    expect(shown.getAllByText("resolving…")).toHaveLength(2);
    expect(shown.queryByText("not bound")).toBeNull();
  });

  it("says so plainly once a resolved binding turns out to be unbound", () => {
    open({ phase: "blocked", binding: UNBOUND, preview: null, diff: null, error: "no binding" });

    expect(within(screen.getByLabelText("Target")).getByText("not bound")).toBeDefined();
  });
});

describe("what the user is agreeing to", () => {
  it("lists the objects the dry run resolved", () => {
    open();

    expect(screen.getByText(/deployment.apps\/api configured/)).toBeDefined();
  });

  it("shows the diff", () => {
    open();

    expect(screen.getByLabelText("Cluster diff")).toBeDefined();
  });

  // DESIGN.md §6.1 asks for this by name: an empty box is indistinguishable
  // from a diff that failed to render, and the two mean opposite things.
  it("says so in words when the cluster already matches", () => {
    open({ diff: result({ exitCode: 0, stdout: "" }) });

    expect(screen.getByText("The cluster already matches these manifests.")).toBeDefined();
    expect(screen.queryByLabelText("Cluster diff")).toBeNull();
  });

  it("shows kubectl's own error when the diff itself failed", () => {
    open({ diff: result({ exitCode: 2, stderr: "Unable to connect to the server" }) });

    expect(screen.getByText("Unable to connect to the server")).toBeDefined();
  });

  // DESIGN.md §1: everything m6t does is something the user could have typed.
  // It is also what the diff viewer's truncation note points at, so it has to
  // be on screen beside a diff that fits as well as one that does not.
  it("shows the command that produced the diff", () => {
    open({
      diff: result({ exitCode: 1, stdout: "-a\n", argv: ["kubectl", "diff", "--filename=x"] }),
    });

    expect(screen.getByText("kubectl diff --filename=x")).toBeDefined();
  });
});

// The acceptance criterion: a protected project cannot apply without the
// context name typed, and the typed value is checked exactly.
describe("a protected binding", () => {
  const guarded = { ...bound, protected: true };

  it("asks for the context name and names it", () => {
    open({ binding: guarded });

    expect(screen.getByLabelText("Confirmation")).toBeDefined();
    expect(within(screen.getByLabelText("Confirmation")).getByText("prod-us-west")).toBeDefined();
  });

  it("leaves the button disabled until the name is typed exactly", () => {
    open({ binding: guarded });
    const field = screen.getByLabelText("context name");

    expect(goButton("Apply")?.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "prod-us" } });
    expect(goButton("Apply")?.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "prod-us-west " } });
    expect(goButton("Apply")?.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "prod-us-west" } });
    expect(goButton("Apply")?.disabled).toBe(false);
  });

  it("hands what was typed to the caller, which is what the backend checks", () => {
    const { onConfirm } = open({ binding: guarded });

    fireEvent.change(screen.getByLabelText("context name"), {
      target: { value: "prod-us-west" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onConfirm).toHaveBeenCalledWith("prod-us-west");
  });

  // The field would be a memory test rather than a deliberate step if the
  // browser could fill it in.
  it("offers the field no autocomplete", () => {
    open({ binding: guarded });

    expect(screen.getByLabelText("context name").getAttribute("autocomplete")).toBe("off");
  });
});

describe("an unprotected binding", () => {
  it("asks for nothing typed and offers the button", () => {
    open();

    expect(screen.queryByLabelText("Confirmation")).toBeNull();
    expect(goButton("Apply")?.disabled).toBe(false);
  });

  it("confirms with an empty string, which the backend ignores", () => {
    const { onConfirm } = open();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onConfirm).toHaveBeenCalledWith("");
  });
});

describe("a blocked run", () => {
  const blocked = {
    phase: "blocked" as const,
    preview: result({ exitCode: 1, stderr: "error validating data: unknown field" }),
    diff: null,
  };

  it("shows kubectl's own reason and offers no way past it", () => {
    open(blocked);

    expect(screen.getByText(/error validating data/)).toBeDefined();
    expect(goButton("Apply")).toBeNull();
  });

  it("says that nothing has been applied", () => {
    open(blocked);

    expect(screen.getByText(/nothing has been applied/)).toBeDefined();
  });

  it("says that nothing has been deleted on a delete", () => {
    open({ ...blocked, target: { ...target, action: "delete" } });

    expect(screen.getByText(/nothing has been deleted/)).toBeDefined();
  });

  it("shows a refusal that never reached kubectl", () => {
    open({ phase: "blocked", preview: null, diff: null, error: "path escapes the project root" });

    expect(screen.getByText("path escapes the project root")).toBeDefined();
  });
});

describe("a delete", () => {
  it("names the objects that would go rather than the file naming them", () => {
    open({
      target: { ...target, action: "delete" },
      preview: result({ stdout: 'deployment.apps "api" deleted (server dry run)\n' }),
      diff: null,
    });

    expect(screen.getByText("Would be deleted")).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
  });
});

describe("a plain diff", () => {
  const diffing = { target: { ...target, action: "diff" as const }, preview: null };

  it("offers nothing that would change the cluster", () => {
    open(diffing);

    expect(goButton("Apply")).toBeNull();
    expect(goButton("Diff")).toBeNull();
  });

  it("asks for no typed context even on a protected binding", () => {
    open({ ...diffing, binding: { ...bound, protected: true } });

    expect(screen.queryByLabelText("Confirmation")).toBeNull();
  });
});

describe("a finished run", () => {
  it("says it is done and shows what kubectl printed", () => {
    open({
      phase: "done",
      outcome: result({ stdout: "deployment.apps/api configured\n" }),
    });

    expect(screen.getByText("Done.")).toBeDefined();
    expect(screen.getByText(/deployment.apps\/api configured/)).toBeDefined();
  });

  it("reports a non-zero exit with kubectl's own stderr", () => {
    open({
      phase: "done",
      outcome: result({ exitCode: 1, stderr: "Error from server (Forbidden)" }),
    });

    expect(screen.getByText("kubectl exited 1")).toBeDefined();
    expect(screen.getByText("Error from server (Forbidden)")).toBeDefined();
  });

  it("shows the backend's message when nothing ran at all", () => {
    open({ phase: "done", outcome: null, error: "this binding is protected" });

    expect(screen.getByText("this binding is protected")).toBeDefined();
  });

  it("offers Close rather than Cancel", () => {
    open({ phase: "done", outcome: result() });

    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });
});

describe("getting out of it", () => {
  it("closes on Escape", () => {
    const { onClose } = open();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  // There is nothing left to refuse while the mutation is in flight, and the
  // output is what the user is waiting for.
  it("does not close on Escape while the mutation is running", () => {
    const { onClose } = open({ phase: "running" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables Cancel while the mutation is running", () => {
    open({ phase: "running" });

    expect(screen.getByRole("button", { name: "Cancel" }).getAttribute("disabled")).not.toBeNull();
  });

  it("ignores other keys", () => {
    const { onClose } = open();

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });
});
