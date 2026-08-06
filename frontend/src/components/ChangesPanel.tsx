import type { FileStatus, Status } from "../lib/git";
import { NOT_A_REPOSITORY, NO_GIT } from "../lib/git";
import { fileBadge, groupChanges } from "../lib/gitStatus";
import { conflictedFiles, pathsOf, pathsOfAll } from "../lib/gitOps";

/** What a row's action button does, which is the only thing that differs
 * between the two groups. */
type RowAction = "stage" | "unstage" | "none";

export interface ChangesPanelProps {
  readonly status: Status;
  /** A real git failure, as opposed to the two degraded states the status
   * itself carries. */
  readonly error: string | null;
  /** Opens a changed file in the editor — the same intent the file tree
   * emits, so a row here and a row there do the same thing. */
  readonly onOpenFile: (path: string) => void;
  /** Adds paths to the index (#9). */
  readonly onStage: (paths: readonly string[]) => void;
  /** Removes paths from the index, leaving the working tree alone (#9). */
  readonly onUnstage: (paths: readonly string[]) => void;
  /** An operation is in flight; every action disables until it lands. */
  readonly busy: boolean;
}

/**
 * The per-project changes list (DESIGN.md §7): every path git reports,
 * grouped staged and unstaged, each row with the one action that moves it to
 * the other group.
 *
 * It sits under the file tree rather than beside it because the two answer
 * different questions about the same repository — "what is in here" and "what
 * have I touched" — and a user looking for the second should not have to
 * expand directories to find it.
 */
export function ChangesPanel({
  status,
  error,
  onOpenFile,
  onStage,
  onUnstage,
  busy,
}: ChangesPanelProps) {
  const { staged, unstaged } = groupChanges(status);
  const conflicts = conflictedFiles(status);
  // A conflicted path groups with unstaged for badge purposes, but it gets its
  // own section here: staging one marks it resolved, which is a decision, not
  // the routine move the same button makes on an ordinary edit.
  const editable = unstaged.filter((f) => !f.conflicted);

  return (
    <section className="changes" aria-label="Changes">
      <h2 className="changes__title">Changes</h2>

      {error !== null && (
        <p className="changes__error" role="alert">
          {error}
        </p>
      )}

      {status.availability === NO_GIT && (
        <p className="changes__empty">git was not found on your PATH.</p>
      )}
      {status.availability === NOT_A_REPOSITORY && (
        <p className="changes__empty">This project is not a git repository.</p>
      )}

      {status.availability !== NO_GIT && status.availability !== NOT_A_REPOSITORY && (
        <>
          <Conflicts files={conflicts} onOpenFile={onOpenFile} />
          <ChangeGroup
            label="Staged"
            files={staged}
            action="unstage"
            busy={busy}
            onOpenFile={onOpenFile}
            onAct={onUnstage}
          />
          <ChangeGroup
            label="Unstaged"
            files={editable}
            action="stage"
            busy={busy}
            onOpenFile={onOpenFile}
            onAct={onStage}
          />
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="changes__empty">Nothing changed.</p>
          )}
        </>
      )}
    </section>
  );
}

interface ConflictsProps {
  readonly files: readonly FileStatus[];
  readonly onOpenFile: (path: string) => void;
}

/**
 * Unmerged paths, with the instruction that goes with them.
 *
 * v1 ships no merge tool (DESIGN.md §7), and the terminal below is a real
 * shell in this repository — so the honest thing to show is where to go, not
 * a button that would pretend to resolve something. The rows have no action
 * for the same reason: `git add` on a conflicted file means "I have resolved
 * this", and a user who has not should not be one misclick from claiming so.
 */
function Conflicts({ files, onOpenFile }: ConflictsProps) {
  if (files.length === 0) {
    return null;
  }
  return (
    <>
      <h3 className="changes__group changes__group--conflict">
        Conflicted <span className="changes__count">{files.length}</span>
      </h3>
      <p className="changes__hint" role="status">
        Resolve these in the terminal, then stage them. m6t has no merge tool.
      </p>
      <ul className="changes__list">
        {files.map((file) => (
          <Row key={`conflict:${file.path}`} file={file} label="Conflicted">
            <FileButton file={file} label="Conflicted" onOpenFile={onOpenFile} />
          </Row>
        ))}
      </ul>
    </>
  );
}

interface ChangeGroupProps {
  readonly label: string;
  readonly files: readonly FileStatus[];
  readonly action: RowAction;
  readonly busy: boolean;
  readonly onOpenFile: (path: string) => void;
  readonly onAct: (paths: readonly string[]) => void;
}

/** One group's rows, with a group-level action in the heading. An empty group
 * renders nothing at all rather than a heading over a blank space. */
function ChangeGroup({ label, files, action, busy, onOpenFile, onAct }: ChangeGroupProps) {
  if (files.length === 0) {
    return null;
  }
  const verb = action === "stage" ? "Stage" : "Unstage";
  return (
    <>
      <h3 className="changes__group">
        {label} <span className="changes__count">{files.length}</span>
        <button
          type="button"
          className="changes__all"
          disabled={busy}
          onClick={() => {
            onAct(pathsOfAll(files));
          }}
        >
          {verb} all
        </button>
      </h3>
      <ul className="changes__list">
        {files.map((file) => (
          <Row key={`${label}:${file.path}`} file={file} label={label}>
            <FileButton file={file} label={label} onOpenFile={onOpenFile} />
            <button
              type="button"
              className="changes__action"
              // The glyph is a glyph; the accessible name says which file.
              aria-label={`${verb} ${file.path}`}
              title={verb}
              disabled={busy}
              onClick={() => {
                onAct(pathsOf(file));
              }}
            >
              {action === "stage" ? "+" : "−"}
            </button>
          </Row>
        ))}
      </ul>
    </>
  );
}

/** One row's frame. */
function Row({
  file,
  label,
  children,
}: {
  readonly file: FileStatus;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <li className="changes__item" data-testid={`change:${label}:${file.path}`}>
      {children}
    </li>
  );
}

/** The part of a row that opens the file. */
function FileButton({
  file,
  label,
  onOpenFile,
}: {
  readonly file: FileStatus;
  readonly label: string;
  readonly onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="changes__row"
      // The badge is a glyph, so the row says in words what it means.
      aria-label={`${label}: ${file.path}`}
      onClick={() => {
        onOpenFile(file.path);
      }}
    >
      {/* data-badge rather than a modifier class: a badge can be `?`, which is
          not usable in a class-selector name. */}
      <span className="changes__badge" data-badge={fileBadge(file)} aria-hidden="true">
        {fileBadge(file)}
      </span>
      <span className="changes__path">{file.path}</span>
      {file.origPath !== "" && <span className="changes__origin">← {file.origPath}</span>}
    </button>
  );
}
