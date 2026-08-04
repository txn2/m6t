import type { Appearance } from "../lib/theme";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../lib/theme";

/**
 * The app's terminal settings (DESIGN.md §8).
 *
 * The working-directory field #4 put here is gone: a terminal's cwd is its
 * project's checkout now, which is what #5 replaced it with. What is left is
 * permanent — font size and appearance are settings the app keeps.
 */
export interface ToolbarProps {
  readonly fontSize: number;
  onFontSize: (px: number) => void;
  readonly appearance: Appearance;
  onAppearance: (appearance: Appearance) => void;
}

export function Toolbar({
  fontSize,
  onFontSize,
  appearance,
  onAppearance,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <label className="toolbar__field">
        <span>font</span>
        <input
          type="number"
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          value={fontSize}
          className="toolbar__number"
          onChange={(event) => {
            onFontSize(Number(event.target.value));
          }}
        />
      </label>

      <button
        type="button"
        onClick={() => {
          onAppearance(appearance === "dark" ? "light" : "dark");
        }}
      >
        {appearance === "dark" ? "light theme" : "dark theme"}
      </button>
    </div>
  );
}
