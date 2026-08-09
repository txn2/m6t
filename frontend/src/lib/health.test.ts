import { describe, expect, it } from "vitest";
import { kubewatch as models } from "../../wailsjs/go/models";
import type { HealthSnapshot, ObjectStatus } from "./health";
import {
  byKind,
  forFile,
  healthNote,
  noticesFor,
  healthIcon,
  healthLabel,
  isFailing,
  isLive,
  phaseLabel,
} from "./health";

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
    phase: "connecting",
    reason: "",
    objects: [],
    notices: [],
    ...over,
  });
}

describe("phaseLabel", () => {
  it("gives an idle session the backend's own reason", () => {
    const label = phaseLabel(snapshot({ phase: "idle", reason: "nothing here is declared" }));
    expect(label).toBe("nothing here is declared");
  });

  it("falls back to a phrase when an idle session gives no reason", () => {
    expect(phaseLabel(snapshot({ phase: "idle" }))).toBe("not watching");
  });

  // Terse and lower case: it sits inline beside the file name, not in a
  // sentence of its own.
  it.each([
    ["connecting", "connecting"],
    ["watching", "watching"],
    ["reconnecting", "reconnecting"],
    ["unauthorized", "cluster refused this user"],
  ])("names the %s phase", (phase, want) => {
    expect(phaseLabel(snapshot({ phase }))).toBe(want);
  });

  // The wire values are the backend's, and a build that met one it did not know
  // must say so rather than render an empty line.
  it("shows a phase this build does not know rather than nothing", () => {
    expect(phaseLabel(snapshot({ phase: "hibernating" }))).toBe("hibernating");
  });
});

describe("isLive and isFailing", () => {
  it.each([
    ["watching", true, false],
    ["connecting", false, false],
    ["idle", false, false],
    ["reconnecting", false, true],
    ["unauthorized", false, true],
  ])("classifies %s", (phase, live, failing) => {
    expect(isLive(snapshot({ phase }))).toBe(live);
    expect(isFailing(snapshot({ phase }))).toBe(failing);
  });
});

describe("byKind", () => {
  it("groups objects by kind", () => {
    const groups = byKind([
      object({ kind: "Deployment", name: "web" }),
      object({ kind: "Deployment", name: "worker" }),
      object({ kind: "Service", name: "web" }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["Deployment", "Service"]);
    expect(groups[0].objects.map((o) => o.name)).toEqual(["web", "worker"]);
    expect(groups[1].objects.map((o) => o.name)).toEqual(["web"]);
  });

  // Folding rather than sorting is what keeps the panel's order and the
  // backend's from ever disagreeing.
  it("keeps the order it was given", () => {
    const groups = byKind([
      object({ kind: "Service", name: "b" }),
      object({ kind: "Deployment", name: "a" }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["Service", "Deployment"]);
  });

  // A kind that reappears after another belongs in the group it opened, not in
  // a second group with the same heading.
  it("puts a kind that reappears back in its own group", () => {
    const groups = byKind([
      object({ kind: "Deployment", name: "a" }),
      object({ kind: "Service", name: "b" }),
      object({ kind: "Deployment", name: "c" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].objects.map((o) => o.name)).toEqual(["a", "c"]);
  });

  it("returns nothing for nothing", () => {
    expect(byKind([])).toEqual([]);
  });
});

// The pane is 280px wide and sits under three other sections. A project-wide
// list is one whose interesting row is off the bottom, so the section answers
// about the file on screen and nothing else.
describe("forFile and noticesFor", () => {
  it("keeps only the objects the open file declares", () => {
    const kept = forFile(
      [
        object({ name: "mine", file: "app.yaml" }),
        object({ name: "theirs", file: "other.yaml" }),
        object({ name: "also-mine", file: "app.yaml" }),
      ],
      "app.yaml",
    );

    expect(kept.map((o) => o.name)).toEqual(["mine", "also-mine"]);
  });

  it("keeps only the notices about the open file", () => {
    const kept = noticesFor(
      [
        models.Notice.createFrom({ file: "app.yaml", reason: "a tab" }),
        models.Notice.createFrom({ file: "other.yaml", reason: "not mine" }),
      ],
      "app.yaml",
    );

    expect(kept.map((n) => n.reason)).toEqual(["a tab"]);
  });

  it("matches on the whole path, not a prefix of it", () => {
    const kept = forFile([object({ file: "prod/app.yaml" })], "prod/app.yam");

    expect(kept).toEqual([]);
  });
});

describe("healthNote", () => {
  // The state anyone is scanning for is never "fine", and a verdict on every
  // row is a second column of text the pane has no width for.
  it("says nothing for a healthy object", () => {
    expect(healthNote(object({ health: "Current", message: "ignored" }))).toBe("");
  });

  it("prefers the backend's own message", () => {
    const note = healthNote(object({ health: "InProgress", message: "Replicas: 1/3" }));
    expect(note).toBe("Replicas: 1/3");
  });

  it("falls back to naming the state when there is no message", () => {
    expect(healthNote(object({ health: "NotFound" }))).toBe("not in the cluster");
  });
});

describe("healthIcon", () => {
  it.each([
    ["Current", "health-current"],
    ["InProgress", "health-progress"],
    ["Failed", "health-failed"],
    ["NotFound", "health-absent"],
    ["Terminating", "health-terminating"],
    ["Unknown", "health-unknown"],
  ])("maps %s", (health, icon) => {
    expect(healthIcon(health)).toBe(icon);
  });

  it("falls back for a state this build does not know", () => {
    expect(healthIcon("Suspended")).toBe("health-unknown");
  });
});

describe("healthLabel", () => {
  it("spells NotFound out rather than leaving it to the icon", () => {
    expect(healthLabel(object({ health: "NotFound" }))).toBe("Not in the cluster");
  });

  it("appends the backend's message when there is one", () => {
    const label = healthLabel(object({ health: "InProgress", message: "Replicas: 1/3" }));
    expect(label).toBe("In progress: Replicas: 1/3");
  });

  it("shows a state this build does not know rather than nothing", () => {
    expect(healthLabel(object({ health: "Suspended" }))).toBe("Suspended");
  });
});
