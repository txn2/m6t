import { closeFrame, decodeServerMessage, resizeFrame } from "./protocol";

/**
 * One terminal tab's session: the PTY it asked the backend for, the socket
 * carrying its character stream, and the rules for what happens when either
 * ends.
 *
 * Deliberately free of both React and xterm.js. The renderer arrives as a
 * `TerminalHandle` and the socket as a `SocketHandle`, so everything decided
 * here — when input is queued, what a resync does, which close ends the shell
 * and which one only detaches — is exercised by tests instead of by a live
 * shell in a live window.
 */

/** What a session needs from a mounted terminal renderer. */
export interface TerminalHandle {
  /** Measured geometry, valid after `fit`. */
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string): void;
  /** Keystrokes, pastes and IME output, as the child should receive them. */
  onData(listener: (data: string) => void): void;
  /** Clears the screen and the scrollback, cursor home. */
  reset(): void;
  /** Recomputes cols/rows from the element's current size. */
  fit(): void;
  dispose(): void;
}

/**
 * The socket surface a session uses. The browser `WebSocket` satisfies it
 * structurally; declaring only what is used keeps the fakes in the tests honest
 * about the difference.
 */
export interface SocketHandle {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** `WebSocket.OPEN`, named rather than spelled 1 at the call site. */
const SOCKET_OPEN = 1;

/** Where a session is, as the tab strip and the pane render it. */
export type SessionStatus =
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "failed"; readonly message: string };

export interface SessionOptions {
  readonly terminal: TerminalHandle;
  /** Asks the backend for a PTY of this size; resolves to its session id. */
  open: (cols: number, rows: number) => Promise<string>;
  /** Opens the stream socket for a session id. */
  connect: (sessionID: string) => SocketHandle;
  /**
   * A line typed into the shell once it produces its first output. This is the
   * whole of the "Claude Code" action: the tab is an ordinary shell, so when
   * the program ends the user is left in one rather than in a dead tab.
   */
  readonly autorun?: string | null;
  onStatus: (status: SessionStatus) => void;
}

export class TerminalSession {
  private readonly options: SessionOptions;
  private socket: SocketHandle | null = null;
  private sessionID: string | null = null;

  /** Keystrokes typed before the socket opened. */
  private readonly pending: string[] = [];

  /** A close requested before there was a socket to request it on. */
  private closeRequested = false;

  /** Set once the child's exit status has been seen, so the socket closing
   * behind it is expected rather than a lost connection. */
  private ended = false;

  /** Set by dispose: nothing after it may touch the terminal or report. */
  private disposed = false;

  /** Cleared once the autorun line has been typed, so it is typed once. */
  private autorun: string | null;

  constructor(options: SessionOptions) {
    this.options = options;
    this.autorun = options.autorun ?? null;
  }

  /**
   * Sizes the terminal, asks for a PTY and attaches to it.
   *
   * The size is measured first so the shell's first prompt is drawn at the
   * pane's real width — a session created at the 80x24 default and resized
   * afterwards wraps its first line and never redraws it.
   */
  async start(): Promise<void> {
    this.options.terminal.onData((data) => {
      this.send(data);
    });
    this.options.terminal.fit();

    let id: string;
    try {
      id = await this.options.open(
        this.options.terminal.cols,
        this.options.terminal.rows,
      );
    } catch (error: unknown) {
      this.report({ kind: "failed", message: describe(error) });
      return;
    }
    this.sessionID = id;

    // The pane went away while the backend was still creating the PTY. A
    // session that was never attached to is unreachable — this side is the only
    // thing that ever held its identifier — so it is ended rather than left,
    // whether or not anyone asked. Once a socket HAS been attached the opposite
    // rule applies: unmounting detaches and the shell survives (PROTOCOL.md
    // §4). React's development double-mount takes this path on every tab.
    if (this.disposed) {
      this.closeRequested = true;
      this.attach(id);
      this.deliverPendingClose();
      return;
    }

    this.attach(id);
    this.report({ kind: "running" });
  }

  /** Re-measures the terminal and tells the child its new window size. */
  resize(): void {
    this.options.terminal.fit();
    this.control(
      resizeFrame(this.options.terminal.cols, this.options.terminal.rows),
    );
  }

