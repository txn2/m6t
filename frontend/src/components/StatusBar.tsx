import type { BuildStatus } from "../lib/build";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../lib/theme";

/**
 * The status bar's two right-hand halves: what this build is, and the one
 * setting that lives in the line rather than in a dialog.
 *
 * They are here rather than in `App` because the workbench is at its line
 * budget and these are the cheapest pair to move: neither reads any of the
 * app's state, both are the chrome around it, and `ProjectStatus` — the
 * bar's other half — already lives outside `App` for the same reason.
 */

/**
 * The terminal's font size, in the status bar.
 *
 * It used to sit in a toolbar strip of its own above the workbench. That strip
 * held one number input and read as a web page's settings bar; an IDE puts
 * this class of control in the status line, and the strip is gone. The control
 * itself stays because removing it would remove a setting, which is a decision
 * for the settings dialog (DESIGN.md §8) rather than for a restyle.
 */
export function FontSize({
  size,
  onChange,
}: {
  readonly size: number;
  readonly onChange: (px: number) => void;
}) {
  return (
    <label className="statusbar__field">
      <span>font</span>
      <input
        type="number"
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
        value={size}
        className="statusbar__number"
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
    </label>
  );
}

/** The build identity half of the status bar. */
export function BuildLine({ build }: { readonly build: BuildStatus }) {
  return (
    <>
      <span data-testid="build-version">{build.info.version}</span>
      <span data-testid="build-commit">{build.info.commit}</span>
      <span data-testid="build-date">{build.info.date}</span>
      <span data-testid="bridge-status">
        {build.attached
          ? "connected to the Wails backend"
          : "detached — no Wails runtime"}
      </span>
    </>
  );
}
