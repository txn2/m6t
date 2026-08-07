import type { UiIconName } from "./Icon";
import { UiIcon } from "./Icon";

export interface ControlProps {
  readonly icon: UiIconName;
  /** The control's name. It does not change with the control's state — see
   * below. */
  readonly label: string;
  /**
   * Whether a toggle is on, or absent for a control that acts rather than
   * toggles.
   *
   * Absent is not `false`. A button that performs an action has no pressed
   * state, and reporting a permanent `aria-pressed="false"` tells a screen
   * reader it is a toggle that happens to be off — which is a different
   * control from the one that is there.
   */
  readonly pressed?: boolean;
  /** The hover tooltip. The label says what the control is; this is where the
   * sentence explaining it goes. */
  readonly title?: string;
  /**
   * Hides the label visually, for a row too narrow to carry it.
   *
   * The tree header is the row that needs it: four labelled controls want
   * 274px and the sidebar's default is 260 (`SIDEBAR_MIN` is 180). The
   * accessible name is unaffected — a compact control is the same control,
   * and the only thing it drops is the part a sighted user can infer from the
   * icon.
   */
  readonly compact?: boolean;
  /**
   * The accessible name, when the visible label is an abbreviation of it —
   * `File` for a control that makes a new one.
   *
   * It must contain the visible label, or a user speaking what they can see
   * cannot address it (WCAG 2.5.3). Like the label, it does not change with
   * the control's state.
   */
  readonly name?: string;
  onClick: () => void;
}

/**
 * One piece of chrome the user can press: the editor toolbar's toggles (#52)
 * and the file tree's header controls (#54).
 *
 * It exists because those two rows had three looks between them — an icon
 * beside a word with no hover state, a bare icon that turned accent-coloured,
 * and a word with no icon at all — and a shared stylesheet class alone would
 * not have fixed the part that actually misleads: what the control is called.
 *
 * A control's name is fixed. The tree's dotfile toggle used to rename itself
 * from `show dotfiles` to `hide dotfiles`, which leaves a user unable to tell
 * whether the words describe the state they are in or the one the click leads
 * to — and leaves a screen reader announcing a different control each time it
 * is pressed. State is `aria-pressed` and a filled box; the name stays put.
 */
export function Control({
  icon,
  label,
  pressed,
  title,
  compact = false,
  name,
  onClick,
}: ControlProps) {
  // Left off entirely when the visible label is already the whole name, so the
  // accessible name comes from the text on screen rather than from a copy of
  // it that could drift.
  const spoken = compact || name !== undefined ? (name ?? label) : undefined;

  return (
    <button
      type="button"
      className={`control${pressed === true ? " control--on" : ""}`}
      // Undefined rather than false: see ControlProps.pressed.
      aria-pressed={pressed}
      aria-label={spoken}
      title={title}
      onClick={onClick}
    >
      <UiIcon name={icon} />
      {!compact && <span className="control__label">{label}</span>}
    </button>
  );
}
