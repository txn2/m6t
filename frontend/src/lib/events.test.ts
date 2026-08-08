import { describe, expect, it, vi } from "vitest";
import type { Endpoint } from "./stream";
import { eventsURL, openEventsSocket } from "./events";

const endpoint: Endpoint = { port: 51234, token: "K7QF2VXYZ" };

describe("the event socket's address", () => {
  // PROTOCOL.md §4: /events, on the same loopback listener as everything else.
  it("addresses the loopback listener's /events path", () => {
    expect(eventsURL(endpoint)).toBe("ws://127.0.0.1:51234/events");
  });
});

describe("opening the event socket", () => {
  it("connects with the version and token subprotocols", () => {
    const socket = {} as WebSocket;
    const create = vi.fn().mockReturnValue(socket);

    openEventsSocket(endpoint, {}, create);

    expect(create).toHaveBeenCalledWith("ws://127.0.0.1:51234/events", [
      "m6t.v1",
      "m6t.token.K7QF2VXYZ",
    ]);
  });

  it("invokes onTree for a decoded tree message", () => {
    const socket = {} as WebSocket;
    const onTree = vi.fn();

    openEventsSocket(endpoint, { onTree }, () => socket);
    socket.onmessage?.({
      data: '{"type":"tree","payload":{"root":"/repo","dirs":[".","manifests"]}}',
    } as MessageEvent<string>);

    expect(onTree).toHaveBeenCalledWith("/repo", [".", "manifests"]);
  });

  // §4/§5: exit already has its own consumer (the terminal's own socket), and
  // an unrecognized type is dropped by design — neither should reach onTree.
  it.each([
    ["an exit message", '{"type":"exit","payload":{"code":0}}'],
    ["an unrecognized type", '{"type":"projectOpened"}'],
    ["a non-JSON frame", "not json"],
  ])("ignores %s", (_name, raw) => {
    const socket = {} as WebSocket;
    const onTree = vi.fn();

    openEventsSocket(endpoint, { onTree }, () => socket);
    socket.onmessage?.({ data: raw } as MessageEvent<string>);

    expect(onTree).not.toHaveBeenCalled();
  });

  it("invokes onGit for a decoded git message", () => {
    const socket = {} as WebSocket;
    const onGit = vi.fn();

    openEventsSocket(endpoint, { onGit }, () => socket);
    socket.onmessage?.({
      data: '{"type":"git","payload":{"root":"/repo"}}',
    } as MessageEvent<string>);

    expect(onGit).toHaveBeenCalledWith("/repo");
  });

  it("invokes onHealth for a decoded health message", () => {
    const socket = {} as WebSocket;
    const onHealth = vi.fn();

    openEventsSocket(endpoint, { onHealth }, () => socket);
    socket.onmessage?.({
      data: '{"type":"health","payload":{"root":"/repo"}}',
    } as MessageEvent<string>);

    expect(onHealth).toHaveBeenCalledWith("/repo");
  });

  // The messages are dispatched independently: a consumer that asked for one
  // must not be woken by another, which is the whole reason the tree, the git
  // status and the health panel open their own sockets.
  it("does not invoke a handler another message type belongs to", () => {
    const socket = {} as WebSocket;
    const onTree = vi.fn();
    const onGit = vi.fn();
    const onHealth = vi.fn();

    openEventsSocket(endpoint, { onTree, onGit, onHealth }, () => socket);
    socket.onmessage?.({
      data: '{"type":"git","payload":{"root":"/repo"}}',
    } as MessageEvent<string>);

    expect(onGit).toHaveBeenCalledOnce();
    expect(onTree).not.toHaveBeenCalled();
    expect(onHealth).not.toHaveBeenCalled();
  });

  // A socket opened with no handler for a type that arrives must not throw:
  // the tree's socket receives every git event the backend publishes.
  it("drops a message no handler was given for", () => {
    const socket = {} as WebSocket;

    openEventsSocket(endpoint, {}, () => socket);

    expect(() => {
      socket.onmessage?.({
        data: '{"type":"git","payload":{"root":"/repo"}}',
      } as MessageEvent<string>);
    }).not.toThrow();
  });

  it("ignores a non-string message payload", () => {
    const socket = {} as WebSocket;
    const onTree = vi.fn();

    openEventsSocket(endpoint, { onTree }, () => socket);
    socket.onmessage?.({ data: new ArrayBuffer(0) } as MessageEvent<unknown>);

    expect(onTree).not.toHaveBeenCalled();
  });
});
