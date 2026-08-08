import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { kubewatch as models } from "../../wailsjs/go/models";
import type { Health, HealthSnapshot, ObjectStatus } from "./health";
import { useHealth } from "./useHealth";

const endpoint = { port: 51234, token: "tok" };

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

/** A Health seam whose answers a test controls, keyed by "project|rel". */
function fakeHealth(answers: Record<string, HealthSnapshot>) {
  return {
    snapshot: vi.fn((name: string, rel: string) =>
      Promise.resolve(answers[`${name}|${rel}`] ?? snapshot({ phase: "idle" })),
    ),
  };
}

/** A minimal fake WebSocket, the shape useGitStatus's own tests use. */
function fakeSocketFactory() {
  const sockets: { onmessage: ((event: MessageEvent) => void) | null; close: () => void }[] = [];
  const factory = vi.fn(() => {
    const socket = { onmessage: null, close: vi.fn() };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { factory, sockets };
}

/** A `health` event frame, as the backend publishes it (PROTOCOL.md §5). */
function healthEvent(root: string): MessageEvent {
  return { data: JSON.stringify({ type: "health", payload: { root } }) } as MessageEvent;
}

describe("reading a selection's health", () => {
  it("asks as soon as a project is given, which is what starts the watch", async () => {
    const health = fakeHealth({ "infra|deploy.yaml": snapshot({ objects: [object()] }) });
    const { result } = renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, null, health),
    );

    await waitFor(() => {
      expect(result.current.snapshot.objects).toHaveLength(1);
    });
    expect(result.current.snapshot.phase).toBe("watching");
    expect(health.snapshot).toHaveBeenCalledWith("infra", "deploy.yaml");
  });

  it("asks nothing when there is no project", () => {
    const health = fakeHealth({});
    renderHook(() => useHealth({ project: null, root: null, file: "deploy.yaml" }, null, health));

    expect(health.snapshot).not.toHaveBeenCalled();
  });

  // The selection is the folder a scope is written against, and the backend
  // answers for a different binding at a different folder.
  it("re-asks when the selection moves within a project", async () => {
    const health = fakeHealth({
      "infra|deploy.yaml": snapshot({ objects: [object({ name: "root-thing" })] }),
      "infra|prod/app.yaml": snapshot({ objects: [object({ name: "prod-thing" })] }),
    });
    const { result, rerender } = renderHook(
      ({ file }: { file: string }) =>
        useHealth({ project: "infra", root: "/w/infra", file }, null, health),
      { initialProps: { file: "deploy.yaml" } },
    );

    await waitFor(() => {
      expect(result.current.snapshot.objects[0]?.name).toBe("root-thing");
    });

    rerender({ file: "prod/app.yaml" });

    await waitFor(() => {
      expect(result.current.snapshot.objects[0]?.name).toBe("prod-thing");
    });
  });

  // One cluster's object states under another cluster's name is the reading
  // this panel exists to prevent, so nothing is carried across a switch.
  it("shows nothing of the last selection while the new one is in flight", async () => {
    let released = false;
    const health: Health = {
      snapshot: vi.fn((_name: string, rel: string) => {
        if (rel === "deploy.yaml") {
          return Promise.resolve(snapshot({ objects: [object({ name: "root-thing" })] }));
        }
        return new Promise<HealthSnapshot>(() => {
          released = true;
        });
      }),
    };

    const { result, rerender } = renderHook(
      ({ file }: { file: string }) =>
        useHealth({ project: "infra", root: "/w/infra", file }, null, health),
      { initialProps: { file: "deploy.yaml" } },
    );
    await waitFor(() => {
      expect(result.current.snapshot.objects).toHaveLength(1);
    });

    rerender({ file: "prod/app.yaml" });

    expect(result.current.snapshot.objects).toHaveLength(0);
    await waitFor(() => {
      expect(released).toBe(true);
    });
  });

  it("reports a failure of the bridge itself", async () => {
    const health: Health = {
      snapshot: vi.fn(() => Promise.reject(new Error("the backend is not reachable"))),
    };
    const { result } = renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, null, health),
    );

    await waitFor(() => {
      expect(result.current.error).toBe("the backend is not reachable");
    });
  });

  it("renders a rejection that is not an Error", async () => {
    const health: Health = { snapshot: vi.fn(() => Promise.reject("nope")) };
    const { result } = renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, null, health),
    );

    await waitFor(() => {
      expect(result.current.error).toBe("nope");
    });
  });

  it("clears a previous failure once a read succeeds", async () => {
    let fail = true;
    const health: Health = {
      snapshot: vi.fn(() => {
        if (fail) {
          return Promise.reject(new Error("down"));
        }
        return Promise.resolve(snapshot({ objects: [object()] }));
      }),
    };
    const { result } = renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, null, health),
    );
    await waitFor(() => {
      expect(result.current.error).toBe("down");
    });

    fail = false;
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
    expect(result.current.snapshot.objects).toHaveLength(1);
  });
});

