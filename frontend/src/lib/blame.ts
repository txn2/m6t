import type { Blame, BlameCommit } from "./git";

/**
 * The blame column's model (#52): turning what git said about a file into the
 * two strings a gutter entry shows — a label narrow enough to sit beside the
 * code, and a tooltip carrying everything the label had to leave out.
 *
 * Everything here is pure. The hook (`useBlame`) owns the backend call and the
 * rules about when a blame is stale; the gutter (`blameExtension`) owns the
 * CodeMirror side; this owns what an entry says. It is the same split
 * `editorTabs.ts` already uses, and the reason a date format can be tested
 * without a repository or a DOM.
 */

/**
 * The widest label the column has to hold, in characters: `XX YYYY-MM-DD`.
 *
 * It is a constant rather than a number in the stylesheet because the two are
 * one decision. Initials are capped at two and the date is fixed-width, so
 * every committed entry is exactly this long — the column is sized from here,
 * and a label that outgrew it would be truncated rather than wrapped.
 */
export const BLAME_LABEL_WIDTH = 13;

/** What the column shows for a line git attributes to no commit. It replaces
 * the initials rather than sitting beside them: there is nobody to initial. */
export const UNCOMMITTED_LABEL = "uncommitted";

/** The initials shown for an author whose name produced none. */
const UNKNOWN_INITIALS = "??";

/**
 * The commit a 1-based line number is attributed to, or null.
 *
 * Null covers three real cases, and the caller treats them alike because there
 * is nothing to say about any of them: a line past the end of the blame (the
 * buffer has grown since it was read), a line the blame did not cover
 * (`internal/git`'s -1), and an index that does not name a commit.
 */
export function commitAt(blame: Blame, line: number): BlameCommit | null {
  if (line < 1 || line > blame.lines.length) {
    return null;
  }
  const index = blame.lines[line - 1];
  if (index < 0 || index >= blame.commits.length) {
    return null;
  }
  return blame.commits[index];
}

/**
 * The label for one entry: the author's initials and the date they wrote it.
 *
 * The date is `YYYY-MM-DD` rather than a locale format or a relative phrase.
 * It is the same width for every line, which is what lets the column hold a
 * fixed size, and it sorts by eye — the question the column answers is "which
 * of these lines is newer than the others".
 */
export function blameLabel(commit: BlameCommit): string {
  if (commit.uncommitted) {
    return UNCOMMITTED_LABEL;
  }
  // Trimmed, because a commit whose timestamp git could not print leaves the
  // date empty and a label ending in a space is a label with a rendering fault.
  return `${initials(commit.author)} ${blameDay(commit)}`.trimEnd();
}

/**
 * The entry's tooltip: everything the label had no room for.
 *
 * The abbreviated SHA is here rather than in the label because it is what a
 * user takes to the terminal — `git show <sha>` in the pane below is the next
 * step after finding the line that surprised them.
 */
export function blameTooltip(commit: BlameCommit): string {
  if (commit.uncommitted) {
    // Deliberately not "only in the working tree". The gutter uses this label
    // for two things: a line git reported against the all-zero SHA, which IS in
    // the working tree, and a line the user has typed into since the blame was
    // read, which is not even that. What both actually have in common is the
    // part worth saying.
    return "Not committed yet — this line is in no commit";
  }
  const parts = [commit.author, blameMoment(commit), abbreviate(commit.sha)];
  if (commit.summary !== "") {
    parts.push(commit.summary);
  }
  return parts.filter((part) => part !== "").join(" · ");
}

/**
 * A person's initials, at most two.
 *
 * A one-word name gives its first two letters — `cjimti` is `CJ` — because a
 * single letter in a two-character column reads as a rendering fault rather
 * than as a name. More than two words gives the first and the last, which is
 * the pair a reader recognises in `Ada Byron King`.
 *
 * Iterated by code point, not by index: a name beginning with an astral
 * character sliced by `charAt` would produce half a surrogate pair.
 */
export function initials(author: string): string {
  const words = author.split(/\s+/u).filter((word) => word !== "");
  if (words.length === 0) {
    return UNKNOWN_INITIALS;
  }
  if (words.length === 1) {
    return firstLetters(words[0], 2);
  }
  return firstLetters(words[0], 1) + firstLetters(words[words.length - 1], 1);
}

/** The first `count` code points of a word, upper-cased. */
function firstLetters(word: string, count: number): string {
  return Array.from(word).slice(0, count).join("").toLocaleUpperCase();
}

/** A commit's date, in the reader's own zone. */
function blameDay(commit: BlameCommit): string {
  return commit.authorTime === 0 ? "" : formatDay(momentOf(commit));
}

/** A commit's date and time, in the reader's own zone. */
function blameMoment(commit: BlameCommit): string {
  return commit.authorTime === 0 ? "" : formatMoment(momentOf(commit));
}

function momentOf(commit: BlameCommit): Date {
  return new Date(commit.authorTime * 1000);
}

/**
 * `YYYY-MM-DD`, from the date's local fields.
 *
 * Local rather than UTC: a commit made at 11pm should carry the day its author
 * made it, not tomorrow's. `toISOString` would give the second, and a locale
 * format would give a different width per reader.
 */
export function formatDay(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
}

/** `YYYY-MM-DD HH:MM`, for the tooltip. */
export function formatMoment(date: Date): string {
  return `${formatDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The short object name git itself would print. */
function abbreviate(sha: string): string {
  return sha.slice(0, 7);
}
