import { KubeHealth } from "../../wailsjs/go/app/App";
import { kubewatch as models } from "../../wailsjs/go/models";
import type { kubewatch } from "../../wailsjs/go/models";
import type { UiIconName } from "../components/Icon";

/**
 * Live cluster health as the panel uses it (#12, DESIGN.md §5).
 *
 * Nothing here computes a verdict. kstatus decides what state an object is in
 * and `internal/kubewatch` decides what state the connection is in; this module
 * selects rows, groups them and names states. A health value invented in
 * TypeScript would be m6t's opinion competing with the one every other tool in
 * the ecosystem reports — see the Health doc comment in internal/kubewatch.
 */

/** The shapes, aliased from the generated bindings rather than restated. */
export type ObjectStatus = kubewatch.Status;
export type HealthNotice = kubewatch.Notice;
export type HealthSnapshot = kubewatch.Snapshot;

/**
 * The health operations the UI performs. An interface so the panel is testable
 * without a Wails runtime or a cluster, the shape `Kube` and `Registry`
 * already use.
 */
export interface Health {
  /**
   * The live state of everything that goes where rel goes, putting it under
   * watch if it is not already. rel is repository-relative.
   *
   * The answer covers the whole binding rather than the one path, and that is
   * deliberate: the backend keeps one session per cluster and namespace, so
   * moving between files in a project is a filter here rather than a
   * reconnection there. `forFile` is what narrows it to what is on screen.
   */
  snapshot: (name: string, rel: string) => Promise<HealthSnapshot>;
}

/** The health seam backed by the Wails binding. */
export const wailsHealth: Health = {
  snapshot: (name, rel) => KubeHealth(name, rel),
};

/**
 * Nothing observed yet: what the panel shows before the first answer.
 *
 * It is built through the generated model rather than as a literal because the
 * generated Snapshot carries a conversion helper a literal has no way to
 * supply — the same reason kube.ts goes through `models` for a project value.
 */
export const NO_HEALTH: HealthSnapshot = models.Snapshot.createFrom({
  phase: "connecting",
  reason: "",
  objects: [],
  notices: [],
});

/**
 * The objects one file declares.
 *
 * The panel is scoped to the open manifest rather than to the project, because
 * a project-wide list is a list nobody reads: a repository of any size fills the
 * pane with rows that have nothing to do with what is on screen, and the row
 * that matters is off the bottom. The question this section answers is "the file
 * I have open — is it in the cluster, and is it healthy?"
 *
 * The narrowing is here rather than in the backend on purpose. A session covers
 * a whole binding, so moving between files is this filter and not a
 * reconnection; scoping the watch itself to a file would make every tab switch
 * a fresh list against the API server.
 */
export function forFile(
  objects: readonly ObjectStatus[],
  file: string,
): readonly ObjectStatus[] {
  return objects.filter((object) => object.file === file);
}

/**
 * The notices about one file.
 *
 * Same scoping, and it is the case the scoping most earns its keep in: a
 * document in the open file that would not parse is the reason its object is
 * missing from the list above, and the two belong on screen together.
 */
export function noticesFor(
  notices: readonly HealthNotice[],
  file: string,
): readonly HealthNotice[] {
  return notices.filter((notice) => notice.file === file);
}

/**
 * A short phrase for the connection state, for the panel's status line.
 *
 * Lower case and terse, because it sits inline beside the file name rather than
 * in a sentence of its own — the connection is context for the rows, and a
 * banner-sized announcement of "Watching" would be the loudest thing in a
 * section whose actual content is underneath it.
 *
 * The phase is compared as a string rather than against a union of its own,
 * because what crosses the bridge is whatever the backend sends: the values are
 * kubewatch.Phase's, and a build that met one it did not know has to render it
 * rather than fail to match it. See the default arm.
 */
export function phaseLabel(snapshot: HealthSnapshot): string {
  switch (snapshot.phase) {
    case "idle":
      return snapshot.reason === "" ? "not watching" : snapshot.reason;
    case "connecting":
      return "connecting";
    case "watching":
      return "watching";
    case "reconnecting":
      return "reconnecting";
    case "unauthorized":
      return "cluster refused this user";
    default:
      // A phase a later backend added. Showing it beats showing nothing: the
      // user learns the connection is in a state this build does not name,
      // which is true and is more than an empty line would say.
      return snapshot.phase;
  }
}

