import { describe, expect, it, vi } from "vitest";
import type { Endpoint } from "./stream";
import { openTerminalSocket, subprotocols, terminalURL } from "./stream";

const endpoint: Endpoint = { port: 51234, token: "K7QF2VXYZ" };

describe("stream discovery", () => {
  // PROTOCOL.md §1: the listener binds 127.0.0.1. Connecting by name would let
  // a hosts-file entry or a DNS answer put the terminal socket somewhere else.
  it("addresses the loopback listener by literal address", () => {
    expect(terminalURL(endpoint, "pty-3")).toBe(
      "ws://127.0.0.1:51234/pty/pty-3",
    );
  });

  it("escapes a session id rather than pasting it into the path", () => {
    expect(terminalURL(endpoint, "pty/../events")).toBe(
      "ws://127.0.0.1:51234/pty/pty%2F..%2Fevents",
    );
  });

  // §2: the browser WebSocket API cannot set headers, so the token rides as a
  // subprotocol — and the version has to ride with it, because a browser that
  // offers subprotocols requires the server to select one.
  it("offers the version and the token, in that order", () => {
    expect(subprotocols(endpoint)).toEqual(["m6t.v1", "m6t.token.K7QF2VXYZ"]);
  });
});

describe("opening a terminal socket", () => {
  it("connects to the session's endpoint with the credential", () => {
    const socket = { binaryType: "blob" } as WebSocket;
    const create = vi.fn().mockReturnValue(socket);

    openTerminalSocket(endpoint, "pty-9", create);

    expect(create).toHaveBeenCalledWith("ws://127.0.0.1:51234/pty/pty-9", [
      "m6t.v1",
      "m6t.token.K7QF2VXYZ",
    ]);
  });

  // Blobs are only readable asynchronously, which is long enough for a control
  // frame to overtake the output it was meant to follow.
  it("takes binary frames as buffers rather than blobs", () => {
    const socket = { binaryType: "blob" } as WebSocket;

    openTerminalSocket(endpoint, "pty-9", () => socket);

    expect(socket.binaryType).toBe("arraybuffer");
  });
});
