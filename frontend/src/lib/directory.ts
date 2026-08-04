import {
  CreateEntry,
  DeleteEntry,
  ListDirectory,
  RenameEntry,
} from "../../wailsjs/go/app/App";
import type { Entry } from "./tree";

/**
 * The file tree's Wails-binding seam (DESIGN.md §5), the same shape
 * `lib/projects.ts`'s `Registry` already takes: an interface a component or
 * hook can be tested against without a Wails runtime, backed by the
 * generated bindings by default.
 *
 * Every operation takes a project's root path directly rather than its
 * name — the same convention the terminal strip's `cwd` already uses
 * (`internal/app.OpenTerminal`) — so this seam needs nothing from the
 * project registry to work.
 */
export interface Directory {
  list: (root: string, relPath: string) => Promise<Entry[]>;
  create: (root: string, relPath: string, isDir: boolean) => Promise<void>;
  rename: (root: string, fromRelPath: string, toRelPath: string) => Promise<void>;
  remove: (root: string, relPath: string) => Promise<void>;
}

/** The directory seam backed by the generated Wails bindings. */
export const wailsDirectory: Directory = {
  list: (root, relPath) => ListDirectory(root, relPath),
  create: (root, relPath, isDir) => CreateEntry(root, relPath, isDir),
  rename: (root, fromRelPath, toRelPath) => RenameEntry(root, fromRelPath, toRelPath),
  remove: (root, relPath) => DeleteEntry(root, relPath),
};
