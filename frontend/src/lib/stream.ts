import type { stream } from "../../wailsjs/go/models";

/**
 * Discovery and connection for the loopback stream server
 * (`internal/stream/PROTOCOL.md` §1–§2).
 *
 * The port and token are minted per launch and reach the frontend over the
 * Wails bridge and nowhere else, so nothing here logs them — an endpoint in a
 * console line outlives the launch it was minted for.
 */

/**
 * Where the stream server is listening, and the credential it requires.
 *
 * Aliased from the generated binding rather than restated, so a change to the
 * Go struct fails type-checking here instead of silently disagreeing.
 */
export type Endpoint = stream.Endpoint;

/**
 * The subprotocol the server selects. A browser that offers subprotocols
 * requires the server to select one, so the version travels alongside the
 * credential rather than being implied (§2).
 */
const VERSION_SUBPROTOCOL = "m6t.v1";

/**
 * Prefix that carries the bearer credential. The browser WebSocket API cannot
 * set request headers, so the token rides in the subprotocol list — the same
 * mechanism the Kubernetes API server accepts a credential through.
 */
const TOKEN_SUBPROTOCOL_PREFIX = "m6t.token.";

/** The socket URL for one terminal session (§4). */
export function terminalURL(endpoint: Endpoint, sessionID: string): string {
  return `ws://127.0.0.1:${String(endpoint.port)}/pty/${encodeURIComponent(sessionID)}`;
}

/** The subprotocol list every connection must offer (§2). */
export function subprotocols(endpoint: Endpoint): string[] {
  return [VERSION_SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + endpoint.token];
}

/** How a socket is constructed, injectable so tests need no live server. */
export type SocketFactory = (url: string, protocols: string[]) => WebSocket;

const defaultSocketFactory: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols);

/** Opens a WebSocket to a terminal session, ready to carry binary frames. */
export function openTerminalSocket(
  endpoint: Endpoint,
  sessionID: string,
  create: SocketFactory = defaultSocketFactory,
): WebSocket {
  const socket = create(
    terminalURL(endpoint, sessionID),
    subprotocols(endpoint),
  );
  // PTY output is raw bytes. Without this the runtime delivers them as Blobs,
  // which are only readable asynchronously — long enough to let a later control
  // frame overtake the output it was meant to follow.
  socket.binaryType = "arraybuffer";
  return socket;
}
