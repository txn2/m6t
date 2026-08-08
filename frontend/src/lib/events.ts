import type { Endpoint } from "./stream";
import { subprotocols } from "./stream";
import type { ServerMessage } from "./protocol";
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
 * What a caller wants off the channel. Every handler is optional because
 * consumers subscribe to different messages — the file tree wants `tree`, the
 * git status wants `git` — and each opens its own socket rather than sharing
 * one, so that a consumer unmounting closes only what it opened.
 */
export interface EventHandlers {
  readonly onTree?: (root: string, dirs: string[]) => void;
  readonly onGit?: (root: string) => void;
  readonly onHealth?: (root: string) => void;
}

/**
 * Opens the event socket and dispatches the messages `handlers` asks for
 * (§5). Everything else — `exit`, a message a handler was not given for, and
 * anything a future backend version adds — is dropped here: an event type
 * this frontend does not yet handle is not an error (§5), and `exit` already
 * has its own consumer on the terminal socket it was published alongside.
 */
export function openEventsSocket(
  endpoint: Endpoint,
  handlers: EventHandlers,
  create: SocketFactory = defaultSocketFactory,
): WebSocket {
  const socket = create(eventsURL(endpoint), subprotocols(endpoint));
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = decodeServerMessage(event.data);
    if (message !== null) {
      dispatch(message, handlers);
    }
  };
  return socket;
}

/**
 * Hands one decoded message to the handler it belongs to.
 *
 * A switch rather than a chain of type tests, so that adding a message type is
 * one case rather than one more branch in the socket callback — which is where
 * the third event type took that callback past its complexity budget.
 */
function dispatch(message: ServerMessage, handlers: EventHandlers): void {
  switch (message.type) {
    case "tree":
      handlers.onTree?.(message.root, message.dirs);
      break;
    case "git":
      handlers.onGit?.(message.root);
      break;
    case "health":
      handlers.onHealth?.(message.root);
      break;
    default:
      // `exit` and `resync` have their own consumer on the terminal socket
      // they are published alongside; anything else is a type a later backend
      // added, which §5 requires be dropped rather than treated as an error.
      break;
  }
}
