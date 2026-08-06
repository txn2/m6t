import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Circle,
  EllipsisVertical,
  Eye,
  Layers,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import type { IconKind } from "../lib/tree";

import actionsSvg from "../icons/material/github-actions-workflow.svg";
import consoleSvg from "../icons/material/console.svg";
import dockerSvg from "../icons/material/docker.svg";
import documentSvg from "../icons/material/document.svg";
import folderOpenSvg from "../icons/material/folder-open.svg";
import folderSvg from "../icons/material/folder.svg";
import goSvg from "../icons/material/go.svg";
import helmSvg from "../icons/material/helm.svg";
import javascriptSvg from "../icons/material/javascript.svg";
import jsonSvg from "../icons/material/json.svg";
import kubernetesSvg from "../icons/material/kubernetes.svg";
import makefileSvg from "../icons/material/makefile.svg";
import markdownSvg from "../icons/material/markdown.svg";
import reactTsSvg from "../icons/material/react_ts.svg";
import tomlSvg from "../icons/material/toml.svg";
import typescriptSvg from "../icons/material/typescript.svg";
import yamlSvg from "../icons/material/yaml.svg";

/**
 * The app's icons (issue #38), in one module so the tree, the editor tab
 * strip, the terminal tab strip and the changes rows cannot drift into three
 * different pictures for the same thing.
 *
 * Two sources, because the two jobs have opposite requirements:
 *
 * - **File-type and brand marks** (`FileIcon`) come from vendored
 *   material-icon-theme SVGs (`../icons/material`, MIT — see its README).
 *   They carry their own colours: a Kubernetes wheel is only the Kubernetes
 *   wheel in Kubernetes blue, in either theme. Vite inlines them as data
 *   URIs at build time, so an `<img>` here is a string in the bundle, not a
 *   request — nothing is fetched at runtime, which is what Wails' embedded
 *   filesystem needs.
 * - **UI chrome** (`UiIcon`) comes from lucide-react (ISC), whose icons draw
 *   in `currentColor` and so inherit the token colour of whatever they sit
 *   in — a close button has to go from muted to foreground on hover, which
 *   an `<img>` cannot do.
 */

/** The artwork for each file-type bucket that has a vendored SVG. */
const FILE_SVG: Readonly<Record<Exclude<IconKind, "kustomize">, string>> = {
  dir: folderSvg,
  kubernetes: kubernetesSvg,
  helm: helmSvg,
  actions: actionsSvg,
  yaml: yamlSvg,
  md: markdownSvg,
  go: goSvg,
  ts: typescriptSvg,
  tsx: reactTsSvg,
  js: javascriptSvg,
  json: jsonSvg,
  shell: consoleSvg,
  toml: tomlSvg,
  docker: dockerSvg,
  make: makefileSvg,
  file: documentSvg,
};

export interface FileIconProps {
  readonly kind: IconKind;
  /** Directories only: an expanded one shows the open folder. */
  readonly expanded?: boolean;
}

/**
 * The icon for one file or directory.
 *
 * Always decorative: every call site puts the file's name in the text
 * alongside it, so an accessible name here would only make screen readers
 * say it twice. `data-icon` is what tests assert on, since an `<img>` with
 * an empty alt has nothing else to identify it by.
 */
export function FileIcon({ kind, expanded = false }: FileIconProps) {
  // The one bucket material-icon-theme has no artwork for: the set ships
  // `kusto` (Azure Data Explorer), a different product, and kustomize's own
  // mark is not under a licence on the allowlist. Lucide's stacked layers is
  // the honest stand-in, and narrowing it out here is what keeps FILE_SVG
  // total over every remaining kind rather than a partial map with a silent
  // fallback.
  if (kind === "kustomize") {
    return <Layers className="icon" data-icon="kustomize" aria-hidden="true" focusable="false" />;
  }
  const open = kind === "dir" && expanded;
  return (
    <img
      className="icon"
      src={open ? folderOpenSvg : FILE_SVG[kind]}
      alt=""
      data-icon={open ? "dir-open" : kind}
    />
  );
}

/** The chrome icons, by the action they stand for rather than by shape —
 * a call site asks for "close", not for an X. */
const UI_LUCIDE = {
  "chevron-right": ChevronRight,
  "chevron-down": ChevronDown,
  close: X,
  plus: Plus,
  menu: EllipsisVertical,
  dirty: Circle,
  edit: Pencil,
  preview: Eye,
  up: ArrowUp,
  down: ArrowDown,
} as const satisfies Readonly<Record<string, LucideIcon>>;

export type UiIconName = keyof typeof UI_LUCIDE;

export interface UiIconProps {
  readonly name: UiIconName;
  /** Extra classes for call sites that colour or size one icon specially. */
  readonly className?: string;
}

/**
 * A chrome icon. Decorative for the same reason `FileIcon` is: these sit
 * inside buttons that already carry an `aria-label`, and the few that do not
 * sit beside their own visible text.
 */
export function UiIcon({ name, className }: UiIconProps) {
  const Lucide = UI_LUCIDE[name];
  return (
    <Lucide
      className={className === undefined ? "icon" : `icon ${className}`}
      data-icon={name}
      aria-hidden="true"
      focusable="false"
    />
  );
}
