import { ReadFile, WriteFile } from "../../wailsjs/go/app/App";
import type { watch } from "../../wailsjs/go/models";

/** One file's content, aliased so a Go struct change fails type-checking
 * here rather than disagreeing silently — the same convention `tree.ts`'s
 * `Entry` alias uses. */
export type FileContent = watch.FileContent;

/**
 * The editor's Wails-binding seam (DESIGN.md §5), the same shape
 * `lib/directory.ts`'s `Directory` already takes: an interface a component
 * or hook can be tested against without a Wails runtime, backed by the
 * generated bindings by default.
 *
 * Every operation takes a project's root path directly, the same convention
 * `Directory` and `OpenTerminal`'s `cwd` already use.
 */
export interface Files {
  read: (root: string, relPath: string) => Promise<FileContent>;
  write: (
    root: string,
    relPath: string,
    content: string,
    crlf: boolean,
  ) => Promise<void>;
}

/** The files seam backed by the generated Wails bindings. */
export const wailsFiles: Files = {
  read: (root, relPath) => ReadFile(root, relPath),
  write: (root, relPath, content, crlf) => WriteFile(root, relPath, content, crlf),
};
