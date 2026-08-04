import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalPalette } from "./theme";
import type { TerminalHandle } from "./terminalSession";

/**
 * The renderer, and the only module that knows xterm.js exists.
 *
 * It is deliberately thin: constructing a terminal, loading its addons and
 * measuring the element it lives in are the parts that need a real canvas and a
 * real layout, so keeping the decisions out of here is what lets the session
 * logic in terminalSession.ts be tested at all.
 */

/** Scrollback in lines. A build log or a `kubectl logs` tail is the point. */
const SCROLLBACK_LINES = 10_000;

/** A mounted terminal: the session's view of it, plus what the UI drives. */
export interface MountedTerminal extends TerminalHandle {
  focus(): void;
  /** Moves the selection to the next or previous match. */
  find(query: string, direction: "next" | "previous"): boolean;
  clearSearch(): void;
  setFontSize(px: number): void;
  setPalette(palette: TerminalPalette): void;
}

export interface MountOptions {
  readonly fontSize: number;
  readonly palette: TerminalPalette;
  /** True on macOS, where the chords are Cmd rather than Ctrl+Shift. */
  readonly appleKeys: boolean;
  /**
   * Called on the find chord. The search UI is React's, but the chord has to be
   * caught here: xterm handles keys before they bubble, so a listener on the
   * pane would open the box and send the key to the shell as well.
   */
  onFind: () => void;
}

/** Builds a terminal inside `container` and returns the handle that drives it. */
export function mountTerminal(
  container: HTMLElement,
  options: MountOptions,
): MountedTerminal {
  const terminal = new Terminal({
    fontSize: options.fontSize,
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    theme: { ...options.palette },
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
    // The search addon decorates matches through the proposed decoration API.
    allowProposedApi: true,
  });

  const fit = new FitAddon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(container);
  loadRenderer(terminal);
  terminal.attachCustomKeyEventHandler((event) =>
    handleChord(terminal, event, options),
  );

  return handleFor(terminal, fit, search);
}

/** Wraps the xterm objects in the interface the rest of the app uses. */
function handleFor(
  terminal: Terminal,
  fit: FitAddon,
  search: SearchAddon,
): MountedTerminal {
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    write: (data) => {
      terminal.write(data);
    },
    onData: (listener) => {
      terminal.onData(listener);
    },
    reset: () => {
      terminal.reset();
    },
    fit: () => {
      fit.fit();
    },
    focus: () => {
      terminal.focus();
    },
    find: (query, direction) =>
      direction === "next"
        ? search.findNext(query)
        : search.findPrevious(query),
    clearSearch: () => {
      search.clearDecorations();
    },
    setFontSize: (px) => {
      terminal.options.fontSize = px;
      fit.fit();
    },
    setPalette: (palette) => {
      terminal.options.theme = { ...palette };
    },
    dispose: () => {
      terminal.dispose();
    },
  };
}

/**
 * Loads the WebGL renderer, falling back to canvas.
 *
 * WebGL is what keeps a fast writer — a build log, `yes` — from tearing, but a
 * webview can refuse a context or lose it later (a GPU reset, or the window
 * moving between displays). Both cases end up on the canvas renderer rather
 * than on xterm's DOM renderer, which is the one that cannot keep up.
 */
function loadRenderer(terminal: Terminal): void {
  let webgl: WebglAddon;
  try {
    webgl = new WebglAddon();
  } catch {
    terminal.loadAddon(new CanvasAddon());
    return;
  }
  webgl.onContextLoss(() => {
    webgl.dispose();
    terminal.loadAddon(new CanvasAddon());
  });
  try {
    terminal.loadAddon(webgl);
  } catch {
    webgl.dispose();
    terminal.loadAddon(new CanvasAddon());
  }
}

/**
 * Copy, paste and find, on the chord the platform actually uses.
 *
 * xterm paints its own cells, so the selection is not a DOM selection and the
 * webview's own copy command has nothing to copy. Ctrl+C cannot be the chord —
 * that is SIGINT, and a terminal that stole it could not interrupt anything —
 * hence Cmd+C on macOS and Ctrl+Shift+C elsewhere, which is what every other
 * terminal on those platforms uses. Ctrl+F is likewise readline's
 * forward-char, so find is Ctrl+Shift+F off macOS.
 *
 * Returning false tells xterm the key was handled here and must not reach the
 * child.
 */
function handleChord(
  terminal: Terminal,
  event: KeyboardEvent,
  options: MountOptions,
): boolean {
  if (event.type !== "keydown" || !isChord(event, options.appleKeys)) {
    return true;
  }

  switch (event.key.toLowerCase()) {
    case "c":
      if (!terminal.hasSelection()) {
        return true; // Nothing selected: let Cmd+C through to the child.
      }
      void writeClipboard(terminal.getSelection());
      return false;
    case "v":
      void pasteClipboard(terminal);
      return false;
    case "f":
      options.onFind();
      return false;
    default:
      return true;
  }
}

/** Whether the modifiers for this platform's terminal chords are held. */
function isChord(event: KeyboardEvent, appleKeys: boolean): boolean {
  return appleKeys
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey;
}

async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Pastes as input rather than as a write: the child has to see the text arrive
 * on its stdin, and bracketed-paste mode is xterm's to apply.
 */
async function pasteClipboard(terminal: Terminal): Promise<void> {
  const text = await navigator.clipboard.readText();
  if (text !== "") {
    terminal.paste(text);
  }
}
