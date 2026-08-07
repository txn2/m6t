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

  it("reads nothing while the column is off", () => {
    const git = fakeGit();

    const { result } = renderHook(() => useBlame(tab("a: 1\n", false), git));

    expect(git.blame).not.toHaveBeenCalled();
    expect(result.current.blame).toBeNull();
  });

  it("reads nothing when there is no file open", () => {
    const git = fakeGit();

    renderHook(() => useBlame(null, git));

    expect(git.blame).not.toHaveBeenCalled();
  });

  // The core rule of #52: a blame is stated in the line numbers of the file on
  // disk, and an unsaved insertion moves every line below it. Attributing the
  // buffer with a blame of the saved file would name the wrong author for most
  // of it.
  it("drops the entries while the buffer has unsaved edits", async () => {
    const git = fakeGit();
    const clean = tab("a: 1\n");
    const { result, rerender } = renderHook(({ open }) => useBlame(open, git), {
      initialProps: { open: clean },
    });
    await waitFor(() => {
      expect(result.current.blame).not.toBeNull();
    });

    rerender({ open: withEdit(clean, "inserted\na: 1\n") });

    expect(result.current.blame).toBeNull();
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

  it("clears the failure when the column is turned off", async () => {
    const git = { blame: vi.fn(() => Promise.reject(new Error("fatal: nope"))) };
    const open = tab();
    const { result, rerender } = renderHook(({ current }) => useBlame(current, git), {
      initialProps: { current: open },
    });
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    rerender({ current: withBlame(open, false) });

    expect(result.current.error).toBeNull();
  });
});
