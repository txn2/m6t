import {
  MapMode,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Line,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type DecorationSet,
} from "@codemirror/view";
import { blameLabel, blameTooltip, commitAt } from "./blame";
import type { Blame, BlameCommit } from "./git";

/**
 * What git's attribution draws in the editor (#52, #64): the blame column, the
 * highlight on every line that is in no commit, and the state that keeps both
 * on the right lines as the buffer is edited.
 *
 * The two marks are one feature and share one rule, which is why they are one
 * module: a line is *accounted for* when it still reads exactly as git measured
 * it and git named a commit for it. Everything else — a line being typed into, a
 * line past the end of the blame, a line git itself reported against the
 * all-zero SHA — is in no commit, and both marks say so.
 *
 * They are also drawn from one pass, in the same field, and that is not
 * tidiness — it is what stops them disagreeing on screen, which they did: a
 * wrapped file could show `uncommitted` in the column against one line and the
 * band against a different one, and scrolling put it right.
 *
 * The column used to be built by CodeMirror's per-line callback, which is
 * handed a laid-out block and has to find the line itself — `doc.lineAt(...)`
 * on a position that comes from the layout rather than from the document. That
 * is a lookup with two inputs that have to be in step, and under
 * `EditorView.lineWrapping` they are not always: line heights are estimated
 * until a measure pass runs, so the blocks a render sees can belong to a
 * slightly different picture of the file than the state does. Ask the wrong
 * line for its text and you get the wrong marker, drawn against the right row.
 * Its refresh was a hand-written `lineMarkerChange` predicate too, while the
 * band's was CodeMirror's own decoration diffing — two refresh paths over one
 * rule.
 *
 * Both are range sets now, positioned by the document and mapped, compared and
 * repainted by the same machinery. Nothing here reads the layout.
 *
 * They are shown independently, and that is the point of the highlight. The
 * column is a toggle the user presses; the highlight is on whenever a blame has
 * been read, because "which lines here are not committed yet" is a question they
 * have while the column is off and the fourteen characters it costs are better
 * spent on code.
 *
 * It is a second module that knows CodeMirror exists, beside `codemirror.ts`,
 * and the reason is that it is the only part of the editor with state of its
 * own. What has NOT moved is the split `blame.ts` documents: that module still
 * owns what an entry says, this owns where it sits, and the hook owns when it is
 * read.
 */

/**
 * One line's attribution, pinned to the line it describes.
 *
 * `text` is the line exactly as git measured it, and it is what makes an entry
 * honest rather than merely present: a line whose text has changed is a line
 * nobody has committed yet, whatever the blame said about the line that used to
 * be there.
 */
interface BlameAnchor {
  readonly text: string;
  readonly marker: BlameEntry;
}

/**
 * A blame as the editor holds it.
 *
 * `installed` is not the same question as "are there any anchors", and
 * conflating the two is a bug waiting in a file nobody has committed yet: every
 * one of its lines is uncommitted, so it has no anchors at all, and a reader
 * that took an empty map for "no blame was read" would leave the whole file
 * unmarked — the exact file where the marking matters most.
 */
interface BlameMarks {
  readonly installed: boolean;
  readonly anchors: ReadonlyMap<number, BlameAnchor>;
  /** The column's entries, by line start. */
  readonly entries: RangeSet<GutterMarker>;
  /** The band on every line that is in no commit, by line start. */
  readonly bands: DecorationSet;
}

/** Nothing read yet, and so nothing claimed about any line. */
const NO_MARKS: BlameMarks = {
  installed: false,
  anchors: new Map(),
  entries: RangeSet.empty,
  bands: Decoration.none,
};

/** Installs a blame, or clears it with null. */
export const setBlameMarks = StateEffect.define<Blame | null>();

/**
 * The blame, tracked through the edits the user makes (#52, #64).
 *
 * This field is the fix for the column emptying itself on the first keystroke
 * (#64). `git blame` measures the file on disk and answers in line numbers, so
 * the original reading of that was to hide every entry the moment the buffer
 * went dirty — one insertion moves every line under it, and a shifted blame
 * names the wrong person. That is true about line NUMBERS and only about line
 * numbers. The attribution itself does not go stale when the user types: the
 * line they edited is theirs now, and the other four hundred lines are still
 * whoever's they were.
 *
 * So the entries are anchored to positions rather than counted in lines, and
 * CodeMirror's own change mapping moves them: the same machinery that keeps a
 * selection where the user left it. An anchor survives an edit when it still
 * begins a line and that line still reads as git measured it, which reduces the
 * whole question to one rule the marks can state in a sentence — see
 * `accountedFor`.
 *
 * A save is still what refreshes it. The lines the user just wrote come back
 * from a fresh read attributed to nobody, which is what they are.
 */
