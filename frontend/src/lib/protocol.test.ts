import { describe, expect, it } from "vitest";
import { closeFrame, decodeServerMessage, resizeFrame } from "./protocol";

/**
 * These are written against the tables in internal/stream/PROTOCOL.md §5, not
 * against the implementation: the point of a specified wire format is that both
 * sides can be checked against the spec rather than against each other.
 */
describe("frames sent to the server", () => {
  it("encodes a resize as the server's control envelope", () => {
    expect(JSON.parse(resizeFrame(120, 40))).toEqual({
      type: "resize",
      payload: { cols: 120, rows: 40 },
    });
  });

  it("encodes a close with no payload", () => {
    expect(JSON.parse(closeFrame())).toEqual({ type: "close" });
  });
});

describe("frames received from the server", () => {
  it("reads an exit status", () => {
    expect(
      decodeServerMessage('{"type":"exit","payload":{"code":130}}'),
    ).toEqual({ type: "exit", code: 130 });
  });

  it("reads the signal case, which the protocol spells -1", () => {
    expect(decodeServerMessage('{"type":"exit","payload":{"code":-1}}')).toEqual(
      { type: "exit", code: -1 },
    );
  });

  it("reads a resync and the bytes it says were dropped", () => {
    expect(
      decodeServerMessage('{"type":"resync","payload":{"droppedBytes":4096}}'),
    ).toEqual({ type: "resync", droppedBytes: 4096 });
  });

  // §5: an envelope whose type is unknown, or which does not decode, is
  // ignored — not an error, and not a reason to close the connection. Each of
  // these must come back null rather than throw or produce a partial message.
  it.each([
    ["not JSON at all", "this is not json"],
    ["a JSON scalar", '"exit"'],
    ["null", "null"],
    ["an envelope with no type", '{"payload":{"code":0}}'],
    ["a non-string type", '{"type":7}'],
    ["a type from a later protocol version", '{"type":"projectOpened"}'],
    ["an exit with no payload", '{"type":"exit"}'],
    ["an exit whose code is not a number", '{"type":"exit","payload":{"code":"0"}}'],
    ["a resync with no count", '{"type":"resync","payload":{}}'],
  ])("ignores %s", (_name, raw) => {
    expect(decodeServerMessage(raw)).toBeNull();
  });

  // A projectID at the top level is reserved for #5 and a decoder must tolerate
  // it today, so a frame carrying one still has to read correctly.
  it("tolerates the reserved top-level field", () => {
    expect(
      decodeServerMessage(
        '{"type":"exit","projectID":"p1","payload":{"code":0}}',
      ),
    ).toEqual({ type: "exit", code: 0 });
  });
});
