import { describe, expect, it } from "vitest";
import type { TerminalTab } from "./tabs";
import {
  endingClosesTheTab,
  exitDescription,
  newTab,
  nextTitle,
  patchTab,
  removeTab,
  renameTab,
  restartTab,
  selectionAfterClose,
  statusPatch,
} from "./tabs";

const strip = (...titles: string[]): TerminalTab[] =>
  titles.map((title, index) => newTab(`k${String(index)}`, title, "/w"));

describe("opening tabs", () => {
  it("starts a tab before it has a session", () => {
    const tab = newTab("k1", "shell 1", "/w/project");

    expect(tab.status).toBe("starting");
    expect(tab.cwd).toBe("/w/project");
    expect(tab.exitCode).toBeNull();
    expect(tab.autorun).toBeNull();
  });

  it("carries the line the Claude Code action types", () => {
    expect(newTab("k1", "claude 1", "/w", "claude").autorun).toBe("claude");
  });

  it("numbers a new tab from one", () => {
    expect(nextTitle([], "shell")).toBe("shell 1");
  });

  it("skips the numbers already in use", () => {
    expect(nextTitle(strip("shell 1", "shell 2"), "shell")).toBe("shell 3");
  });

  // A running count would climb forever; the point of the lowest free number is
  // that closing "shell 2" gives that name back.
  it("reuses a number freed by a closed tab", () => {
    expect(nextTitle(strip("shell 1", "shell 3"), "shell")).toBe("shell 2");
  });

  it("counts each name series separately", () => {
    expect(nextTitle(strip("shell 1", "claude 1"), "claude")).toBe("claude 2");
  });
});

describe("editing tabs", () => {
  it("patches only the named tab", () => {
    const tabs = patchTab(strip("a", "b"), "k1", { status: "running" });

    expect(tabs[1].status).toBe("running");
    expect(tabs[0].status).toBe("starting");
  });

  it("renames a tab", () => {
    expect(renameTab(strip("a"), "k0", "  build  ")[0].title).toBe("build");
  });

  // An empty label leaves nothing to click on to rename it back.
  it("refuses a blank rename", () => {
    expect(renameTab(strip("a"), "k0", "   ")[0].title).toBe("a");
  });

  it("removes a tab", () => {
    expect(removeTab(strip("a", "b"), "k0").map((t) => t.title)).toEqual(["b"]);
  });
});

describe("restarting an ended tab", () => {
  it("clears the ended state and takes a new generation", () => {
    const ended = patchTab(strip("a"), "k0", {
      status: "exited",
      exitCode: 1,
      error: "boom",
    });

    const [tab] = restartTab(ended, "k0");

    expect(tab.status).toBe("starting");
    expect(tab.exitCode).toBeNull();
    expect(tab.error).toBeNull();
    // The generation is part of the pane's React key: without a new one the
    // dead terminal would be reused instead of rebuilt.
    expect(tab.generation).toBe(1);
  });

  it("keeps the title and the directory the tab was opened with", () => {
    const [tab] = restartTab(renameTab(strip("a"), "k0", "build"), "k0");

    expect(tab.title).toBe("build");
    expect(tab.cwd).toBe("/w");
  });
});

describe("what is selected after a close", () => {
  const tabs = strip("a", "b", "c");

  it("does not move the selection when another tab closes", () => {
    expect(selectionAfterClose(tabs, "k0", "k2")).toBe("k2");
  });

  it("selects the right-hand neighbour of the closed tab", () => {
    expect(selectionAfterClose(tabs, "k1", "k1")).toBe("k2");
  });

  it("falls back to the left when the last tab closes", () => {
    expect(selectionAfterClose(tabs, "k2", "k2")).toBe("k1");
  });

  it("selects nothing when the only tab closes", () => {
    expect(selectionAfterClose(strip("a"), "k0", "k0")).toBeNull();
  });
});

describe("what an ending does to the tab", () => {
  // Typing `exit` is the user closing the tab; a strip that filled up with
  // dead tabs behind every ^D would be one nobody would use.
  it("closes a tab whose shell ended normally", () => {
    expect(endingClosesTheTab({ kind: "exited", code: 0 })).toBe(true);
  });

  // These are the cases the user has to be able to read after the fact, which
  // is what the exited state and its restart affordance exist for.
  it.each([
    ["a non-zero status", { kind: "exited" as const, code: 1 }],
    ["a signal", { kind: "exited" as const, code: -1 }],
    [
      "a session that never started",
      { kind: "failed" as const, message: "chdir /nope" },
    ],
  ])("keeps a tab that ended on %s", (_name, status) => {
    expect(endingClosesTheTab(status)).toBe(false);
  });

  it("does not close a tab that is merely running", () => {
    expect(endingClosesTheTab({ kind: "running" })).toBe(false);
  });
});

describe("the tab fields a status determines", () => {
  it("clears an earlier failure when a restarted tab runs", () => {
    expect(statusPatch({ kind: "running" })).toEqual({
      status: "running",
      error: null,
    });
  });

  it("records the status the child ended with", () => {
    expect(statusPatch({ kind: "exited", code: 130 })).toEqual({
      status: "exited",
      exitCode: 130,
    });
  });

  it("records why a session could not be had", () => {
    expect(statusPatch({ kind: "failed", message: "no shell" })).toEqual({
      status: "failed",
      error: "no shell",
    });
  });
});

describe("describing an ended tab", () => {
  const ended = (patch: Partial<TerminalTab>) =>
    exitDescription({ ...newTab("k", "t", "/w"), ...patch });

  it("reports the child's status", () => {
    expect(ended({ status: "exited", exitCode: 130 })).toBe(
      "exited with status 130",
    );
  });

  // -1 is the protocol's "terminated by a signal"; printing it as a status
  // would be a number no shell ever returns.
  it("reports a signal rather than the -1 that stands for it", () => {
    expect(ended({ status: "exited", exitCode: -1 })).toBe(
      "terminated by a signal",
    );
  });

  it("reports why a tab never got a session", () => {
    expect(ended({ status: "failed", error: "chdir /nope: no such file" })).toBe(
      "chdir /nope: no such file",
    );
  });
});
