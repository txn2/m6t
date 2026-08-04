import type { SessionStatus } from "./terminalSession";

/**
 * The terminal tab strip's model: what a tab is, and the transitions the strip
 * performs on it. Everything here is pure — the pane owns the PTY, this owns
 * the list — which is what makes the strip's behaviour testable without a
 * backend.
 */

/**
 * Where a tab is in its life.
 *
 * `exited` is a state a tab stays in rather than a reason to remove it: the
 * scrollback of a shell that just died is usually the thing the user wants to
 * read, so the tab holds its output and offers a restart.
 */
export type TabStatus = "starting" | "running" | "exited" | "failed";

/** One terminal tab. */
export interface TerminalTab {
  /** Identity for React and for every lookup here; never reused. */
  readonly key: string;
  readonly title: string;
  /**
   * The directory the tab's shell starts in, fixed when the tab is created.
   * It is held per tab rather than read from the toolbar at connect time so
   * that editing the field does not move a running tab's shell out from under
   * it. Issue #5 replaces the field with the project root.
   */
  readonly cwd: string;
  readonly status: TabStatus;
  /** The child's exit status once it ended; -1 means killed by a signal. */
  readonly exitCode: number | null;
  /** Why the tab has no session, when it failed to get one. */
  readonly error: string | null;
  /**
   * A line typed into the shell once it is ready. The "Claude Code" action is
   * this and nothing more, which is what leaves the user in a usable shell
   * when claude exits.
   */
  readonly autorun: string | null;
  /**
   * Bumped by a restart. It is part of the pane's React key, so a restart
   * unmounts the dead terminal and mounts a fresh one instead of trying to
   * revive an instance whose PTY is gone.
   */
  readonly generation: number;
}

/** Creates a tab that has not yet asked the backend for a session. */
export function newTab(
  key: string,
  title: string,
  cwd: string,
  autorun: string | null = null,
): TerminalTab {
  return {
    key,
    title,
    cwd,
    status: "starting",
    exitCode: null,
    error: null,
    autorun,
    generation: 0,
  };
}

/**
 * Picks the next free `<base> <n>` title.
 *
 * The lowest unused number rather than a running count, so closing "shell 2"
 * and opening a new tab gives "shell 2" back instead of climbing forever.
 */
export function nextTitle(tabs: readonly TerminalTab[], base: string): string {
  const taken = new Set(tabs.map((tab) => tab.title));
  let n = 1;
  while (taken.has(`${base} ${String(n)}`)) {
    n += 1;
  }
  return `${base} ${String(n)}`;
}

/** Applies a patch to one tab, leaving the rest untouched. */
export function patchTab(
  tabs: readonly TerminalTab[],
  key: string,
  patch: Partial<TerminalTab>,
): TerminalTab[] {
  return tabs.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab));
}

/**
 * Renames a tab, ignoring a blank title.
 *
 * A tab strip of empty labels is unusable and un-fixable — there is nothing
 * left to click on to rename it back — so the edit is rejected rather than
 * applied.
 */
export function renameTab(
  tabs: readonly TerminalTab[],
  key: string,
  title: string,
): TerminalTab[] {
  const trimmed = title.trim();
  return trimmed === "" ? [...tabs] : patchTab(tabs, key, { title: trimmed });
}

/**
 * Puts a tab back into its starting state under a new generation, which is how
 * the pane knows to build a fresh terminal rather than reuse the dead one.
 */
export function restartTab(
  tabs: readonly TerminalTab[],
  key: string,
): TerminalTab[] {
  return tabs.map((tab) =>
    tab.key === key
      ? {
          ...tab,
          status: "starting",
          exitCode: null,
          error: null,
          generation: tab.generation + 1,
        }
      : tab,
  );
}

/** Removes a tab from the strip. */
export function removeTab(
  tabs: readonly TerminalTab[],
  key: string,
): TerminalTab[] {
  return tabs.filter((tab) => tab.key !== key);
}

/**
 * The tab to select after `key` is closed.
 *
 * Closing an inactive tab must not move the selection — the user is watching
 * something in the active one. Closing the active tab selects its right-hand
 * neighbour, falling back to the left, because that is where the eye already
 * is; closing the last tab selects nothing.
 */
export function selectionAfterClose(
  tabs: readonly TerminalTab[],
  key: string,
  active: string | null,
): string | null {
  if (active !== key) {
    return active;
  }
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0) {
    return active;
  }
  const remaining = removeTab(tabs, key);
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(index, remaining.length - 1)].key;
}

/**
 * Whether a session ending takes its tab with it.
 *
 * A shell the user exited is a tab the user closed — every terminal app treats
 * it that way, and leaving a dead tab behind for a `^D` would make the strip
 * fill up with them. Anything else stays: a non-zero status, a signal, a
 * session that never started, are all things the user has to be able to read
 * after the fact, which is what the exited state and its restart are for.
 */
export function endingClosesTheTab(status: SessionStatus): boolean {
  return status.kind === "exited" && status.code === 0;
}

/** The tab fields a session status determines. */
export function statusPatch(status: SessionStatus): Partial<TerminalTab> {
  switch (status.kind) {
    case "running":
      return { status: "running", error: null };
    case "exited":
      return { status: "exited", exitCode: status.code };
    default:
      return { status: "failed", error: status.message };
  }
}

/** Describes an ended tab in the words the pane shows the user. */
export function exitDescription(tab: TerminalTab): string {
  if (tab.status === "failed") {
    return tab.error ?? "the terminal could not be started";
  }
  if (tab.exitCode === -1) {
    return "terminated by a signal";
  }
  return `exited with status ${String(tab.exitCode ?? 0)}`;
}
