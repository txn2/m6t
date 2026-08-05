/**
 * Appearance shared between the app chrome and the terminal (DESIGN.md §8:
 * "font/theme settings shared with the app theme").
 *
 * The palettes live here rather than in CSS because xterm.js paints its own
 * cells — on the WebGL renderer there are no DOM nodes to inherit a variable —
 * so the same two schemes have to exist as data as well as as custom
 * properties.
 */

export type Appearance = "dark" | "light";

/**
 * The colours xterm.js is given. The field names are xterm's `ITheme`, so the
 * object is passed straight through; it is declared structurally rather than
 * imported so this module stays free of the renderer.
 */
export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly cursorAccent: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

/**
 * The dark palette's background matches `--m6t-bg` and the window background Go
 * hands the Wails runtime, so the terminal does not sit in a differently-dark
 * rectangle.
 */
const DARK: TerminalPalette = {
  background: "#16181d",
  foreground: "#e6e8ee",
  cursor: "#e6e8ee",
  cursorAccent: "#16181d",
  selectionBackground: "#33405c",
  black: "#22252d",
  red: "#e06c75",
  green: "#8cc265",
  yellow: "#d5b06b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c8ccd6",
  brightBlack: "#5c6370",
  brightRed: "#ef8a92",
  brightGreen: "#a5d67f",
  brightYellow: "#e5c07b",
  brightBlue: "#7fc3f5",
  brightMagenta: "#d69bea",
  brightCyan: "#6fd0dc",
  brightWhite: "#f2f4f8",
};

const LIGHT: TerminalPalette = {
  background: "#fbfbfd",
  foreground: "#22252d",
  cursor: "#22252d",
  cursorAccent: "#fbfbfd",
  selectionBackground: "#c9daf5",
  black: "#22252d",
  red: "#c04553",
  green: "#4d8f2f",
  yellow: "#9a6f10",
  blue: "#2f6fd0",
  magenta: "#9b45bc",
  cyan: "#2f8b96",
  white: "#dcdfe6",
  brightBlack: "#6b7280",
  brightRed: "#d4606d",
  brightGreen: "#5fa53d",
  brightYellow: "#b3841c",
  brightBlue: "#3f83e0",
  brightMagenta: "#ac59cb",
  brightCyan: "#3a9faa",
  brightWhite: "#ffffff",
};

/** The palette for an appearance. */
export function terminalPalette(appearance: Appearance): TerminalPalette {
  return appearance === "light" ? LIGHT : DARK;
}

/**
 * Font size bounds. Below the minimum the box-drawing characters full-screen
 * TUIs are built from stop resolving; above the maximum a default-sized window
 * no longer holds 80 columns, which breaks the programs this terminal exists to
 * run.
 */
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 22;
export const DEFAULT_FONT_SIZE = 13;

/** Holds a requested font size inside the usable range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) {
    return DEFAULT_FONT_SIZE;
  }
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px)));
}

/** The media query the appearance follows. */
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The subset of MediaQueryList this module uses, declared structurally so a
 * test can supply one without a DOM. */
export interface AppearanceQuery {
  readonly matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

/** Resolves the query source, or null where there is none — jsdom, and any
 * webview that does not implement matchMedia. */
function queryFor(
  matchMedia?: (query: string) => AppearanceQuery,
): AppearanceQuery | null {
  const source =
    matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null);
  return source ? source(LIGHT_QUERY) : null;
}

/**
 * The appearance the OS asks for, defaulting to dark where the query is not
 * available.
 */
export function preferredAppearance(
  matchMedia?: (query: string) => AppearanceQuery,
): Appearance {
  const query = queryFor(matchMedia);
  if (!query) {
    return "dark";
  }
  return query.matches ? "light" : "dark";
}

/**
 * Calls onChange whenever the OS appearance changes, and returns the
 * unsubscribe.
 *
 * The app follows the OS and offers no override: the theme toggle that used
 * to sit in the chrome is gone, because theme belongs in a settings dialog
 * rather than in a button on the toolbar of a tool whose job is to show a
 * repository. Following the OS *live* is what makes that removal a fix and
 * not a regression — without this, switching the OS to dark at dusk would
 * leave m6t the only light window on the screen until it was restarted.
 *
 * A source with no addEventListener (an older webview, or a test's stub)
 * yields a no-op unsubscribe rather than failing: the initial appearance is
 * still correct, only the live update is missing.
 */
export function watchAppearance(
  onChange: (appearance: Appearance) => void,
  matchMedia?: (query: string) => AppearanceQuery,
): () => void {
  const query = queryFor(matchMedia);
  if (!query?.addEventListener || !query.removeEventListener) {
    return () => undefined;
  }
  const listener = () => {
    onChange(query.matches ? "light" : "dark");
  };
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener?.("change", listener);
  };
}
