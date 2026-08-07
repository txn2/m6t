import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorTab } from "./editorTabs";
import { newTab, withBlame, withEdit, withLoaded } from "./editorTabs";
import type { Blame } from "./git";
import { emptyBlame } from "./git";
import { useBlame } from "./useBlame";

const blame: Blame = {
  commits: [
    {
      sha: "a1b2c3d",
      author: "Craig Johnston",
      authorTime: 1_754_400_000,
      summary: "first",
      uncommitted: false,
    },
  ],
  lines: [0],
};

/** A ready tab holding `content`, with the blame column on unless told
 * otherwise. */
function tab(content = "a: 1\n", on = true): EditorTab {
  const loaded = withLoaded(newTab("k0", "infra", "/w/infra", "deploy.yaml", "yaml"), {
    content,
    crlf: false,
    mixedEol: false,
    readOnly: false,
    size: content.length,
  });
  return withBlame(loaded, on);
}

function fakeGit(answer: Blame = blame) {
  return { blame: vi.fn(() => Promise.resolve(answer)) };
}

describe("reading a blame", () => {
  it("reads the active tab's file when the column is on", async () => {
    const git = fakeGit();
    const { result } = renderHook(() => useBlame(tab(), git));

    await waitFor(() => {
      expect(result.current.blame).toEqual(blame);
    });
    expect(git.blame).toHaveBeenCalledWith("/w/infra", "deploy.yaml");
    expect(result.current.error).toBeNull();
  });

  // The column's toggle is not what decides this any more (#64). The same read
  // feeds the highlight on every line that is in no commit, which is on while
  // the column is off — gating it on the column would gate one feature on an
  // unrelated control.
  it("reads whether or not the column is on", async () => {
    const git = fakeGit();

    const { result } = renderHook(() => useBlame(tab("a: 1\n", false), git));

    await waitFor(() => {
      expect(result.current.blame).not.toBeNull();
    });
    expect(git.blame).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when there is no file open", () => {
    const git = fakeGit();

    renderHook(() => useBlame(null, git));

    expect(git.blame).not.toHaveBeenCalled();
  });

  // The bug this hook used to have: an unsaved edit reset it to NO_BLAME, so
  // the whole column emptied on the first keystroke. What that reasoning got
  // right is that a blame's LINE NUMBERS stop describing the buffer; what it
  // got wrong is that the attribution does not, and following the edits is the
  // editor's job (`blameAnchors` in lib/codemirror.ts). This holds what it read
  // until the disk content moves under it.
  it("holds the blame it read while the buffer has unsaved edits", async () => {
    const git = fakeGit();
    const clean = tab("a: 1\n");
    const { result, rerender } = renderHook(({ open }) => useBlame(open, git), {
      initialProps: { open: clean },
    });
    await waitFor(() => {
      expect(result.current.blame).not.toBeNull();
    });
    const held = result.current.blame;

    rerender({ open: withEdit(clean, "inserted\na: 1\n") });

    expect(result.current.blame).toBe(held);
  });

  // The other half of the same correction: an edit is not a reason to ask git
  // again either. The file on disk has not moved, so a re-read would spend a
  // subprocess to be told what this already holds.
  it("does not read again for an unsaved edit", async () => {
    const git = fakeGit();
    const clean = tab("a: 1\n");
    const { rerender } = renderHook(({ open }) => useBlame(open, git), {
      initialProps: { open: clean },
    });
    await waitFor(() => {
      expect(git.blame).toHaveBeenCalledTimes(1);
    });

    rerender({ open: withEdit(clean, "inserted\na: 1\n") });

    expect(git.blame).toHaveBeenCalledTimes(1);
  });

  // The other half of the same rule: a save moves the baseline, and the lines
  // the user just wrote come back attributed to nobody, which is what they are.
  it("reads again when the file is saved", async () => {
    const git = fakeGit();
    const first = tab("a: 1\n");
    const { rerender } = renderHook(({ open }) => useBlame(open, git), {
      initialProps: { open: first },
    });
    await waitFor(() => {
      expect(git.blame).toHaveBeenCalledTimes(1);
    });

    rerender({ open: { ...first, content: "a: 2\n", baseline: "a: 2\n" } });

    await waitFor(() => {
      expect(git.blame).toHaveBeenCalledTimes(2);
    });
  });

  // A tab is a new object on every keystroke. An effect that depended on the
  // object rather than on what it holds would spend a subprocess per character.
  it("does not read again when nothing it depends on changed", async () => {
    const git = fakeGit();
    const open = tab("a: 1\n");
    const { rerender } = renderHook(({ current }) => useBlame(current, git), {
      initialProps: { current: open },
    });
    await waitFor(() => {
      expect(git.blame).toHaveBeenCalledTimes(1);
    });

    rerender({ current: { ...open } });

    expect(git.blame).toHaveBeenCalledTimes(1);
  });

  it("reads the new file when the user switches tabs", async () => {
    const git = fakeGit();
    const { rerender } = renderHook(({ open }) => useBlame(open, git), {
      initialProps: { open: tab() },
    });
    await waitFor(() => {
      expect(git.blame).toHaveBeenCalledTimes(1);
    });

    rerender({ open: { ...tab(), key: "k1", path: "other.yaml" } });

    await waitFor(() => {
      expect(git.blame).toHaveBeenLastCalledWith("/w/infra", "other.yaml");
    });
  });

  it("keeps an empty blame rather than treating it as a failure", async () => {
    const git = fakeGit(emptyBlame());
    const { result } = renderHook(() => useBlame(tab(), git));

    await waitFor(() => {
      expect(result.current.blame).toEqual(emptyBlame());
    });
    expect(result.current.error).toBeNull();
  });
});

