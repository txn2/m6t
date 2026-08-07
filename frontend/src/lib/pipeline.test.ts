import { describe, expect, it } from "vitest";
import type { Binding, CheckResult } from "./kube";
import { UNBOUND } from "./kube";
import type { RunEntry } from "./pipeline";
import {
  MAX_DIFF_LINES,
  RUN_LOG_LIMIT,
  actionVerb,
  actionable,
  authorized,
  blocks,
  diffLines,
  diffVerdict,
  guarded,
  logged,
  omitted,
  runSummary,
  runTime,
  succeeded,
} from "./pipeline";

const result = (over: Partial<CheckResult> = {}): CheckResult =>
  ({ argv: ["kubectl"], exitCode: 0, stdout: "", stderr: "", ...over }) as CheckResult;

const binding = (over: Partial<Binding> = {}): Binding => ({ ...UNBOUND, ...over });

const entry = (over: Partial<RunEntry> = {}): RunEntry => ({
  id: "1",
  at: 0,
  action: "apply",
  target: "prod/api/deploy.yaml",
  context: "prod-us-west",
  namespace: "platform",
  argv: ["kubectl", "apply"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  failure: "",
  ...over,
});

// kubectl diff answers in its exit code, and the three answers are different
// things to show. Collapsing "there are changes" with "the command failed" —
// which is what testing for non-zero does — would put a failure behind an
// Apply button.
describe("reading a diff's verdict", () => {
  it("calls a zero exit no changes at all", () => {
    expect(diffVerdict(result({ exitCode: 0 }))).toBe("same");
  });

  it("calls exit 1 a set of differences", () => {
    expect(diffVerdict(result({ exitCode: 1 }))).toBe("differs");
  });

  it("calls anything above 1 a failure of the command itself", () => {
    expect(diffVerdict(result({ exitCode: 2 }))).toBe("failed");
    expect(diffVerdict(result({ exitCode: 127 }))).toBe("failed");
  });
});

describe("what blocks a run", () => {
  it("stops a preview step that the cluster refused", () => {
    expect(blocks(result({ exitCode: 1 }))).toBe(true);
    expect(blocks(result({ exitCode: 43 }))).toBe(true);
  });

  it("lets a clean preview through", () => {
    expect(blocks(result({ exitCode: 0 }))).toBe(false);
  });
});

// The acceptance criterion from #11: a protected project cannot apply without
// the context name, and the typed value is checked exactly. This is the
// frontend's copy of the rule, and it must not be looser than the backend's —
// internal/app/pipeline_test.go holds the same table on the other side.
describe("authorizing a mutation", () => {
  it("asks for nothing when the binding is not protected", () => {
    expect(guarded(binding({ context: "dev" }))).toBe(false);
    expect(authorized(binding({ context: "dev" }), "")).toBe(true);
  });

  it("accepts the context name exactly", () => {
    expect(authorized(binding({ context: "prod-us-west", protected: true }), "prod-us-west")).toBe(
      true,
    );
  });

  it.each([
    ["nothing typed", ""],
    ["a different context", "dev-cluster"],
    ["trailing whitespace", "prod-us-west "],
    ["leading whitespace", " prod-us-west"],
    ["wrong case", "PROD-US-WEST"],
    ["a prefix", "prod-us"],
  ])("refuses %s", (_name, typed) => {
    expect(authorized(binding({ context: "prod-us-west", protected: true }), typed)).toBe(false);
  });
});

describe("splitting a unified diff", () => {
  it("marks additions and removals by their sign", () => {
    expect(diffLines("-  replicas: 2\n+  replicas: 3\n")).toEqual([
      { kind: "removed", text: "-  replicas: 2" },
      { kind: "added", text: "+  replicas: 3" },
    ]);
  });

  // The classic diff-viewer defect: `---` and `+++` are file headers, and a
  // classifier that tested the first character alone paints them as a removed
  // and an added line of punctuation.
  it("treats the file headers as headers rather than as a change", () => {
    const lines = diffLines("--- /tmp/LIVE/api\n+++ /tmp/MERGED/api\n@@ -1,4 +1,4 @@\n");
    expect(lines.map((line) => line.kind)).toEqual(["meta", "meta", "meta"]);
  });

  it("leaves an unchanged line as context", () => {
    expect(diffLines("   name: api\n")).toEqual([{ kind: "context", text: "   name: api" }]);
  });

  it("does not invent an empty last line from the trailing newline", () => {
    expect(diffLines("+a\n")).toHaveLength(1);
  });

  it("keeps a blank line inside the diff", () => {
    expect(diffLines("+a\n\n+b\n")).toHaveLength(3);
  });

  it("handles empty output", () => {
    expect(diffLines("")).toEqual([]);
  });

  // Rendering a first apply of a large chart line by line is how the window
  // stops responding. What is dropped is reported rather than cut silently.
  it("caps what it renders and reports what it left out", () => {
    const huge = Array.from({ length: MAX_DIFF_LINES + 40 }, (_, i) => `+line ${String(i)}`);
    const output = `${huge.join("\n")}\n`;

    expect(diffLines(output)).toHaveLength(MAX_DIFF_LINES);
    expect(omitted(output)).toBe(41);
  });

  it("reports nothing omitted from a diff that fits", () => {
    expect(omitted("+a\n+b\n")).toBe(0);
  });
});

describe("a project's run log", () => {
  it("puts the newest run first", () => {
    const log = logged(logged([], entry({ id: "a" })), entry({ id: "b" }));

    expect(log.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("keeps a bounded number of runs", () => {
    let log: readonly RunEntry[] = [];
    for (let i = 0; i < RUN_LOG_LIMIT + 10; i += 1) {
      log = logged(log, entry({ id: String(i) }));
    }

    expect(log).toHaveLength(RUN_LOG_LIMIT);
    // The oldest went, not the newest.
    expect(log[0].id).toBe(String(RUN_LOG_LIMIT + 9));
  });

  it("counts a zero exit with no failure as a success", () => {
    expect(succeeded(entry())).toBe(true);
  });

  it("counts a non-zero exit as a failure", () => {
    expect(succeeded(entry({ exitCode: 1 }))).toBe(false);
  });

  // A refused confirmation never reached kubectl, so its exit code says
  // nothing. Reading it as one would report a refusal as a success.
  it("counts a run that never ran as a failure", () => {
    expect(succeeded(entry({ exitCode: 0, failure: "this binding is protected" }))).toBe(false);
  });
});

describe("summarising a run", () => {
  it("gives its own words to a run that never reached kubectl", () => {
    expect(runSummary(entry({ failure: "this binding is protected" }))).toBe(
      "this binding is protected",
    );
  });

  it("says a mutation succeeded", () => {
    expect(runSummary(entry())).toBe("succeeded");
  });

  it("distinguishes a diff's two ordinary answers", () => {
    expect(runSummary(entry({ action: "diff", exitCode: 0 }))).toBe("no changes");
    expect(runSummary(entry({ action: "diff", exitCode: 1 }))).toBe("changes pending");
  });

  it("reports the exit code of anything else", () => {
    expect(runSummary(entry({ exitCode: 43 }))).toBe("kubectl exited 43");
    expect(runSummary(entry({ action: "diff", exitCode: 2 }))).toBe("kubectl exited 2");
  });

  it("names the action a row is about", () => {
    expect(actionVerb("apply")).toBe("Apply");
    expect(actionVerb("delete")).toBe("Delete");
    expect(actionVerb("diff")).toBe("Diff");
  });

  it("shows a fixed-width time so the rows line up", () => {
    const at = new Date(2026, 7, 7, 9, 5, 3).getTime();

    expect(runTime(at)).toBe("09:05:03");
  });
});

// A menu entry whose only outcome is an error is worse than no entry (#38
// makes the same argument about the tree's own menu).
describe("where the pipeline is offered", () => {
  it("is offered on every directory, whatever it is called", () => {
    expect(actionable("prod", true)).toBe(true);
    expect(actionable("docs", true)).toBe(true);
  });

  it("is offered on a manifest, in either spelling and any case", () => {
    expect(actionable("prod/api/deploy.yaml", false)).toBe(true);
    expect(actionable("prod/api/deploy.yml", false)).toBe(true);
    expect(actionable("prod/api/DEPLOY.YAML", false)).toBe(true);
  });

  it("is not offered on a file that is not a manifest", () => {
    expect(actionable("README.md", false)).toBe(false);
    expect(actionable("scripts/deploy.sh", false)).toBe(false);
    // Nearly, but not: a file called `yaml` is not a YAML file.
    expect(actionable("notes/yaml", false)).toBe(false);
  });
});
