/**
 * The frontend half of the stream wire contract, specified in
 * `internal/stream/PROTOCOL.md` §5. The spec is the source of truth: a change
 * there is a change here, and the tests next to this file are written against
 * the tables in it rather than against this implementation.
 */

/** Envelope type names the server understands on a terminal socket. */
const TYPE_RESIZE = "resize";
const TYPE_CLOSE = "close";

/** Envelope type names the server sends. */
const TYPE_EXIT = "exit";
const TYPE_RESYNC = "resync";
const TYPE_TREE = "tree";

/**
 * Tells the backend what window size the child should see. Sent whenever the
 * pane's measured geometry changes (§5, client to server).
 */
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: TYPE_RESIZE, payload: { cols, rows } });
}

/**
 * Ends the session and its child. Closing the socket does NOT do this — PTYs
 * are backend-owned and survive a reload — so this is the only way a tab kills
 * the shell it opened (§4).
 */
export function closeFrame(): string {
  return JSON.stringify({ type: TYPE_CLOSE });
}

/** A control message from the server (§5, server to client). */
export type ServerMessage =
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "resync"; readonly droppedBytes: number }
  | { readonly type: "tree"; readonly root: string; readonly dirs: string[] };

/**
 * Decodes a text frame, returning null for anything this version does not
 * understand.
 *
 * Null means "ignore", not "error": §5 requires an unknown or undecodable
 * envelope to be dropped rather than treated as a protocol violation, which is
 * what lets either side add a message without the other being updated in
 * lockstep. A caller must not close the socket on null.
 */
export function decodeServerMessage(raw: string): ServerMessage | null {
  const envelope = parseEnvelope(raw);
  if (!envelope) {
    return null;
  }
  switch (envelope.type) {
    case TYPE_EXIT:
      return withNumber(envelope.payload, "code", (code) => ({
        type: "exit",
        code,
      }));
    case TYPE_RESYNC:
      return withNumber(envelope.payload, "droppedBytes", (droppedBytes) => ({
        type: "resync",
        droppedBytes,
      }));
    case TYPE_TREE:
      return withTreePayload(envelope.payload, (root, dirs) => ({
        type: "tree",
        root,
        dirs,
      }));
    default:
      return null;
  }
}

/** The shape every frame shares: a type, and a payload some types omit. */
interface Envelope {
  readonly type: string;
  readonly payload?: unknown;
}

/**
 * Parses a frame far enough to read its type. A frame that is not JSON, or not
 * an object, or carries no string type, is not a frame this side can act on.
 */
function parseEnvelope(raw: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string") {
    return null;
  }
  return { type, payload: (parsed as Record<string, unknown>).payload };
}

/**
 * Applies `build` to a numeric payload field, or returns null when the field is
 * missing or not a number.
 *
 * A malformed payload is dropped for the same reason an unknown type is: a
 * message that cannot be read is not a message, and an exit "code" of undefined
 * rendered into a tab would report a shell that ended when it did not.
 */
function withNumber<T>(
  payload: unknown,
  field: string,
  build: (value: number) => T,
): T | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "number" ? build(value) : null;
}

/**
 * Applies `build` to a `{root, dirs}` payload, or returns null when either
 * field is missing or malformed — the same "drop rather than half-apply"
 * rule withNumber follows.
 */
function withTreePayload<T>(
  payload: unknown,
  build: (root: string, dirs: string[]) => T,
): T | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const root = record.root;
  const dirs = record.dirs;
  if (typeof root !== "string" || !Array.isArray(dirs)) {
    return null;
  }
  if (!dirs.every((d): d is string => typeof d === "string")) {
    return null;
  }
  return build(root, dirs);
}