/**
 * Whether a phase means the object list can be trusted as current.
 *
 * The list is always shown — a reconnecting panel that blanked its rows would
 * throw away the last thing anyone knew — but it is marked stale, because
 * "these were the states a minute ago" and "these are the states" are different
 * claims and the panel must not make the second one when only the first is
 * true.
 */
export function isLive(snapshot: HealthSnapshot): boolean {
  return snapshot.phase === "watching";
}

/** Whether a phase is a failure the user can act on. */
export function isFailing(snapshot: HealthSnapshot): boolean {
  return snapshot.phase === "reconnecting" || snapshot.phase === "unauthorized";
}

/** One kind's worth of rows, for the grouped list DESIGN.md §5 describes. */
export interface KindGroup {
  readonly kind: string;
  readonly objects: readonly ObjectStatus[];
}

/**
 * Groups objects by kind, keeping the order they arrived in.
 *
 * Order is preserved rather than re-sorted here for the reason the backend
 * sorts at all: a panel whose rows move as objects change health is unreadable
 * during exactly the rollout it exists to show. The backend's order is already
 * kind-major, so this is a fold rather than a sort — and folding rather than
 * sorting is also what keeps the two from ever disagreeing.
 */
export function byKind(objects: readonly ObjectStatus[]): KindGroup[] {
  const groups: KindGroup[] = [];
  const at = new Map<string, ObjectStatus[]>();

  for (const object of objects) {
    let bucket = at.get(object.kind);
    if (bucket === undefined) {
      bucket = [];
      at.set(object.kind, bucket);
      groups.push({ kind: object.kind, objects: bucket });
    }
    bucket.push(object);
  }

  return groups;
}

/**
 * The icon for one object's health (Icon.tsx's UI set).
 *
 * A health value this build does not know falls to the unknown mark rather
 * than to nothing. The backend is free to add a kstatus state — the wire values
 * are kstatus's, not m6t's — and a row that rendered no icon would read as a
 * row with no answer instead of one this build cannot name.
 */
export function healthIcon(health: string): UiIconName {
  switch (health) {
    case "Current":
      return "health-current";
    case "InProgress":
      return "health-progress";
    case "Failed":
      return "health-failed";
    case "NotFound":
      return "health-absent";
    case "Terminating":
      return "health-terminating";
    default:
      return "health-unknown";
  }
}

/**
 * What a row says under its name, or "" when it has nothing to add.
 *
 * Current says nothing, and that silence is the design: in a pane 280px wide a
 * verdict on every row is a second column of text competing with the names, and
 * the state anyone is scanning for is never "fine". So the quiet rows stay one
 * line and only the ones worth reading grow a second.
 *
 * The backend's own message is preferred wherever there is one — kstatus's
 * words for a rollout, the API server's for an object nobody may read — because
 * both say more than any label this file could carry.
 */
export function healthNote(object: ObjectStatus): string {
  if (object.health === "Current") {
    return "";
  }
  if (object.message !== "") {
    return object.message;
  }
  return stateLabel(object.health).toLowerCase();
}

/**
 * The full sentence for one object, for the row's accessible name and its
 * tooltip.
 *
 * Unlike healthNote this never elides: a screen reader gets the verdict on
 * every row, including the quiet ones, so the silence above is a visual
 * economy rather than information only sighted users receive.
 */
export function healthLabel(object: ObjectStatus): string {
  const state = stateLabel(object.health);
  return object.message === "" ? state : `${state}: ${object.message}`;
}

function stateLabel(health: string): string {
  switch (health) {
    case "Current":
      return "Current";
    case "InProgress":
      return "In progress";
    case "Failed":
      return "Failed";
    case "NotFound":
      return "Not in the cluster";
    case "Terminating":
      return "Terminating";
    case "Unknown":
      return "No verdict";
    default:
      return health;
  }
}
