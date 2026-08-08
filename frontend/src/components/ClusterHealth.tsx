import type { HealthNotice, HealthSnapshot, ObjectStatus } from "../lib/health";
import {
  byKind,
  forFile,
  healthIcon,
  healthLabel,
  healthNote,
  isFailing,
  isLive,
  noticesFor,
  phaseLabel,
} from "../lib/health";
import type { HealthController } from "../lib/useHealth";
import { UiIcon } from "./Icon";

export interface ClusterHealthProps {
  readonly health: HealthController;
}

/**
 * Live cluster health for the open manifest (#12, DESIGN.md §5).
 *
 * Two things are on screen and they answer different questions. The rows say
 * what each object this file declares was doing when it was last observed; the
 * line above them says whether observing is still happening. A panel that merged
 * the two would have to invent a per-object health meaning "we no longer know",
 * and the failure this section exists to rule out is precisely a column of green
 * ticks over a connection that died ten minutes ago.
 *
 * It is scoped to the open file rather than to the project. The pane is 280px
 * wide and sits under three other sections, so a project-wide list is one whose
 * interesting row is off the bottom — see `forFile`. What that buys is a section
 * short enough to read at a glance: usually three or four rows, one per object
 * the file declares.
 *
 * The rows themselves are a column of names and marks and nothing else. A
 * verdict on every row would be a second column of text competing with the
 * names at a width that has no room for two, and the state anyone is scanning
 * for is never "fine" — so a healthy object is one quiet line and only the ones
 * worth reading grow a second. The full verdict is still on every row for a
 * screen reader and on hover (see `healthLabel`).
 */
export function ClusterHealth({ health }: ClusterHealthProps) {
  const { snapshot, file } = health;

  return (
    <section className="panel__section health" aria-label="Cluster health">
      <h3 className="panel__section-title">
        <UiIcon name="cluster" />
        Live status
      </h3>

      {file === null ? (
        <p className="panel__empty">Open a manifest to see what it declares.</p>
      ) : (
        <Declared snapshot={snapshot} file={file} health={health} />
      )}
    </section>
  );
}

/** The open file's objects, and the state of the connection under them. */
function Declared({
  snapshot,
  file,
  health,
}: {
  readonly snapshot: HealthSnapshot;
  readonly file: string;
  readonly health: HealthController;
}) {
  const objects = forFile(snapshot.objects, file);
  const notices = noticesFor(snapshot.notices, file);

  return (
    <>
      <Connection health={health} file={file} />

      {objects.length === 0 ? (
        <p className="panel__empty">{emptyLine(snapshot, notices.length > 0)}</p>
      ) : (
        <ul className="health__kinds" data-stale={isLive(snapshot) ? undefined : "true"}>
          {byKind(objects).map((group) => (
            <li key={group.kind} className="health__kind">
              <h4 className="health__kind-name">{group.kind}</h4>
              <ul className="health__objects">
                {group.objects.map((object) => (
                  <ObjectRow key={rowKey(object)} object={object} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <Notices notices={notices} />
    </>
  );
}

/**
 * Which file, and whether its states are being kept current.
 *
 * One line, with the phase as a coloured dot and a lower-case word after the
 * file's own name. It is always rendered, including while watching, because its
 * absence would look exactly like a panel that had stopped saying anything —
 * and it is small, because the connection is context for the rows rather than
 * the subject of the section.
 */
function Connection({
  health,
  file,
}: {
  readonly health: HealthController;
  readonly file: string;
}) {
  const { snapshot, error, refresh } = health;
  const failing = isFailing(snapshot) || error !== null;

  return (
    <div className="health__connection" data-phase={snapshot.phase} data-failing={failing || undefined}>
      <p className="health__source" title={file}>
        {basename(file)}
      </p>

      {/* A live region rather than an alert. The phase changes on its own as
          the connection comes and goes, which is what `status` describes; an
          alert would interrupt a screen reader every time a watch was renewed. */}
      <p className="health__phase" role="status">
        <span className="health__dot" aria-hidden="true" />
        {phaseLabel(snapshot)}
      </p>

      {/* The backend's own words, verbatim (CLAUDE.md): an expired credential
          and an unreachable API server read very differently, and a translation
          would lose the part that says which. Only when something is wrong —
          a healthy connection has nothing to add to the word above. */}
      {isFailing(snapshot) && snapshot.reason !== "" && (
        <pre className="health__reason">{snapshot.reason}</pre>
      )}
      {error !== null && <p className="panel__error">{error}</p>}

      {failing && (
        <button type="button" className="panel__action" onClick={refresh}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * One declared object: its mark and its name, plus a second line when there is
 * something to say.
 *
 * The accessible name carries the full verdict whatever the row shows, so the
 * economy above is a visual one and not information withheld from anyone using
 * a screen reader.
 */
function ObjectRow({ object }: { readonly object: ObjectStatus }) {
  const label = healthLabel(object);
  const note = healthNote(object);

  return (
    <li
      className="health__object"
      data-health={object.health}
      aria-label={`${object.kind} ${object.name}: ${label}`}
      title={label}
    >
      <span className="health__row">
        <UiIcon name={healthIcon(object.health)} className="health__mark" />
        <span className="health__name">{object.name}</span>
      </span>
      {note !== "" && <span className="health__note">{note}</span>}
    </li>
  );
}

/**
 * What this file could not be indexed for.
 *
 * Scoped to the open file like everything else here, and that is what makes it
 * worth showing at all: a document in this file that would not parse is the
 * reason an object the user expected is not in the list above.
 */
function Notices({ notices }: { readonly notices: readonly HealthNotice[] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <ul className="health__notices">
      {notices.map((notice) => (
        <li key={notice.reason} className="health__notice">
          {notice.reason}
        </li>
      ))}
    </ul>
  );
}

/**
 * What an empty list says.
 *
 * A file that produced a notice is not a file that declares nothing — it is one
 * whose declarations could not be read, and the notice below says why. Saying
 * "declares no Kubernetes objects" over the top of it would be the panel
 * contradicting itself.
 */
function emptyLine(snapshot: HealthSnapshot, noticed: boolean): string {
  if (noticed) {
    return "Nothing could be indexed in this file.";
  }
  if (snapshot.phase === "idle") {
    return "Nothing to watch here.";
  }
  return "This file declares no Kubernetes objects.";
}

/** The file's own name. The path is on the title attribute and in the
 * breadcrumb above the editor; this pane has no room to repeat it. */
function basename(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/**
 * A row's key.
 *
 * The identity is the object's, not the file's: the rows here all come from one
 * file, and a file that declares the same object twice is a file with a real
 * duplicate in it rather than two rows to tell apart.
 */
function rowKey(object: ObjectStatus): string {
  return `${object.apiVersion}/${object.kind}/${object.namespace}/${object.name}`;
}
