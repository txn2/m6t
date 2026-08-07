import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEntry } from "../lib/pipeline";
import { RunLog } from "./RunLog";

afterEach(cleanup);

const entry = (over: Partial<RunEntry> = {}): RunEntry => ({
  id: "1",
  at: new Date(2026, 7, 7, 14, 3, 9).getTime(),
  action: "apply",
  target: "prod/api/deploy.yaml",
  context: "prod-us-west",
  namespace: "platform",
  argv: ["kubectl", "--context=prod-us-west", "apply"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  failure: "",
  ...over,
});

/** The log's rows, or an empty list when it drew nothing at all. */
function rows(): HTMLElement[] {
  const log = screen.queryByLabelText("Cluster runs");
  return log === null ? [] : [...log.querySelectorAll<HTMLElement>(".runlog__row")];
}

describe("the session run log", () => {
  // A section with no rows would be a heading over nothing, occupying the space
  // the cluster panel exists for in every project that has not applied yet.
  it("is absent until something has run", () => {
    render(<RunLog entries={[]} />);

    expect(screen.queryByLabelText("Cluster runs")).toBeNull();
  });

  it("says when, what and where for each run", () => {
    render(<RunLog entries={[entry()]} />);

    const row = within(rows()[0]);
    expect(row.getByText("14:03:09")).toBeDefined();
    expect(row.getByText("Apply")).toBeDefined();
    expect(row.getByText("prod/api/deploy.yaml")).toBeDefined();
    expect(row.getByText("prod-us-west / platform")).toBeDefined();
    expect(row.getByText("succeeded")).toBeDefined();
  });

  it("marks a failed run apart from a successful one", () => {
    render(
      <RunLog
        entries={[entry({ id: "a", exitCode: 1 }), entry({ id: "b" })]}
      />,
    );

    expect(rows().map((row) => row.getAttribute("data-ok"))).toEqual(["false", "true"]);
  });

  it("shows a refusal in its own words rather than as an exit code", () => {
    render(<RunLog entries={[entry({ failure: "this binding is protected", argv: [] })]} />);

    expect(screen.getByText("this binding is protected")).toBeDefined();
  });

  // DESIGN.md §1: everything m6t did is something the user could have typed.
  it("keeps the command that produced each row", () => {
    render(<RunLog entries={[entry()]} />);

    expect(screen.getByText("kubectl --context=prod-us-west apply")).toBeDefined();
  });

  // A run that never built an argv has no command to disclose, and an empty
  // "command" fold would suggest one was hidden rather than never made.
  it("offers no command for a run that never got as far as building one", () => {
    render(<RunLog entries={[entry({ failure: "refused", argv: [] })]} />);

    expect(screen.queryByText("command")).toBeNull();
  });

  it("names the path in full on hover, since the column truncates it", () => {
    render(<RunLog entries={[entry()]} />);

    expect(screen.getByTitle("prod/api/deploy.yaml")).toBeDefined();
  });

  it("leaves off the separator when there is no namespace to name", () => {
    render(<RunLog entries={[entry({ namespace: "" })]} />);

    expect(screen.getByText("prod-us-west")).toBeDefined();
  });
});
