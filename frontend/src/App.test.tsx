import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import { detachedBuild } from "./lib/build";

afterEach(cleanup);

describe("App", () => {
  it("renders the build identity reported by the backend", async () => {
    render(
      <App
        load={() =>
          Promise.resolve({
            info: { version: "v1.2.0", commit: "a1b2c3d", date: "2026-08-02" },
            attached: true,
          })
        }
      />,
    );

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
      <App load={() => Promise.resolve({ info: detachedBuild, attached: false })} />,
    );

    expect((await screen.findByTestId("bridge-status")).textContent).toBe(
      "detached — no Wails runtime",
    );
    expect(screen.getByTestId("build-version").textContent).toBe("dev");
  });

  it("names the app in the window", () => {
    render(<App load={() => new Promise(() => undefined)} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("m6t");
  });
});
