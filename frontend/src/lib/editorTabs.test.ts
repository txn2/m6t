import { describe, expect, it } from "vitest";
import type { EditorTab } from "./editorTabs";
import {
  basename,
  canSave,
  findTabKey,
  formatSize,
  isDirty,
  kindFromIcon,
  mapTab,
  newTab,
  patchTab,
  readOnlyNotice,
  removeTab,
  resolveKeepMine,
  resolveTakeDisk,
  selectionAfterClose,
  tabsForProject,
  withEdit,
  withError,
  withExternalChange,
  withLoaded,
  withMode,
  withSaveFailed,
  withSaved,
  withSaving,
} from "./editorTabs";
import type { FileContent } from "./files";

/** A ReadFile result, defaulting to a small editable LF file. */
const file = (content: string, over: Partial<FileContent> = {}): FileContent =>
  ({
    content,
    crlf: false,
    mixedEol: false,
    readOnly: false,
    size: content.length,
    ...over,
  }) as FileContent;

const blank = (path = "deploy.yaml"): EditorTab =>
  newTab("k0", "infra", "/w/infra", path, "yaml");

const ready = (content: string, over: Partial<FileContent> = {}): EditorTab =>
  withLoaded(blank(), file(content, over));

const strip = (...paths: string[]): EditorTab[] =>
  paths.map((path, i) => newTab(`k${String(i)}`, "infra", "/w/infra", path, "yaml"));

describe("opening tabs", () => {
  it("starts a tab loading, with no content yet", () => {
    const tab = blank();

    expect(tab.status).toBe("loading");
    expect(tab.content).toBe("");
    expect(tab.title).toBe("deploy.yaml");
  });

  it("titles a tab from the last path segment", () => {
    expect(basename("manifests/base/deploy.yaml")).toBe("deploy.yaml");
    expect(basename("README.md")).toBe("README.md");
  });

  it("defaults markdown to preview and everything else to edit", () => {
    expect(newTab("k", "p", "/w", "a.md", "markdown").mode).toBe("preview");
    expect(newTab("k", "p", "/w", "a.yaml", "yaml").mode).toBe("edit");
    expect(newTab("k", "p", "/w", "a.txt", "text").mode).toBe("edit");
  });

  it("buckets a tab's kind from the tree's icon kind", () => {
    expect(kindFromIcon("yaml")).toBe("yaml");
    expect(kindFromIcon("md")).toBe("markdown");
    expect(kindFromIcon("file")).toBe("text");
  });

  it("finds an already-open tab for a project/path pair", () => {
    const tabs = strip("a.yaml", "b.yaml");

    expect(findTabKey(tabs, "infra", "b.yaml")).toBe("k1");
    expect(findTabKey(tabs, "infra", "c.yaml")).toBeNull();
    expect(findTabKey(tabs, "other", "a.yaml")).toBeNull();
  });

  it("keeps every project's tabs in one list, filtering only for display", () => {
    const tabs = [
      newTab("k0", "infra", "/w/infra", "a.yaml", "yaml"),
      newTab("k1", "team-x", "/w/team-x", "b.yaml", "yaml"),
    ];

    expect(tabsForProject(tabs, "infra").map((t) => t.key)).toEqual(["k0"]);
    expect(tabsForProject(tabs, null)).toEqual([]);
  });
});

describe("dirtiness", () => {
  it("is never dirty while loading or errored", () => {
    expect(isDirty(blank())).toBe(false);
    expect(isDirty(withError(blank(), "boom"))).toBe(false);
  });

  it("is clean immediately after a load", () => {
    expect(isDirty(ready("a: 1\n"))).toBe(false);
  });

  it("is dirty once the buffer diverges from the baseline", () => {
    const edited = withEdit(ready("a: 1\n"), "a: 2\n");

    expect(isDirty(edited)).toBe(true);
    expect(edited.baseline).toBe("a: 1\n");
  });

  it("is clean again when an edit is undone back to the baseline", () => {
    const undone = withEdit(withEdit(ready("a: 1\n"), "a: 2\n"), "a: 1\n");

    expect(isDirty(undone)).toBe(false);
  });
});

