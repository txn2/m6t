import type { Appearance } from "../lib/theme";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "../lib/theme";

/**
 * The dev layout's controls (issue #4).
 *
 * The working directory is a text field here because projects — and with them
 * a real project root — arrive in #5. Everything else on this bar is permanent:
 * font size and appearance are terminal settings the app keeps (DESIGN.md §8).
 */
export interface ToolbarProps {
  readonly cwd: string;
  onCwd: (cwd: string) => void;
  readonly fontSize: number;
  onFontSize: (px: number) => void;
  readonly appearance: Appearance;
  onAppearance: (appearance: Appearance) => void;
}

export function Toolbar({
  cwd,
  onCwd,
  fontSize,
  onFontSize,
  appearance,
  onAppearance,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <label className="toolbar__field">
        <span>working directory</span>
        <input
          type="text"
          value={cwd}
          spellCheck={false}
          placeholder="empty: the directory m6t was started in"
          onChange={(event) => {
            onCwd(event.target.value);
          }}
        />
      </label>

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
