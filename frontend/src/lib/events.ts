import type { Endpoint } from "./stream";
import { subprotocols } from "./stream";
import { decodeServerMessage } from "./protocol";

/**
 * The frontend's connection to the backend-push event channel
 * (`internal/stream/PROTOCOL.md` §4, `/events`).
 *
 * This is the first frontend consumer of `/events` — PTY exit already
 * reaches a terminal tab over its own session socket, so nothing here read
 * this channel before the file tree needed it (§5's `tree` message).
 *
 * Reconnection is deliberately out of scope: the listener is one long-lived
 * loopback process this app itself started, so a drop here means the
 * backend restarted, which is not a state the rest of the app recovers from
 * silently either. A caller that wants resilience against that reopens the
 * socket the same way it opened the first one — on a fresh mount, the same
 * shape `useFileTree` already uses when its project changes.
 */

/** The socket URL for the event channel (§4). */
export function eventsURL(endpoint: Endpoint): string {
  return `ws://127.0.0.1:${String(endpoint.port)}/events`;
}

/** How a socket is constructed, injectable so tests need no live server. */
export type SocketFactory = (url: string, protocols: string[]) => WebSocket;

const defaultSocketFactory: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols);

/**
 * Opens the event socket and invokes onTree for every `tree` message it
 * decodes (§5). Every other message type — `exit`, and anything a future
 * backend version adds — is dropped here: an event type this frontend does
 * not yet handle is not an error (§5), and `exit` already has its own
 * consumer on the terminal socket it was published alongside.
 */
export function openEventsSocket(
  endpoint: Endpoint,
  onTree: (root: string, dirs: string[]) => void,
  create: SocketFactory = defaultSocketFactory,
): WebSocket {
  const socket = create(eventsURL(endpoint), subprotocols(endpoint));
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = decodeServerMessage(event.data);
    if (message?.type === "tree") {
      onTree(message.root, message.dirs);
    }
  };
  return socket;
}