export const blameMarks = StateField.define<BlameMarks>({
  create: () => NO_MARKS,
  update: (marks, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setBlameMarks)) {
        return marksFor(effect.value, transaction.state.doc);
      }
    }
    if (!transaction.docChanged) {
      return marks;
    }
    return drawn(
      marks.installed,
      movedAnchors(marks.anchors, transaction),
      transaction.state.doc,
    );
  },
});

/**
 * Anchors a blame onto the document it was measured against.
 *
 * A line git attributed to the all-zero SHA gets no anchor. It is in no commit,
 * which is the same state as a line the user has just typed, and giving the two
 * one representation is what keeps `accountedFor` a single comparison instead of
 * a comparison plus a special case.
 */
function marksFor(blame: Blame | null, doc: Text): BlameMarks {
  if (blame === null) {
    return NO_MARKS;
  }
  const anchors = new Map<number, BlameAnchor>();
  // The blame and the buffer can disagree about how many lines there are — a
  // file that grew since the read, or a blame that arrived for a shorter one.
  // Whichever is shorter bounds the walk; the surplus on either side has
  // nothing to say about the other.
  const last = Math.min(blame.lines.length, doc.lines);
  for (let number = 1; number <= last; number += 1) {
    const commit = commitAt(blame, number);
    if (commit === null || commit.uncommitted) {
      continue;
    }
    const line = doc.line(number);
    anchors.set(line.from, { text: line.text, marker: new BlameEntry(commit) });
  }
  return drawn(true, anchors, doc);
}

/**
 * Both marks, from one walk of the document.
 *
 * Every line contributes to both sets or to neither, which is what makes the
 * column and the bands two renderings of one answer rather than two answers
 * that agree when they are refreshed at the same moment.
 *
 * O(lines) per transaction that moved the blame — a few thousand map lookups on
 * the largest manifest anyone edits. The alternative is a viewport-scoped
 * plugin, which is a scroll handler and a second source of truth for what is
 * marked; this repository already has one bug from having two.
 */
function drawn(
  installed: boolean,
  anchors: ReadonlyMap<number, BlameAnchor>,
  doc: Text,
): BlameMarks {
  const entries = new RangeSetBuilder<GutterMarker>();
  const bands = new RangeSetBuilder<Decoration>();
  for (let number = 1; installed && number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (isTerminator(line, doc)) {
      continue;
    }
    const named = accountedFor(anchors, line);
    entries.add(line.from, line.from, named ?? UNCOMMITTED);
    if (named === null) {
      bands.add(line.from, line.from, uncommittedLine);
    }
  }
  return { installed, anchors, entries: entries.finish(), bands: bands.finish() };
}

/**
 * The anchors after one transaction's changes.
 *
 * `MapMode.TrackDel` is what drops an anchor whose line was deleted outright
 * rather than sliding it onto the line that took its place, and the association
 * is forward so that text inserted at a line's start pushes the anchor onto the
 * line its own text moved to — pressing Enter at the top of a line is the
 * common case, and it should carry the attribution down with the text.
 *
 * An anchor that lands mid-line is snapped back to that line's start rather
 * than discarded, and that is the difference between a mark that is shown and
 * one that is lost. Typing a character at the very front of a line moves its
 * anchor one place off the boundary; discarding it there would leave the line
 * marked uncommitted after the character was deleted again, until the next save.
 * Snapped, it is the text comparison in `accountedFor` that decides, and undoing
 * the edit brings the name straight back.
 */
function movedAnchors(
  anchors: ReadonlyMap<number, BlameAnchor>,
  transaction: Transaction,
): ReadonlyMap<number, BlameAnchor> {
  const moved = new Map<number, BlameAnchor>();
  for (const [at, anchor] of anchors) {
    const to = transaction.changes.mapPos(at, 1, MapMode.TrackDel);
    if (to === null) {
      continue;
    }
    const line = transaction.state.doc.lineAt(to);
    keepBest(moved, line.from, anchor, line.text);
  }
  return moved;
}

/**
 * Records an anchor at a position, resolving a collision in favour of the one
 * that describes the line.
 *
 * Two anchors land on one position whenever a whole line is deleted: the
 * removed line's start and its successor's both map to the same place. Picking
 * by text rather than by arrival order is what makes the surviving line keep
 * its own attribution instead of inheriting the deleted line's.
 */
function keepBest(
  anchors: Map<number, BlameAnchor>,
  at: number,
  anchor: BlameAnchor,
  text: string,
): void {
  const held = anchors.get(at);
  if (held === undefined || (held.text !== text && anchor.text === text)) {
    anchors.set(at, anchor);
  }
}