describe("following the event channel", () => {
  it("re-asks when the backend says this project's health may be stale", async () => {
    const health = fakeHealth({ "infra|deploy.yaml": snapshot({ objects: [object()] }) });
    const { factory, sockets } = fakeSocketFactory();

    renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, endpoint, health, factory),
    );
    await waitFor(() => {
      expect(health.snapshot).toHaveBeenCalledTimes(1);
    });

    act(() => {
      sockets[0].onmessage?.(healthEvent("/w/infra"));
    });

    await waitFor(() => {
      expect(health.snapshot).toHaveBeenCalledTimes(2);
    });
  });

  // Every project publishes onto one channel, so a message has to be matched
  // against the checkout this hook is showing.
  it("ignores an event for another project", async () => {
    const health = fakeHealth({ "infra|deploy.yaml": snapshot({ objects: [object()] }) });
    const { factory, sockets } = fakeSocketFactory();

    renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, endpoint, health, factory),
    );
    await waitFor(() => {
      expect(health.snapshot).toHaveBeenCalledTimes(1);
    });

    act(() => {
      sockets[0].onmessage?.(healthEvent("/w/other"));
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(health.snapshot).toHaveBeenCalledTimes(1);
  });

  it("opens no socket without an endpoint", () => {
    const { factory } = fakeSocketFactory();
    renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, null, fakeHealth({}), factory),
    );

    expect(factory).not.toHaveBeenCalled();
  });

  it("closes its socket on unmount", async () => {
    const { factory, sockets } = fakeSocketFactory();
    const { unmount } = renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, endpoint, fakeHealth({}), factory),
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    unmount();

    expect(sockets[0].close).toHaveBeenCalled();
  });

  // A rollout produces a steady stream of events even after the backend's own
  // rate limit. One read in flight and one queued is what keeps that from
  // becoming one bridge call per API-server observation.
  it("coalesces a burst of events into one trailing re-read", async () => {
    let pending: ((value: HealthSnapshot) => void) | null = null;
    let calls = 0;
    const health: Health = {
      snapshot: vi.fn(() => {
        calls++;
        return new Promise<HealthSnapshot>((resolve) => {
          pending = resolve;
        });
      }),
    };
    const { factory, sockets } = fakeSocketFactory();

    renderHook(() =>
      useHealth({ project: "infra", root: "/w/infra", file: "deploy.yaml" }, endpoint, health, factory),
    );
    await waitFor(() => {
      expect(calls).toBe(1);
    });

    act(() => {
      for (let i = 0; i < 5; i++) {
        sockets[0].onmessage?.(healthEvent("/w/infra"));
      }
    });
    // Still one: the five events queued behind the read in flight.
    expect(calls).toBe(1);

    const resolve = pending as unknown as (value: HealthSnapshot) => void;
    await act(async () => {
      resolve(snapshot());
      await Promise.resolve();
    });

    // Exactly one re-read for the five, not five.
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(2);
  });
});