describe("the read-only guard", () => {
  it("ignores edits to a read-only tab", () => {
    const tab = ready("a: 1\n", { readOnly: true, size: 3_000_000 });
    const edited = withEdit(tab, "a: 2\n");

    expect(edited.content).toBe("a: 1\n");
    expect(isDirty(edited)).toBe(false);
  });

  it("explains a mixed-line-endings file in terms of what a save would do", () => {
    const tab = ready("a: 1\n", { readOnly: true, mixedEol: true });

    expect(readOnlyNotice(tab)).toContain("line endings");
    expect(readOnlyNotice(tab)).toContain("rewrite every line");
  });

  it("explains a large file by its size", () => {
    const tab = ready("x", { readOnly: true, size: 3 * 1024 * 1024 });

    expect(readOnlyNotice(tab)).toContain("3.0 MB");
  });

  it("has no notice for an editable file", () => {
    expect(readOnlyNotice(ready("a: 1\n"))).toBeNull();
  });

  it("formats sizes in the units a person reads", () => {
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatSize(4096)).toBe("4 KB");
  });
});

describe("saving", () => {
  it("allows a save only when the tab is dirty", () => {
    expect(canSave(ready("a: 1\n"))).toBe(false);
    expect(canSave(withEdit(ready("a: 1\n"), "a: 2\n"))).toBe(true);
  });

  it("refuses a save on a read-only tab", () => {
    const tab = { ...ready("a: 1\n"), readOnly: true, content: "a: 2\n" };

    expect(canSave(tab)).toBe(false);
  });

  it("refuses a second save while one is already in flight", () => {
    const inFlight = withSaving(withEdit(ready("a: 1\n"), "a: 2\n"));

    expect(canSave(inFlight)).toBe(false);
  });

  // Letting Cmd+S through here would discard whatever the other writer just
  // did — the whole reason the conflict prompt exists.
  it("refuses a save while a conflict is unresolved", () => {
    const conflicted = withExternalChange(
      withEdit(ready("a: 1\n"), "a: 2\n"),
      file("a: 3\n"),
    );

    expect(conflicted.conflict).toBe("a: 3\n");
    expect(canSave(conflicted)).toBe(false);
  });

  it("allows a save again once the conflict is resolved either way", () => {
    const conflicted = withExternalChange(
      withEdit(ready("a: 1\n"), "a: 2\n"),
      file("a: 3\n"),
    );

    expect(canSave(resolveKeepMine(conflicted))).toBe(true);
    // take-disk leaves nothing to save: the buffer now equals disk.
    expect(isDirty(resolveTakeDisk(conflicted))).toBe(false);
  });

  it("clears dirty against the buffer that was actually written", () => {
    const edited = withEdit(ready("a: 1\n"), "a: 2\n");
    const saved = withSaved(withSaving(edited), "a: 2\n");

    expect(isDirty(saved)).toBe(false);
    expect(saved.saving).toBe(false);
  });

  // A write is asynchronous and the user keeps typing through it. Advancing
  // the baseline to the current buffer rather than to the bytes that were
  // written would mark those newer keystrokes as already on disk.
  it("keeps keystrokes made while the save was in flight dirty", () => {
    const inFlight = withSaving(withEdit(ready("a: 1\n"), "a: 2\n"));
    const typedMore = { ...inFlight, content: "a: 2\nb: 3\n" };

    const saved = withSaved(typedMore, "a: 2\n");

    expect(saved.baseline).toBe("a: 2\n");
    expect(saved.content).toBe("a: 2\nb: 3\n");
    expect(isDirty(saved)).toBe(true);
  });

  it("keeps the buffer when a save fails", () => {
    const edited = withEdit(ready("a: 1\n"), "a: 2\n");

    const failed = withSaveFailed(withSaving(edited), "permission denied");

    expect(failed.content).toBe("a: 2\n");
    expect(failed.error).toBe("permission denied");
    expect(failed.saving).toBe(false);
    expect(canSave(failed)).toBe(true);
  });
});

