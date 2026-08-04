import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Endpoint } from "../lib/stream";
import { newTab, patchTab } from "../lib/tabs";
import type { MountedTerminal } from "../lib/xterm";
import { TerminalPane } from "./TerminalPane";

afterEach(cleanup);

// jsdom has no ResizeObserver, and the pane observes its own element so the
// child learns about a window resize. The stub records nothing; the resize
// behaviour itself is covered where it lives, in terminalSession.test.ts.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {
      /* the pane never asks for the measurements, only for the callback */
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

const endpoint: Endpoint = { port: 51234, token: "tok" };

function fakeTerminal(): MountedTerminal {
  return {
    cols: 80,
    rows: 24,
    write: vi.fn(),
    onData: vi.fn(),
    reset: vi.fn(),
    fit: vi.fn(),
    dispose: vi.fn(),
    focus: vi.fn(),
    find: vi.fn().mockReturnValue(true),
    clearSearch: vi.fn(),
    setFontSize: vi.fn(),
    setPalette: vi.fn(),
  };
}

function renderPane(overrides: Partial<Parameters<typeof TerminalPane>[0]>) {
  const props = {
    tab: newTab("k0", "infra", "shell 1", "/w/project"),
    endpoint,
    active: true,
    fontSize: 13,
    appearance: "dark" as const,
    onStatus: vi.fn(),
    onRestart: vi.fn(),
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    mount: vi.fn().mockReturnValue(fakeTerminal()),
    // Never resolving: these tests are about the pane, not the session.
    open: vi.fn().mockReturnValue(new Promise<string>(() => undefined)),
    ...overrides,
  };
  const { rerender } = render(<TerminalPane {...props} />);
  return { props, rerender };
}

describe("a running pane", () => {
  it("opens its session in the directory the tab was created with", async () => {
    const { props } = renderPane({});

    await waitFor(() => {
      expect(props.open).toHaveBeenCalledWith("/w/project", 80, 24);
    });
  });

  // The strip needs the session to end a PTY the user closed; unmounting the
  // pane deliberately only detaches.
  it("hands its session up and takes the same one back on unmount", async () => {
    const attached: unknown[] = [];
    const detached: unknown[] = [];
    renderPane({
      onAttach: (_key, session) => attached.push(session),
      onDetach: (_key, session) => detached.push(session),
    });

    await waitFor(() => {
      expect(attached).toHaveLength(1);
    });

    cleanup();

    // The same object, because the holder tells this pane's session from its
    // replacement's by identity.
    expect(detached).toEqual(attached);
  });

  it("stays mounted but hidden when it is not the active tab", () => {
    renderPane({ active: false });

    expect(screen.getByTestId("pane-k0").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("shows nothing about an exit while the shell is alive", () => {
    renderPane({});

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a pane whose shell has ended", () => {
  const ended = (patch: Parameters<typeof patchTab>[2]) =>
    patchTab([newTab("k0", "infra", "shell 1", "/w")], "k0", patch)[0];

  it("says how it ended and offers to start another", () => {
    const { props } = renderPane({
      tab: ended({ status: "exited", exitCode: 130 }),
    });

    expect(screen.getByRole("status").textContent).toContain(
      "exited with status 130",
    );

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(props.onRestart).toHaveBeenCalledWith("k0");
  });

  it("shows why a tab that never got a shell failed", () => {
    renderPane({
      tab: ended({ status: "failed", error: "chdir /nope: no such file" }),
    });

    expect(screen.getByRole("status").textContent).toContain(
      "chdir /nope: no such file",
    );
  });
});

describe("live settings", () => {
  // Rebuilding the terminal would drop the scrollback and the running
  // program's screen with it, so a font change has to reach the live one.
  it("restyles the existing terminal rather than rebuilding it", () => {
    const terminal = fakeTerminal();
    const mount = vi.fn().mockReturnValue(terminal);
    const { props, rerender } = renderPane({ mount });

    rerender(<TerminalPane {...props} fontSize={18} appearance="light" />);

    expect(terminal.setFontSize).toHaveBeenLastCalledWith(18);
    expect(terminal.setPalette).toHaveBeenCalledTimes(2);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});
