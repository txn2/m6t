import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  preferredAppearance,
  watchAppearance,
  terminalPalette,
} from "./theme";

describe("terminal palette", () => {
  // The window background is set in Go (internal/app) so the window does not
  // flash white before the first paint. A terminal painting a different dark
  // would show as a rectangle inside the window.
  it("paints the dark terminal on the app's own background", () => {
    expect(terminalPalette("dark").background).toBe("#16181d");
  });

  it("inverts foreground and background between the two schemes", () => {
    const dark = terminalPalette("dark");
    const light = terminalPalette("light");

    expect(light.background).not.toBe(dark.background);
    expect(light.foreground).not.toBe(dark.foreground);
    // The cursor accent is drawn over the cursor, so it has to match the
    // background it sits on or the cursor is a hole in the text.
    expect(light.cursorAccent).toBe(light.background);
    expect(dark.cursorAccent).toBe(dark.background);
  });
});

describe("font size", () => {
  it("keeps a size that is already usable", () => {
    expect(clampFontSize(16)).toBe(16);
  });

  it("holds a request inside the usable range", () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(400)).toBe(MAX_FONT_SIZE);
  });

  // The control is a number input, and an emptied one reads as NaN.
  it("falls back to the default when the field has no number in it", () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);
  });

  it("rounds fractional sizes", () => {
    expect(clampFontSize(13.6)).toBe(14);
  });
});

describe("preferred appearance", () => {
  it("follows the OS when it says light", () => {
    expect(preferredAppearance(() => ({ matches: true }))).toBe("light");
  });

  it("follows the OS when it says otherwise", () => {
    expect(preferredAppearance(() => ({ matches: false }))).toBe("dark");
  });

  // jsdom has no matchMedia, and neither does every webview m6t runs in.
  it("defaults to dark where the query is unavailable", () => {
    expect(preferredAppearance()).toBe("dark");
  });
});

describe("following the OS appearance (#33)", () => {
  /** A matchMedia stub whose match state a test can flip. */
  function fakeQuery(matches: boolean) {
    const listeners: (() => void)[] = [];
    const query = {
      matches,
      addEventListener: (_type: "change", listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: (_type: "change", listener: () => void) => {
        const at = listeners.indexOf(listener);
        if (at >= 0) {
          listeners.splice(at, 1);
        }
      },
    };
    return {
      matchMedia: () => query,
      flip(to: boolean) {
        query.matches = to;
        for (const listener of [...listeners]) {
          listener();
        }
      },
      get listenerCount() {
        return listeners.length;
      },
    };
  }

  it("reports the new appearance when the OS switches to light", () => {
    const source = fakeQuery(false);
    const seen: string[] = [];
    watchAppearance((appearance) => seen.push(appearance), source.matchMedia);

    source.flip(true);

    expect(seen).toEqual(["light"]);
  });

  it("reports the new appearance when the OS switches to dark", () => {
    const source = fakeQuery(true);
    const seen: string[] = [];
    watchAppearance((appearance) => seen.push(appearance), source.matchMedia);

    source.flip(false);

    expect(seen).toEqual(["dark"]);
  });

  it("stops reporting once unsubscribed", () => {
    const source = fakeQuery(false);
    const seen: string[] = [];
    const stop = watchAppearance((a) => seen.push(a), source.matchMedia);

    stop();
    source.flip(true);

    expect(seen).toEqual([]);
    expect(source.listenerCount).toBe(0);
  });

  // An older webview exposes matches but not addEventListener. The initial
  // appearance is still right; only the live update is missing, and that must
  // not be a crash on startup.
  it("is a no-op where the query cannot be subscribed to", () => {
    const stop = watchAppearance(
      () => {
        throw new Error("must not be called");
      },
      () => ({ matches: true }),
    );

    expect(() => { stop(); }).not.toThrow();
  });

  it("is a no-op where there is no matchMedia at all", () => {
    expect(() => { watchAppearance(() => undefined)(); }).not.toThrow();
  });
});