/**
 * The commit a line belongs to, or null when it belongs to none.
 *
 * The one rule both marks read, so that the column and the highlight are two
 * renderings of one answer rather than two answers that happen to agree today.
 */
function accountedFor(
  anchors: ReadonlyMap<number, BlameAnchor>,
  line: Line,
): BlameEntry | null {
  const anchor = anchors.get(line.from);
  return anchor !== undefined && anchor.text === line.text ? anchor.marker : null;
}

/**
 * Whether a line is the empty one a file's final newline leaves behind.
 *
 * Every text file that ends properly ends in a newline, and CodeMirror counts
 * what follows it as a line. git does not — a 40-line file blames 40 lines — so
 * without this every well-formed file would carry a permanent mark against a
 * line that is a terminator rather than content. No other editor annotates it
 * either.
 */
function isTerminator(line: Line, doc: Text): boolean {
  return line.length === 0 && line.number === doc.lines;
}

/**
 * The blame column (#52), as an extension that can be swapped in place.
 *
 * Nothing is added when the column is off, so a file nobody asked to blame
 * carries no gutter and no per-line callback at all — the highlight below is a
 * separate extension precisely so that turning this off does not take it with
 * it. When the column is on with no blame behind it every line's marker is null,
 * which leaves the gutter present and empty: the width comes from CSS, not from
 * its contents, so the code does not move when the entries come and go.
 *
 * `lineMarkerChange` is not optional here. CodeMirror redraws a gutter when the
 * viewport or the document moved, and installing a blame moves neither: without
 * it the entries would appear on the next keystroke instead of when they
 * arrived.
 */
export function blameExtension(shown: boolean): Extension {
  if (!shown) {
    return [];
  }
  return gutter({
    class: "cm-blame",
    markers: (view) => view.state.field(blameMarks).entries,
    // One element per visible line, including any line with nothing to say.
    //
    // Without it a gutter emits no element for an unmarked line and folds the
    // gap into the next element's top margin — arithmetic over block heights,
    // which under `EditorView.lineWrapping` are estimates until a measure pass
    // runs. Dense elements have no gap to absorb: every row of this column
    // stands opposite the line it describes because there is one of each.
    renderEmptyElements: true,
  });
}

/** The band drawn across a line that is in no commit. */
const uncommittedLine = Decoration.line({ class: "cm-uncommitted-line" });

/**
 * The highlight on every line that is in no commit (#64).
 *
 * It is a line decoration rather than a gutter mark because the question it
 * answers is about the code: "which of these lines have I changed" is asked
 * while reading the file, and an answer fourteen characters off to the left is
 * an answer in a column the user has usually turned off. It is drawn from the
 * same field as the column and runs whether or not `blameExtension` is in the
 * extension set.
 */
export const uncommittedLines = EditorView.decorations.from(
  blameMarks,
  (marks) => marks.bands,
);

/** One line's entry in the blame column. */
class BlameEntry extends GutterMarker {
  private readonly label: string;
  private readonly tooltip: string;
  private readonly uncommitted: boolean;

  constructor(commit: BlameCommit) {
    super();
    this.label = blameLabel(commit);
    this.tooltip = blameTooltip(commit);
    this.uncommitted = commit.uncommitted;
  }

  // CodeMirror keeps a marker's DOM when the new marker for a line compares
  // equal, so this is what stops every entry in the file being rebuilt on a
  // keystroke. Comparing the rendered strings rather than the commit is
  // deliberate: two entries that say the same thing are the same entry.
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameEntry &&
      other.label === this.label &&
      other.tooltip === this.tooltip
    );
  }

  override toDOM(): Node {
    const entry = document.createElement("span");
    entry.className = this.uncommitted
      ? "cm-blame-entry cm-blame-entry--uncommitted"
      : "cm-blame-entry";
    entry.textContent = this.label;
    entry.title = this.tooltip;
    return entry;
  }
}

/**
 * The entry a line git cannot account for carries.
 *
 * One shared marker for two cases that are the same fact: a line the user has
 * typed into since the blame was read, and a line git itself reported against
 * the all-zero SHA because it is in the working tree and in no commit. Neither
 * belongs to anybody, and saying so is more useful than a blank — a gap in the
 * column reads as "the column is broken", and this reads as what it is.
 *
 * A constant rather than one per line: `BlameEntry.eq` compares the rendered
 * strings, so every uncommitted line would compare equal anyway, and one
 * instance means CodeMirror keeps their DOM across a keystroke.
 */
const UNCOMMITTED = new BlameEntry({
  sha: "",
  author: "",
  authorTime: 0,
  summary: "",
  uncommitted: true,
});