describe("external-change reconciliation", () => {
  it("silently adopts a disk change on a clean tab", () => {
    const next = withExternalChange(ready("a: 1\n"), file("a: 1\nb: 2\n"));

    expect(next.content).toBe("a: 1\nb: 2\n");
    expect(next.baseline).toBe("a: 1\nb: 2\n");
    expect(isDirty(next)).toBe(false);
  });

  it("adopts a change in read-only status on reload", () => {
    const next = withExternalChange(ready("a: 1\n"), file("x", { readOnly: true, mixedEol: true }));

    expect(next.readOnly).toBe(true);
    expect(next.mixedEol).toBe(true);
  });

  // m6t's own save fires the watcher, which lands right back here. Treating
  // that echo as a conflict would prompt the user after every single save.
  it("leaves a dirty tab alone when disk still matches its baseline", () => {
    const tab = withEdit(ready("a: 1\n"), "a: 2\n");

    const next = withExternalChange(tab, file("a: 1\n"));

    expect(next.content).toBe("a: 2\n");
    expect(next.conflict).toBeNull();
  });

  it("flags a real conflict without touching the buffer or the baseline", () => {
    const tab = withEdit(ready("a: 1\n"), "a: 2\n");

    const next = withExternalChange(tab, file("a: 3\n"));

    expect(next.content).toBe("a: 2\n");
    expect(next.baseline).toBe("a: 1\n");
    expect(next.conflict).toBe("a: 3\n");
  });

  it("ignores a tab that has not finished loading", () => {
    const loading = blank();

    expect(withExternalChange(loading, file("a: 1\n"))).toBe(loading);
  });

  // The event that races a save in flight is describing the file mid-write.
  it("ignores a tab whose save is still in flight", () => {
    const inFlight = withSaving(withEdit(ready("a: 1\n"), "a: 2\n"));

    expect(withExternalChange(inFlight, file("a: 9\n"))).toBe(inFlight);
  });

  it("keep-mine advances the baseline but leaves the buffer, so the tab stays dirty", () => {
    const conflicted = withExternalChange(withEdit(ready("a: 1\n"), "a: 2\n"), file("a: 3\n"));

    const resolved = resolveKeepMine(conflicted);

    expect(resolved.content).toBe("a: 2\n");
    expect(resolved.baseline).toBe("a: 3\n");
    expect(resolved.conflict).toBeNull();
    expect(isDirty(resolved)).toBe(true);
  });

  // Without the baseline move above, the very next tree event would re-raise
  // the identical conflict the user just dismissed.
  it("does not re-raise a conflict the user chose to keep through", () => {
    const kept = resolveKeepMine(
      withExternalChange(withEdit(ready("a: 1\n"), "a: 2\n"), file("a: 3\n")),
    );

    expect(withExternalChange(kept, file("a: 3\n")).conflict).toBeNull();
  });

  it("take-disk discards the buffer and adopts disk, clearing dirty", () => {
    const conflicted = withExternalChange(withEdit(ready("a: 1\n"), "a: 2\n"), file("a: 3\n"));

    const resolved = resolveTakeDisk(conflicted);

    expect(resolved.content).toBe("a: 3\n");
    expect(resolved.baseline).toBe("a: 3\n");
    expect(isDirty(resolved)).toBe(false);
  });

  it("resolving with no conflict is a no-op", () => {
    const tab = ready("a: 1\n");

    expect(resolveKeepMine(tab)).toBe(tab);
    expect(resolveTakeDisk(tab)).toBe(tab);
  });
});

describe("the strip", () => {
  it("toggles a markdown tab between preview and edit", () => {
    expect(withMode(newTab("k", "p", "/w", "a.md", "markdown"), "edit").mode).toBe("edit");
  });

  it("patches only the named tab", () => {
    const tabs = patchTab(strip("a.yaml", "b.yaml"), "k1", { title: "renamed" });

    expect(tabs[1].title).toBe("renamed");
    expect(tabs[0].title).toBe("a.yaml");
  });

  it("maps only the named tab", () => {
    const tabs = mapTab(strip("a.yaml", "b.yaml"), "k0", (t) => withError(t, "boom"));

    expect(tabs[0].error).toBe("boom");
    expect(tabs[1].error).toBeNull();
  });

  it("removes the named tab only", () => {
    expect(removeTab(strip("a.yaml", "b.yaml"), "k0").map((t) => t.key)).toEqual(["k1"]);
  });

  it("leaves the selection alone when closing an inactive tab", () => {
    expect(selectionAfterClose(strip("a", "b", "c"), "k0", "k1")).toBe("k1");
  });

  it("selects the right-hand neighbour when closing the active tab", () => {
    expect(selectionAfterClose(strip("a", "b", "c"), "k1", "k1")).toBe("k2");
  });

  it("falls back to the left-hand neighbour when the active tab is last", () => {
    expect(selectionAfterClose(strip("a", "b", "c"), "k2", "k2")).toBe("k1");
  });

  it("selects nothing when the last tab closes", () => {
    expect(selectionAfterClose(strip("a"), "k0", "k0")).toBeNull();
  });
});
