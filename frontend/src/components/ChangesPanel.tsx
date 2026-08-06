import type { FileStatus, Status } from "../lib/git";
import { NOT_A_REPOSITORY, NO_GIT } from "../lib/git";
import { fileBadge, groupChanges } from "../lib/gitStatus";
import { conflictedFiles } from "../lib/gitOps";
import { iconKind } from "../lib/tree";
import { FileIcon } from "./Icon";

export interface ChangesPanelProps {
  readonly status: Status;
  /** A real git failure, as opposed to the two degraded states the status
   * itself carries. */
  readonly error: string | null;
  /** Opens a changed file in the editor — the same intent the file tree
   * emits, so a row here and a row there do the same thing. */
  readonly onOpenFile: (path: string) => void;
}

/**
 * The per-project changes list (DESIGN.md §7): every path git reports,
 * grouped staged and unstaged, each row opening the file it names.
 *
 * It sits under the file tree rather than beside it because the two answer
 * different questions about the same repository — "what is in here" and "what
 * have I touched" — and a user looking for the second should not have to
 * expand directories to find it.
 *
 * It reports and it does not write (#39). The rows used to carry stage and
 * unstage buttons; what records work in m6t is the agent in the terminal
 * below, running the user's own git, and a button here would be a second
 * writer of the index that the agent cannot see. The staged/unstaged grouping
 * stays because it is what git reports — a path in the index and a path only
 * on disk are different facts, whoever put them there.
 */
export function ChangesPanel({ status, error, onOpenFile }: ChangesPanelProps) {
  const { staged, unstaged } = groupChanges(status);
  const conflicts = conflictedFiles(status);
  // A conflicted path groups with unstaged for badge purposes, but it gets its
  // own section here: it is the one state that stops a pull and a branch
  // switch, and it needs to say where to go about it.
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
          <ChangeGroup label="Staged" files={staged} onOpenFile={onOpenFile} />
          <ChangeGroup label="Unstaged" files={editable} onOpenFile={onOpenFile} />
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
 * a button that would pretend to resolve something.
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
        Resolve these in the terminal. m6t has no merge tool.
      </p>
      <ul className="changes__list">
        {files.map((file) => (
          <ChangeRow
            key={`conflict:${file.path}`}
            file={file}
            label="Conflicted"
            onOpenFile={onOpenFile}
          />
        ))}
      </ul>
    </>
  );
}

interface ChangeGroupProps {
  readonly label: string;
  readonly files: readonly FileStatus[];
  readonly onOpenFile: (path: string) => void;
}

/** One group's rows. An empty group renders nothing at all rather than a
 * heading over a blank space. */
function ChangeGroup({ label, files, onOpenFile }: ChangeGroupProps) {
  if (files.length === 0) {
    return null;
  }
  return (
    <>
      <h3 className="changes__group">
        {label} <span className="changes__count">{files.length}</span>
      </h3>
      <ul className="changes__list">
        {files.map((file) => (
          <ChangeRow
            key={`${label}:${file.path}`}
            file={file}
            label={label}
            onOpenFile={onOpenFile}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * One row: the whole thing opens the file it names.
 *
 * The row used to be a frame around a path button and an action button, which
 * is why the two were separate components. With the action gone (#39) the row
 * is the button, and the list reads as paths rather than as a column of
 * controls.
 */
function ChangeRow({
  file,
  label,
  onOpenFile,
}: {
  readonly file: FileStatus;
  readonly label: string;
  readonly onOpenFile: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="changes__row"
        // The badge is a glyph, so the row says in words what it means.
        aria-label={`${label}: ${file.path}`}
        onClick={() => {
          onOpenFile(file.path);
        }}
      >
        {/* data-badge rather than a modifier class: a badge can be `?`, which
            is not usable in a class-selector name. */}
        <span className="changes__badge" data-badge={fileBadge(file)} aria-hidden="true">
          {fileBadge(file)}
        </span>
        <span className="changes__icon">
          <FileIcon kind={iconKind(file.path, false)} />
        </span>
        <span className="changes__path">{file.path}</span>
        {file.origPath !== "" && <span className="changes__origin">← {file.origPath}</span>}
      </button>
    </li>
  );
}
