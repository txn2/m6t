import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Binding, CheckResult, Kube } from "./kube";
import { UNBOUND } from "./kube";
import { usePipeline } from "./usePipeline";

const result = (over: Partial<CheckResult> = {}): CheckResult =>
  ({ argv: ["kubectl", "apply"], exitCode: 0, stdout: "", stderr: "", ...over }) as CheckResult;

const bound: Binding = {
  ...UNBOUND,
  context: "prod-us-west",
  namespace: "platform",
  scope: "prod",
};

/**
 * A `Kube` seam whose pipeline calls are spies and whose everything else
 * rejects — this file is about the sequence, and a call it does not name is a
 * call it should not be making.
 */
function stubKube(over: Partial<Kube> = {}): Kube {
  const unused = () => Promise.reject(new Error("not used here"));
  return {
    binding: () => Promise.resolve(bound),
    contexts: unused,
    namespaces: unused,
    check: unused,
    bindFolder: unused,
    unbindFolder: unused,
    tools: unused,
    validate: vi.fn(() => Promise.resolve(result())),
    diff: vi.fn(() => Promise.resolve(result({ exitCode: 1, stdout: "-a\n+b\n" }))),
    apply: vi.fn(() => Promise.resolve(result())),
    deletePreview: vi.fn(() => Promise.resolve(result({ stdout: "deployment.apps/api\n" }))),
    remove: vi.fn(() => Promise.resolve(result())),
    ...over,
  } as Kube;
}

function open(kube: Kube, project: string | null = "infra") {
  return renderHook(({ name }) => usePipeline(name, kube), {
    initialProps: { name: project },
  });
}

describe("starting a run", () => {
  // Steps 1 and 2 both run before the user is asked anything, which is what
  // makes the confirm dialog a decision rather than a reflex (DESIGN.md §6.1).
  it("validates and then diffs an apply, and stops at the confirm", async () => {
    const kube = stubKube();
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("apply", "prod/api/deploy.yaml");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });
    expect(kube.validate).toHaveBeenCalledWith("infra", "prod/api/deploy.yaml");
    expect(kube.diff).toHaveBeenCalledWith("infra", "prod/api/deploy.yaml");
    // Nothing has reached the cluster: step 4 waits for an answer.
    expect(kube.apply).not.toHaveBeenCalled();
    expect(hook.current.run?.binding.context).toBe("prod-us-west");
  });

  it("is on screen before the cluster answers", () => {
    const { result: hook } = open(stubKube());

    act(() => {
      hook.current.start("apply", "prod");
    });

    expect(hook.current.run?.phase).toBe("previewing");
  });

  // The acceptance criterion: a validation failure blocks before any mutation,
  // with stderr shown. Running the diff anyway would put a diff of manifests
  // the cluster has already rejected in front of the user.
  it("blocks on a failed validation without diffing", async () => {
    const kube = stubKube({
      validate: vi.fn(() =>
        Promise.resolve(result({ exitCode: 1, stderr: "error validating data" })),
      ),
    });
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("apply", "prod/api/deploy.yaml");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("blocked");
    });
    expect(hook.current.run?.preview?.stderr).toContain("error validating data");
    expect(kube.diff).not.toHaveBeenCalled();
    expect(kube.apply).not.toHaveBeenCalled();
  });

  // "Delete dry-run lists the objects before anything is removed."
  it("previews a delete and asks before removing anything", async () => {
    const kube = stubKube();
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("delete", "prod/api/deploy.yaml");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });
    expect(kube.deletePreview).toHaveBeenCalledWith("infra", "prod/api/deploy.yaml");
    expect(hook.current.run?.preview?.stdout).toContain("deployment.apps/api");
    expect(kube.remove).not.toHaveBeenCalled();
    // A delete has no diff to show: what would change is the objects going.
    expect(kube.diff).not.toHaveBeenCalled();
  });

  it("runs a plain diff on its own, with no validation in front of it", async () => {
    const kube = stubKube();
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("diff", "prod");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });
    expect(kube.diff).toHaveBeenCalled();
    expect(kube.validate).not.toHaveBeenCalled();
  });

  it("blocks when the backend refuses the call outright", async () => {
    const kube = stubKube({
      validate: () => Promise.reject(new Error("path escapes the project root")),
    });
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("apply", "../outside.yaml");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("blocked");
    });
    expect(hook.current.run?.error).toContain("escapes");
  });

  it("starts nothing when there is no project open", () => {
    const kube = stubKube();
    const { result: hook } = open(kube, null);

    act(() => {
      hook.current.start("apply", "prod");
    });

    expect(hook.current.run).toBeNull();
    expect(kube.validate).not.toHaveBeenCalled();
  });
});