describe("when git refuses", () => {
  it("keeps git's own words rather than translating them", async () => {
    const git = {
      blame: vi.fn(() =>
        Promise.reject(new Error("fatal: no such path 'x.yaml' in HEAD")),
      ),
    };
    const { result } = renderHook(() => useBlame(tab(), git));

    await waitFor(() => {
      expect(result.current.error).toBe("fatal: no such path 'x.yaml' in HEAD");
    });
    expect(result.current.blame).toBeNull();
  });

  // The generated binding throws synchronously with no Wails runtime behind
  // it, and it throws a string rather than an Error.
  it("says something for a rejection that is not an Error", async () => {
    const git = { blame: vi.fn(() => Promise.reject("no bridge")) };
    const { result } = renderHook(() => useBlame(tab(), git));

    await waitFor(() => {
      expect(result.current.error).toBe("no bridge");
    });
  });

  it("says something for a rejection with no message at all", async () => {
    const git = { blame: vi.fn(() => Promise.reject(undefined)) };
    const { result } = renderHook(() => useBlame(tab(), git));

    await waitFor(() => {
      expect(result.current.error).toBe("the git backend is not reachable");
    });
  });

  // Turning the column off no longer stops the read, so the failure it reports
  // stays where it was. What changes is who shows it: the pane only puts git's
  // words on screen while the column is on, because a file git cannot blame is
  // an ordinary file to edit and not an error to be told about on every open.
  it("keeps the failure when the column is turned off", async () => {
    const git = { blame: vi.fn(() => Promise.reject(new Error("fatal: nope"))) };
    const open = tab();
    const { result, rerender } = renderHook(({ current }) => useBlame(current, git), {
      initialProps: { current: open },
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    rerender({ current: withBlame(open, false) });

    expect(result.current.error).toBe("fatal: nope");
  });

  it("clears the failure once a later read succeeds", async () => {
    const git = {
      blame: vi
        .fn()
        .mockRejectedValueOnce(new Error("fatal: nope"))
        .mockResolvedValue({ commits: [], lines: [] }),
    };
    const open = tab();
    const { result, rerender } = renderHook(({ current }) => useBlame(current, git), {
      initialProps: { current: open },
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    rerender({ current: { ...open, content: "a: 2\n", baseline: "a: 2\n" } });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });
});
