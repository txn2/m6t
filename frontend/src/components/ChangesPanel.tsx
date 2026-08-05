import type { FileStatus, Status } from "../lib/git";
import { NOT_A_REPOSITORY, NO_GIT } from "../lib/git";
import { fileBadge, groupChanges } from "../lib/gitStatus";

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
 * grouped staged and unstaged.
 *
 * It sits under the file tree rather than beside it because the two answer
 * different questions about the same repository — "what is in here" and "what
 * have I touched" — and a user looking for the second should not have to
 * expand directories to find it.
 */
export function ChangesPanel({ status, error, onOpenFile }: ChangesPanelProps) {
  const { staged, unstaged } = groupChanges(status);

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
          <ChangeGroup label="Staged" files={staged} onOpenFile={onOpenFile} />
          <ChangeGroup label="Unstaged" files={unstaged} onOpenFile={onOpenFile} />
          {staged.length === 0 && unstaged.length === 0 && (
            <p className="changes__empty">Nothing changed.</p>
          )}
        </>
      )}
    </section>
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
          <li key={`${label}:${file.path}`}>
            <button
              type="button"
              className="changes__row"
              // The badge is a glyph, so the row says in words what it means.
              aria-label={`${label}: ${file.path}`}
              onClick={() => {
                onOpenFile(file.path);
              }}
            >
              {/* data-badge rather than a modifier class: a badge can be `?`,
                  which is not usable in a class-selector name. */}
              <span className="changes__badge" data-badge={fileBadge(file)} aria-hidden="true">
                {fileBadge(file)}
              </span>
              <span className="changes__path">{file.path}</span>
              {file.origPath !== "" && (
                <span className="changes__origin">← {file.origPath}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
