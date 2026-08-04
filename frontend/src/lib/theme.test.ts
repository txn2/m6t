import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  preferredAppearance,
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
