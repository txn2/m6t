import type { EditorTab } from "../lib/editorTabs";
import type { Status } from "../lib/git";
import { isTracked } from "../lib/gitStatus";
import { Control } from "./Control";

export interface ViewToolbarProps {
  /** The file the editor is showing, or null when nothing is open. */
  readonly tab: EditorTab | null;
  /** This project's git status (#8) — what says whether the file has history
   * to show. */
  readonly status: Status;
  /** Selects this file in the tree, expanding whatever hides it (#56). */
  onLocate: (path: string) => void;
  onToggleBlame: (key: string, blame: boolean) => void;
}

/**
 * The active file's toolbar, under the breadcrumb (#52).
 *
 * It is a row of its own rather than more buttons on the tab. A control here
 * belongs to the file on screen, not to the strip: putting it on the tab would
 * repeat it once per open file and grow every tab by the number of controls
 * the editor grows.
 *
 * Blame is the first thing in it, not the point of it. The row is where a
 * per-file control goes — #35's diff toggle next, and whatever else the editor
 * grows that acts on the open file rather than on the project — so a control
 * added here should take its own visibility rule the way `blameable` does
 * rather than assume the row is about git.
 *
 * The row is absent, not empty, when it would hold nothing. An untracked file
 * has no blame to show, and a bar of disabled controls says less about why
 * than no bar at all does.
 */
export function ViewToolbar({ tab, status, onLocate, onToggleBlame }: ViewToolbarProps) {
  // The row exists when any control in it does, not when a particular one
  // does. Locate applies to every open file, so today that means "whenever a
  // file is open" — but the test is written the way it is because the next
  // control to land here (#35's diff toggle) will not apply to every file
  // either, and the row must not turn on the wrong condition.
  if (tab === null) {
    return null;
  }

  return (
    <div className="view-toolbar" role="toolbar" aria-label={`views of ${tab.title}`}>
      <Control
        icon="locate"
        label="Locate"
        title="Select this file in the tree"
        onClick={() => {
          onLocate(tab.path);
        }}
      />
      {blameable(tab, status) && (
        <Control
          icon="blame"
          label="Blame"
          pressed={tab.blame}
          title="Show who last changed each line"
          onClick={() => {
            onToggleBlame(tab.key, !tab.blame);
          }}
        />
      )}
    </div>
  );
}

/**
 * Whether this tab can show a blame column.
 *
 * Tracked is the git half. The other half is that the column is a CodeMirror
 * gutter: a markdown tab showing its rendered preview has no gutter to put it
 * in, so the toggle would be a button that visibly does nothing.
 */
function blameable(tab: EditorTab, status: Status): boolean {
  if (tab.kind === "markdown" && tab.mode === "preview") {
    return false;
  }
  return isTracked(status, tab.path);
}
