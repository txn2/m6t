import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionStatus,
  SocketHandle,
  TerminalHandle,
} from "./terminalSession";
import { TerminalSession } from "./terminalSession";

/**
 * The session rules, exercised without a shell, a socket or a canvas.
 *
 * Every one of these is a case that is either invisible or unreproducible in a
 * live window: output dropped under backpressure, a socket that closes without
 * an exit, a tab closed in the moment before its socket opened.
 */

class FakeTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  written: string[] = [];
  listener: ((data: string) => void) | null = null;
  resets = 0;
  fits = 0;
  disposed = false;

  write(data: Uint8Array | string): void {
    this.written.push(
      typeof data === "string" ? data : new TextDecoder().decode(data),
    );
  }
  onData(listener: (data: string) => void): void {
    this.listener = listener;
  }
  reset(): void {
    this.resets += 1;
  }
  fit(): void {
    this.fits += 1;
  }
  dispose(): void {
    this.disposed = true;
  }

  /** What the child would have received on its stdin. */
  type(data: string): void {
    this.listener?.(data);
  }
}

class FakeSocket implements SocketHandle {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(
      typeof data === "string"
        ? data
        : new TextDecoder().decode(data as Uint8Array),
    );
  }
  close(): void {
    this.closed = true;
  }

  /** The handshake completing. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  /** A frame arriving: a string is control, an ArrayBuffer is the stream. */
  deliver(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  /** The socket going away underneath the session. */
  drop(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

/**
 * One binary frame, as the socket delivers it.
 *
 * The buffer is built from this realm's ArrayBuffer rather than handed over
 * from the encoder's: under jsdom the injected TextEncoder belongs to Node, and
 * a buffer from another realm fails `instanceof` in a way no browser does.
 */
const bytes = (text: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
};

const exitFrame = (code: number) =>
  JSON.stringify({ type: "exit", payload: { code } });
const resyncFrame = (droppedBytes: number) =>
  JSON.stringify({ type: "resync", payload: { droppedBytes } });

interface Harness {
  terminal: FakeTerminal;
  sockets: FakeSocket[];
  socket: () => FakeSocket;
  statuses: SessionStatus[];
  open: ReturnType<typeof vi.fn>;
  session: TerminalSession;
}

let harness: Harness;

function build(options: {
  autorun?: string;
  open?: () => Promise<string>;
}): Harness {
  const terminal = new FakeTerminal();
  const sockets: FakeSocket[] = [];
  const statuses: SessionStatus[] = [];
  const open = vi.fn(options.open ?? (() => Promise.resolve("pty-7")));

  const session = new TerminalSession({
    terminal,
    open: open as unknown as (cols: number, rows: number) => Promise<string>,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    autorun: options.autorun ?? null,
    onStatus: (status) => statuses.push(status),
  });

  return {
    terminal,
    sockets,
    socket: () => sockets[sockets.length - 1],
    statuses,
    open,
    session,
  };
}

beforeEach(() => {
  harness = build({});
});

describe("starting a session", () => {
  // A session created at the 80x24 default and resized afterwards wraps its
  // first prompt and never redraws it.
  it("measures the pane before asking for a PTY", async () => {
    harness.terminal.cols = 143;
    harness.terminal.rows = 37;

    await harness.session.start();

    expect(harness.terminal.fits).toBeGreaterThan(0);
    expect(harness.open).toHaveBeenCalledWith(143, 37);
  });

  it("reports running once it is attached", async () => {
    await harness.session.start();

    expect(harness.statuses).toEqual([{ kind: "running" }]);
    expect(harness.sockets).toHaveLength(1);
  });

  it("reports why it could not start, and does not connect", async () => {
    const failing = build({
      open: () => Promise.reject(new Error("chdir /nope: no such file")),
    });

    await failing.session.start();

    expect(failing.statuses).toEqual([
      { kind: "failed", message: "chdir /nope: no such file" },
    ]);
    expect(failing.sockets).toHaveLength(0);
  });
});

describe("carrying the character stream", () => {
  beforeEach(async () => {
    await harness.session.start();
    harness.socket().open();
  });

  it("writes the server's binary frames to the terminal", () => {
    harness.socket().deliver(bytes("m6t $ "));

    expect(harness.terminal.written).toEqual(["m6t $ "]);
  });

  it("sends keystrokes to the child as bytes", () => {
    harness.terminal.type("kubectl get pods\n");

    expect(harness.socket().sent).toContain("kubectl get pods\n");
  });

  it("tells the child its size once the socket is up", () => {
    expect(harness.socket().sent).toContain(
      JSON.stringify({ type: "resize", payload: { cols: 80, rows: 24 } }),
    );
  });

  it("re-measures and reports a new size when the pane changes", () => {
    harness.terminal.cols = 200;
    harness.terminal.rows = 60;

    harness.session.resize();

    expect(harness.socket().sent).toContain(
      JSON.stringify({ type: "resize", payload: { cols: 200, rows: 60 } }),
    );
  });
});

describe("input typed before the socket is up", () => {
  it("is queued rather than dropped", async () => {
    await harness.session.start();

    harness.terminal.type("whoami\n");
    expect(harness.socket().sent).toEqual([]);

    harness.socket().open();
    expect(harness.socket().sent).toContain("whoami\n");
  });
});

describe("how a session ends", () => {
  beforeEach(async () => {
    await harness.session.start();
    harness.socket().open();
  });

  it("reports the child's exit status", () => {
    harness.socket().deliver(exitFrame(130));

    expect(harness.statuses).toContainEqual({ kind: "exited", code: 130 });
  });

  // The server closes the socket after writing the exit frame. Reporting that
  // as a lost connection would overwrite the status the user needs.
  it("treats the close that follows an exit as expected", () => {
    harness.socket().deliver(exitFrame(0));
    harness.socket().drop();

    expect(harness.statuses).toEqual([
      { kind: "running" },
      { kind: "exited", code: 0 },
    ]);
  });

  it("reports a socket that goes away without an exit", () => {
    harness.socket().drop();

    expect(harness.statuses).toContainEqual({
      kind: "failed",
      message: "the connection to this terminal was lost",
    });
  });

  // PROTOCOL.md §4: closing the socket does not end a PTY. Only this does.
  it("ends the PTY with a close frame", () => {
    harness.session.close();

    expect(harness.socket().sent).toContain(JSON.stringify({ type: "close" }));
  });

  // Unmounting a pane — a tab switch, a hot reload — must leave the shell and
  // whatever it is running alone.
  it("detaches without ending the session", () => {
    harness.session.dispose();

    expect(harness.socket().closed).toBe(true);
    expect(harness.socket().sent).not.toContain(
      JSON.stringify({ type: "close" }),
    );
    expect(harness.terminal.disposed).toBe(true);
  });

  it("stops reporting once disposed", () => {
    harness.session.dispose();
    const after = harness.statuses.length;

    harness.socket().drop();

    expect(harness.statuses).toHaveLength(after);
  });
});

describe("a tab closed while its PTY was still being created", () => {
  // The shell exists by then, and nothing else knows its identifier: dropping
  // the request here leaves a process running with no tab attached to it.
  it("opens a socket for the sole purpose of ending it", async () => {
    let created: (id: string) => void = () => undefined;
    const slow = build({
      open: () =>
        new Promise<string>((resolve) => {
          created = resolve;
        }),
    });

    const starting = slow.session.start();
    slow.session.close();
    slow.session.dispose();
    created("pty-11");
    await starting;

    expect(slow.sockets).toHaveLength(1);
    slow.socket().open();
    expect(slow.socket().sent).toEqual([JSON.stringify({ type: "close" })]);
    expect(slow.socket().closed).toBe(true);
  });

  // Nobody asked to close this one — the pane merely went away, which React's
  // development double-mount does to every tab. It still has to be ended: this
  // side held the only copy of the identifier, so a session never attached to
  // is one nothing can ever reach again.
  it("ends a session nothing ever attached to, asked or not", async () => {
    let created: (id: string) => void = () => undefined;
    const slow = build({
      open: () =>
        new Promise<string>((resolve) => {
          created = resolve;
        }),
    });

    const starting = slow.session.start();
    slow.session.dispose();
    created("pty-12");
    await starting;

    slow.socket().open();
    expect(slow.socket().sent).toEqual([JSON.stringify({ type: "close" })]);
    expect(slow.statuses).toEqual([]);
  });
});

describe("a tab closed before its socket opened", () => {
  // Otherwise the request to end the shell is thrown away with the socket, and
  // the PTY runs on with nothing attached to it.
  it("still delivers the close once the socket comes up", async () => {
    await harness.session.start();

    harness.session.close();
    harness.session.dispose();
    expect(harness.socket().closed).toBe(false);

    harness.socket().open();

    expect(harness.socket().sent).toContain(JSON.stringify({ type: "close" }));
    expect(harness.socket().closed).toBe(true);
  });
});

describe("dropped output", () => {
  // §6: a resync means the stream has a hole in it. Escape sequences do not
  // survive truncation, so painting on leaves a screen that never repairs.
  it("throws the screen away and attaches again", async () => {
    await harness.session.start();
    harness.socket().open();
    const first = harness.socket();

    first.deliver(resyncFrame(8192));

    expect(first.closed).toBe(true);
    expect(harness.terminal.resets).toBe(1);
    expect(harness.sockets).toHaveLength(2);
    // A fresh attach replays the scrollback, which is what repaints the screen.
    harness.socket().deliver(bytes("redrawn"));
    expect(harness.terminal.written).toContain("redrawn");
  });
});

describe("frames from a later protocol version", () => {
  it("are ignored rather than treated as a fault", async () => {
    await harness.session.start();
    harness.socket().open();

    harness.socket().deliver(JSON.stringify({ type: "projectOpened" }));

    expect(harness.statuses).toEqual([{ kind: "running" }]);
    expect(harness.socket().closed).toBe(false);
  });
});

describe("the Claude Code action", () => {
  // The tab is an ordinary shell that gets typed into, which is what leaves the
  // user in a usable shell when claude exits.
  it("types its line after the shell's first output", async () => {
    const claude = build({ autorun: "claude" });
    await claude.session.start();
    claude.socket().open();

    expect(claude.socket().sent).not.toContain("claude\n");

    claude.socket().deliver(bytes("m6t $ "));

    expect(claude.socket().sent).toContain("claude\n");
  });

  it("types it once, however much output follows", async () => {
    const claude = build({ autorun: "claude" });
    await claude.session.start();
    claude.socket().open();

    claude.socket().deliver(bytes("m6t $ "));
    claude.socket().deliver(bytes("more output"));

    expect(claude.socket().sent.filter((sent) => sent === "claude\n")).toEqual([
      "claude\n",
    ]);
  });

  it("is not typed into a plain shell tab", async () => {
    await harness.session.start();
    harness.socket().open();

    harness.socket().deliver(bytes("m6t $ "));

    expect(harness.socket().sent).toEqual([
      JSON.stringify({ type: "resize", payload: { cols: 80, rows: 24 } }),
    ]);
  });
});