describe("confirming a run", () => {
  async function ready(kube: Kube) {
    const view = open(kube);
    act(() => {
      view.result.current.start("apply", "prod/api/deploy.yaml");
    });
    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("ready");
    });
    return view;
  }

  it("carries the typed context to the backend", async () => {
    const kube = stubKube();
    const { result: hook } = await ready(kube);

    act(() => {
      hook.current.confirm("prod-us-west");
    });

    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("done");
    });
    expect(kube.apply).toHaveBeenCalledWith("infra", "prod/api/deploy.yaml", "prod-us-west");
  });

  it("deletes rather than applies when that is what the run is", async () => {
    const kube = stubKube();
    const view = open(kube);
    act(() => {
      view.result.current.start("delete", "prod/api/deploy.yaml");
    });
    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("ready");
    });

    act(() => {
      view.result.current.confirm("prod-us-west");
    });

    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("done");
    });
    expect(kube.remove).toHaveBeenCalled();
    expect(kube.apply).not.toHaveBeenCalled();
  });

  // The dialog offers no button for it, and the controller refuses it anyway:
  // a read-only action has nothing to confirm, and a path that would mutate on
  // one is a path worth closing on both sides.
  it("refuses to mutate on a diff run", async () => {
    const kube = stubKube();
    const view = open(kube);
    act(() => {
      view.result.current.start("diff", "prod");
    });
    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("ready");
    });

    act(() => {
      view.result.current.confirm("prod-us-west");
    });

    expect(kube.apply).not.toHaveBeenCalled();
    expect(kube.remove).not.toHaveBeenCalled();
  });

  it("does nothing when there is no run to confirm", () => {
    const kube = stubKube();
    const { result: hook } = open(kube);

    act(() => {
      hook.current.confirm("prod-us-west");
    });

    expect(kube.apply).not.toHaveBeenCalled();
  });

  it("keeps kubectl's own refusal on screen", async () => {
    const kube = stubKube({
      apply: () => Promise.resolve(result({ exitCode: 1, stderr: "Forbidden" })),
    });
    const { result: hook } = await ready(kube);

    act(() => {
      hook.current.confirm("prod-us-west");
    });

    await waitFor(() => {
      expect(hook.current.run?.outcome?.stderr).toBe("Forbidden");
    });
  });

  it("shows the backend's own message when nothing ran", async () => {
    const kube = stubKube({
      apply: () => Promise.reject(new Error("this binding is protected")),
    });
    const { result: hook } = await ready(kube);

    act(() => {
      hook.current.confirm("");
    });

    await waitFor(() => {
      expect(hook.current.run?.error).toContain("protected");
    });
    expect(hook.current.run?.outcome).toBeNull();
  });
});

describe("the session run log", () => {
  it("records what reached the cluster, and nothing that did not", async () => {
    const kube = stubKube();
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("apply", "prod/api/deploy.yaml");
    });
    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });
    // A preview is not a run: nothing is logged until step 4.
    expect(hook.current.log).toHaveLength(0);

    act(() => {
      hook.current.confirm("prod-us-west");
    });

    await waitFor(() => {
      expect(hook.current.log).toHaveLength(1);
    });
    expect(hook.current.log[0]).toMatchObject({
      action: "apply",
      target: "prod/api/deploy.yaml",
      context: "prod-us-west",
      namespace: "platform",
      exitCode: 0,
      failure: "",
    });
  });

  // A refusal is a result the log has to carry: "what have I already tried
  // against prod today" includes the attempts that were turned away.
  it("records a run the backend refused, with its own words", async () => {
    const kube = stubKube({
      apply: () => Promise.reject(new Error("this binding is protected")),
    });
    const { result: hook } = open(kube);

    act(() => {
      hook.current.start("apply", "prod/api/deploy.yaml");
    });
    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });
    act(() => {
      hook.current.confirm("wrong");
    });

    await waitFor(() => {
      expect(hook.current.log).toHaveLength(1);
    });
    expect(hook.current.log[0].failure).toContain("protected");
    expect(hook.current.log[0].argv).toEqual([]);
  });

  // The log is per project, so switching tabs must not show one project's
  // applies under another's name.
  it("keeps each project's runs to itself", async () => {
    const kube = stubKube();
    const view = open(kube, "infra");

    act(() => {
      view.result.current.start("apply", "prod");
    });
    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("ready");
    });
    act(() => {
      view.result.current.confirm("prod-us-west");
    });
    await waitFor(() => {
      expect(view.result.current.log).toHaveLength(1);
    });

    view.rerender({ name: "other" });

    expect(view.result.current.log).toHaveLength(0);

    // And it is still there when the user comes back.
    view.rerender({ name: "infra" });
    expect(view.result.current.log).toHaveLength(1);
  });
});

describe("closing", () => {
  it("takes the dialog away", async () => {
    const { result: hook } = open(stubKube());
    act(() => {
      hook.current.start("apply", "prod");
    });
    await waitFor(() => {
      expect(hook.current.run?.phase).toBe("ready");
    });

    act(() => {
      hook.current.close();
    });

    expect(hook.current.run).toBeNull();
  });

  // A dialog left standing over a project the user has navigated away from is
  // a dialog whose Apply reaches a repository they are no longer looking at.
  it("closes when the project changes", async () => {
    const view = open(stubKube(), "infra");
    act(() => {
      view.result.current.start("apply", "prod");
    });
    await waitFor(() => {
      expect(view.result.current.run?.phase).toBe("ready");
    });

    view.rerender({ name: "other" });

    expect(view.result.current.run).toBeNull();
  });

  // A preview that lands after the user closed the dialog would otherwise
  // reopen it, over whatever they moved on to.
  it("drops a preview that lands after it was closed", async () => {
    let land = (_: CheckResult) => undefined as void;
    const kube = stubKube({
      validate: () =>
        new Promise<CheckResult>((resolve) => {
          land = resolve;
        }),
    });
    const { result: hook } = open(kube);
    act(() => {
      hook.current.start("apply", "prod");
    });

    act(() => {
      hook.current.close();
    });
    await act(async () => {
      land(result());
      await Promise.resolve();
    });

    expect(hook.current.run).toBeNull();
  });
});