  /**
   * Ends the session and its child.
   *
   * Closing the socket would not do this — PTYs are backend-owned and outlive
   * their connections (PROTOCOL.md §4) — so a tab the user closes has to say so
   * explicitly, and a tab closed before its socket opened has to remember to.
   */
  close(): void {
    this.closeRequested = true;
    this.control(closeFrame());
  }

  /**
   * Detaches without ending the session: the child keeps running, and the
   * scrollback is replayed to whoever attaches next.
   */
  dispose(): void {
    this.disposed = true;
    if (this.deliverPendingClose()) {
      this.socket = null;
    } else {
      this.detach();
    }
    this.options.terminal.dispose();
  }

  /**
   * Keeps a socket alive just long enough to deliver a close nobody could send
   * yet, and reports whether it did.
   *
   * A tab closed in the moment between asking for a session and the socket
   * opening would otherwise leave the shell running with nothing attached to
   * it: the request to end it was made, and detaching here is what would throw
   * it away.
   */
  private deliverPendingClose(): boolean {
    const socket = this.socket;
    if (!socket || !this.closeRequested || socket.readyState === SOCKET_OPEN) {
      return false;
    }
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onopen = () => {
      socket.send(closeFrame());
      socket.close();
    };
    return true;
  }

  /** Attaches to a session's stream socket and wires the handlers. */
  private attach(sessionID: string): void {
    const socket = this.options.connect(sessionID);
    this.socket = socket;

    socket.onopen = () => {
      this.flush();
    };
    socket.onmessage = (event) => {
      this.receive(event.data);
    };
    socket.onclose = () => {
      this.lost();
    };
    socket.onerror = () => {
      this.lost();
    };
  }

  /** Drops the current socket without disturbing the session behind it. */
  private detach(): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }

  /** Sends everything that was typed or requested while the socket came up. */
  private flush(): void {
    this.resize();
    for (const data of this.pending.splice(0)) {
      this.send(data);
    }
    if (this.closeRequested) {
      this.control(closeFrame());
    }
  }

  /** Routes one frame: binary is the character stream, text is control. */
  private receive(data: unknown): void {
    if (typeof data === "string") {
      this.handleControl(data);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.options.terminal.write(new Uint8Array(data));
      this.typeAutorun();
    }
  }

  private handleControl(raw: string): void {
    const message = decodeServerMessage(raw);
    if (!message) {
      // Unknown or undecodable frames are ignored, never fatal (§5).
      return;
    }
    if (message.type === "exit") {
      this.ended = true;
      this.report({ kind: "exited", code: message.code });
      return;
    }
    this.resync();
  }

  /**
   * Recovers from dropped output.
   *
   * A resync means the character stream has a hole in it, and escape sequences
   * do not survive truncation — so painting on is how a terminal ends up with a
   * corrupted screen it never repairs. The correct response is the one the
   * protocol names: throw the screen away and attach again, which replays the
   * session's scrollback from the backend (§6).
   */
  private resync(): void {
    const id = this.sessionID;
    if (!id) {
      return;
    }
    this.detach();
    this.options.terminal.reset();
    this.attach(id);
  }

  /** Types the autorun line, once, after the shell's first output. */
  private typeAutorun(): void {
    const line = this.autorun;
    if (line === null) {
      return;
    }
    this.autorun = null;
    this.send(`${line}\n`);
  }

  /** Sends input to the child, queueing it until the socket is open. */
  private send(data: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.pending.push(data);
      return;
    }
    socket.send(ENCODER.encode(data));
  }

  /** Sends a control frame, dropping it when there is no open socket. */
  private control(frame: string): void {
    const socket = this.socket;
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.send(frame);
    }
  }

  /**
   * The socket went away.
   *
   * After an exit frame that is the server closing behind the status it just
   * reported, which is normal. Before one it means the backend is gone, and a
   * tab that kept showing a live cursor over a dead PTY would take keystrokes
   * that reach nothing.
   */
  private lost(): void {
    if (this.ended || this.disposed) {
      return;
    }
    this.ended = true;
    this.report({
      kind: "failed",
      message: "the connection to this terminal was lost",
    });
  }

  private report(status: SessionStatus): void {
    if (!this.disposed) {
      this.options.onStatus(status);
    }
  }
}

/** Input is UTF-8 bytes on the wire: binary frames are the child's stdin. */
const ENCODER = new TextEncoder();

/** Renders a thrown value as the sentence a tab shows in its failed state. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the terminal could not be opened";
}
