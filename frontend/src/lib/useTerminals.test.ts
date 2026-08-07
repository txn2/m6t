import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalSession } from "./terminalSession";
import { useTerminals } from "./useTerminals";

/** A session that records whether the strip ended it. */
function fakeSession(): TerminalSession {
  return {
    close: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
  } as unknown as TerminalSession;
}

describe("terminals scoped to projects", () => {
  it("keeps every project's tabs mounted and shows only the active one's", () => {
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useTerminals(project),
      { initialProps: { project: "alpha" } },
    );

    act(() => {
      result.current.create("alpha", "/w/alpha", null);
    });
    rerender({ project: "beta" });
    act(() => {
      result.current.create("beta", "/w/beta", null);
    });

    // Both panes stay mounted — that is what keeps a running shell alive across
    // a project switch — while the strip shows one project's.
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.visible).toHaveLength(1);
    expect(result.current.visible[0].project).toBe("beta");
  });

  it("numbers each project's tabs from one", () => {
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useTerminals(project),
      { initialProps: { project: "alpha" } },
    );

    act(() => {
      result.current.create("alpha", "/w/alpha", null);
    });
    rerender({ project: "beta" });
    act(() => {
      result.current.create("beta", "/w/beta", null);
    });

    expect(result.current.visible[0].title).toBe("shell 1");
  });

  it("remembers the selection per project", () => {
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useTerminals(project),
      { initialProps: { project: "alpha" } },
    );

    act(() => {
      result.current.create("alpha", "/w/alpha", null);
    });
    const alphaKey = result.current.activeKey;

    rerender({ project: "beta" });
    act(() => {
      result.current.create("beta", "/w/beta", null);
    });
    expect(result.current.activeKey).not.toBe(alphaKey);

    rerender({ project: "alpha" });
    expect(result.current.activeKey).toBe(alphaKey);
  });
});

describe("closing a project's terminals", () => {
  // The leak this exists to stop: a pane stays mounted for the life of the app,
  // so a tab whose project is gone from the strip would be a shell running with
  // nothing able to reach or end it. Asserting the tab list alone would not
  // catch it — the strip already hides another project's tabs.
  it("ends every session belonging to the project", () => {
    const { result } = renderHook(() => useTerminals("alpha"));

    act(() => {
      result.current.create("alpha", "/w/alpha", null);
      result.current.create("alpha", "/w/alpha", null);
    });

    const sessions = result.current.tabs.map(() => fakeSession());
    act(() => {
      result.current.tabs.forEach((tab, i) => {
        result.current.onAttach(tab.key, sessions[i]);
      });
    });

    act(() => {
      result.current.closeProject("alpha");
    });

    for (const session of sessions) {
      expect(session.close).toHaveBeenCalled();
    }
    expect(result.current.tabs).toHaveLength(0);
  });

  it("leaves another project's sessions running", () => {
    const { result, rerender } = renderHook(
      ({ project }: { project: string }) => useTerminals(project),
      { initialProps: { project: "alpha" } },
    );

    act(() => {
      result.current.create("alpha", "/w/alpha", null);
    });
    rerender({ project: "beta" });
    act(() => {
      result.current.create("beta", "/w/beta", null);
    });

    const betaTab = result.current.tabs.find((t) => t.project === "beta");
    if (!betaTab) {
      throw new Error("the beta tab was not created");
    }
    const betaSession = fakeSession();
    act(() => {
      result.current.onAttach(betaTab.key, betaSession);
    });

    act(() => {
      result.current.closeProject("alpha");
    });

    expect(betaSession.close).not.toHaveBeenCalled();
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].project).toBe("beta");
  });
});

describe("restoring a session's terminals", () => {
  it("reopens the saved tabs with their titles and directories, focused on the saved one", () => {
    const { result } = renderHook(() => useTerminals("infra"));

    act(() => {
      result.current.restore("infra", {
        tabs: [
          { title: "build", cwd: "/w/infra" },
          { title: "claude 1", cwd: "/w/infra/manifests" },
        ],
        active: 1,
      });
    });

    expect(result.current.visible.map((tab) => tab.title)).toEqual(["build", "claude 1"]);
    expect(result.current.visible.map((tab) => tab.cwd)).toEqual([
      "/w/infra",
      "/w/infra/manifests",
    ]);
    expect(result.current.activeKey).toBe(result.current.visible[1].key);
  });

  // A restored tab starts a shell, not the command that happened to be running
  // in it: re-running the user's last command at launch is a side effect.
  it("restores a tab as a plain shell", () => {
    const { result } = renderHook(() => useTerminals("infra"));

    act(() => {
      result.current.restore("infra", {
        tabs: [{ title: "claude 1", cwd: "/w/infra" }],
        active: 0,
      });
    });

    expect(result.current.visible[0].autorun).toBeNull();
    expect(result.current.visible[0].status).toBe("starting");
  });

  it("does nothing when a project had no terminals open", () => {
    const { result } = renderHook(() => useTerminals("infra"));

    act(() => {
      result.current.restore("infra", { tabs: [], active: 0 });
    });

    expect(result.current.visible).toHaveLength(0);
    expect(result.current.activeKey).toBeNull();
  });

  // Keys are never reused, and a restored tab is no exception: one that
  // collided with a closed tab's key would let React match a fresh pane to a
  // dead terminal.
  it("gives a restored tab a key no other tab has held", () => {
    const { result } = renderHook(() => useTerminals("infra"));

    act(() => {
      result.current.create("infra", "/w/infra", null);
    });
    const created = result.current.visible[0].key;
    act(() => {
      result.current.close(created);
    });
    act(() => {
      result.current.restore("infra", { tabs: [{ title: "shell 1", cwd: "/w/infra" }], active: 0 });
    });

    expect(result.current.visible[0].key).not.toBe(created);
  });
});
