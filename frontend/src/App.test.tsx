import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { detachedBuild } from "./lib/build";
import type { Endpoint } from "./lib/stream";

afterEach(cleanup);

/**
 * The endpoint that never arrives.
 *
 * Every test here is about the shell around the terminals — the strip, the
 * toolbar, the status line — so the panes are deliberately kept from mounting:
 * a mounted pane builds a real xterm, which needs a canvas jsdom does not have.
 * The pane's own behaviour is covered in components/TerminalPane.test.tsx.
 */
const pending = () => new Promise<Endpoint>(() => undefined);

const attached = () =>
  Promise.resolve({
    info: { version: "v1.2.0", commit: "a1b2c3d", date: "2026-08-02" },
    attached: true,
  });

describe("the build identity in the status line", () => {
  it("reports what the backend says", async () => {
    render(<App load={attached} endpoint={pending} />);

    expect((await screen.findByTestId("build-version")).textContent).toBe(
      "v1.2.0",
    );
    expect(screen.getByTestId("build-commit").textContent).toBe("a1b2c3d");
    expect(screen.getByTestId("build-date").textContent).toBe("2026-08-02");
    expect(screen.getByTestId("bridge-status").textContent).toBe(
      "connected to the Wails backend",
    );
  });

  it("says so when there is no Wails runtime to answer", async () => {
    render(
      <App
        load={() => Promise.resolve({ info: detachedBuild, attached: false })}
        endpoint={pending}
      />,
    );

    expect((await screen.findByTestId("bridge-status")).textContent).toBe(
      "detached — no Wails runtime",
    );
    expect(screen.getByTestId("build-version").textContent).toBe("dev");
  });
});

describe("the stream endpoint", () => {
  it("says it is still connecting before the endpoint arrives", () => {
    render(<App load={attached} endpoint={pending} />);

    expect(screen.getByTestId("stream-status").textContent).toContain(
      "connecting",
    );
  });

  // StreamEndpoint fails until the listener is up and its error says why. A UI
  // that showed an empty pane instead would be indistinguishable from a
  // backend that started but produced nothing.
  it("shows why the terminal backend is unreachable", async () => {
    render(
      <App
        load={attached}
        endpoint={() => Promise.reject(new Error("stream server is not started"))}
      />,
    );

    expect((await screen.findByTestId("stream-status")).textContent).toBe(
      "stream server is not started",
    );
  });

  // The binding throws rather than rejecting when there is no runtime behind
  // it, which would otherwise take the whole render down.
  it("survives a binding that throws instead of rejecting", async () => {
    render(
      <App
        load={attached}
        endpoint={() => {
          throw new TypeError("window.go is undefined");
        }}
      />,
    );

    expect((await screen.findByTestId("stream-status")).textContent).toBe(
      "window.go is undefined",
    );
  });
});

describe("opening and closing terminal tabs", () => {
  const open = (label: string) => {
    fireEvent.click(screen.getByRole("button", { name: label }));
  };

  it("numbers each kind of tab separately", () => {
    render(<App load={attached} endpoint={pending} />);

    open("+ shell");
    open("+ shell");
    open("+ Claude Code");

    expect(screen.getByRole("tab", { name: /shell 1/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /shell 2/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: /claude 1/ })).toBeDefined();
  });

  it("selects a newly opened tab", () => {
    render(<App load={attached} endpoint={pending} />);

    open("+ shell");
    open("+ shell");

    expect(
      screen.getByRole("tab", { name: /shell 2/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("moves the selection to a neighbour when the active tab closes", () => {
    render(<App load={attached} endpoint={pending} />);

    open("+ shell");
    open("+ shell");
    fireEvent.click(screen.getByRole("button", { name: "close shell 2" }));

    expect(screen.queryByRole("tab", { name: /shell 2/ })).toBeNull();
    expect(
      screen.getByRole("tab", { name: /shell 1/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("renames a tab in place", () => {
    render(<App load={attached} endpoint={pending} />);

    open("+ shell");
    fireEvent.doubleClick(screen.getByRole("tab", { name: /shell 1/ }));
    const field = screen.getByRole("textbox", { name: "rename shell 1" });
    fireEvent.change(field, { target: { value: "cluster logs" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByRole("tab", { name: /cluster logs/ })).toBeDefined();
  });
});

describe("terminal settings", () => {
  it("switches the whole app between light and dark", () => {
    const { container } = render(<App load={attached} endpoint={pending} />);
    const shell = container.querySelector(".shell");

    expect(shell?.className).toContain("shell--dark");

    fireEvent.click(screen.getByRole("button", { name: "light theme" }));

    expect(shell?.className).toContain("shell--light");
  });

  // Below the minimum the box-drawing characters a TUI is built from stop
  // resolving, so the field's value is held inside the usable range.
  it("holds the font size inside the usable range", () => {
    render(<App load={attached} endpoint={pending} />);
    const field = screen.getByRole("spinbutton");

    fireEvent.change(field, { target: { value: "400" } });

    expect((field as HTMLInputElement).value).toBe("22");
  });
});
