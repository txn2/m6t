import { useEffect, useRef, useState } from "react";
import type { EditorTab } from "./editorTabs";
import type { Blame, Git } from "./git";
import { wailsGit } from "./git";

/** The reading half of the git seam this hook uses — the only call it makes. */
type BlameReader = Pick<Git, "blame">;

/** What the editor pane knows about its blame: the data, or why there is none. */
export interface BlameState {
  readonly blame: Blame | null;
  /** git's own words when it refused (DESIGN.md §7), null otherwise. */
  readonly error: string | null;
}

/** No blame and no failure: what a pane whose column is off is handed, and
 * what a read resets to. */
export const NO_BLAME: BlameState = { blame: null, error: null };

/**
 * The active tab's blame (#52, #64).
 *
 * Only one tab's blame is ever held. Every pane stays mounted for the reason
 * `EditorPane` documents, but only one of them is on screen, and a blame is a
 * subprocess per file — reading one for a tab nobody is looking at would spend
 * a `git blame` on every open file every time one of them was saved.
 *
 * The read is keyed on the tab's `baseline`, which is the disk content by
 * definition. That is what makes a save refresh the column: the write moves
 * the baseline, this asks git again, and the lines the user just wrote come
 * back attributed to nobody, which is what they are.
 *
 * An unsaved edit is deliberately NOT in that key, and this is the half worth
 * reading twice (#64). It used to be: the tab going dirty reset this to
 * NO_BLAME, so the whole column emptied on the first keystroke and stayed empty
 * until a save. What the reasoning behind that missed is that a `git blame` of a
 * file with unsaved edits is not wrong — it is a reading of what is on disk,
 * which is exactly `baseline` — and following the buffer's edits is the editor's
 * job, not this hook's. `blameMarks.ts` does that now, so this holds what it
 * read until the disk content moves under it.
 *
 * Nor is the blame COLUMN's toggle in that key any more, and that is the change
 * worth arguing with. A blame read used to be opt-in, on the reasoning that it
 * is a subprocess and the user had asked for a column. What it turns out to
 * feed is not only a column: the highlight on every line that is in no commit
 * (#64) answers a question people have while the column is off, so gating the
 * read on the column would gate a feature on an unrelated control. The cost is
 * one `git blame` per file the user actually opens, refreshed when they save
 * it — the same cost this already paid whenever the column was on, now paid for
 * the file on screen rather than for the file on screen with a toggle set.
 */
export function useBlame(tab: EditorTab | null, git: BlameReader = wailsGit): BlameState {
  const [state, setState] = useState<BlameState>(NO_BLAME);

  // The seam behind a ref, for the reason `useGitStatus` documents at length:
  // a caller passing an inline object would otherwise rebuild it every render
  // and re-run the read effect forever.
  const seam = useRef(git);
  useEffect(() => {
    seam.current = git;
  }, [git]);

  // Read out of the tab rather than depending on the object: a tab is replaced
  // on every keystroke, and an effect that depended on it would re-read the
  // blame between one character and the next. None of the four values below
  // moves when the user types, which is what makes typing cost nothing here.
  const wanted = tab !== null && tab.status === "ready";
  const root = tab?.root ?? "";
  const path = tab?.path ?? "";
  const baseline = tab?.baseline ?? "";

  useEffect(() => {
    if (!wanted) {
      setState(NO_BLAME);
      return;
    }
    // A blame that is still in flight when the user switches tabs or saves
    // again is dropped rather than applied: it describes a file that is no
    // longer the one on screen, and its line numbers would land on the wrong
    // text.
    let live = true;
    void (async () => {
      const result = await readBlame(seam.current, root, path);
      if (live) {
        setState(result);
      }
    })();
    return () => {
      live = false;
    };
  }, [wanted, root, path, baseline]);

  return state;
}

/** Reads one blame, turning a rejection into a message rather than a throw —
 * including the synchronous throw the generated binding produces when there is
 * no Wails runtime behind it. */
async function readBlame(
  git: BlameReader,
  root: string,
  path: string,
): Promise<BlameState> {
  try {
    return { blame: await git.blame(root, path), error: null };
  } catch (failure: unknown) {
    return { blame: null, error: describeError(failure) };
  }
}

/** Renders a rejected binding call as a sentence the pane can show. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the git backend is not reachable";
}
