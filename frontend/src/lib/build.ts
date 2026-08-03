import { Version } from "../../wailsjs/go/app/App";

/** Build identity of the running binary, mirroring Go's buildinfo.Info. */
export interface BuildInfo {
  version: string;
  commit: string;
  date: string;
}

/**
 * What the UI shows when the Wails runtime is not there to ask — `vite dev`
 * in a plain browser, or a storybook-style harness. `attached: false` is
 * surfaced in the UI rather than swallowed: a build line silently showing
 * placeholder values would be indistinguishable from a broken binding.
 */
export const detachedBuild: BuildInfo = {
  version: "dev",
  commit: "none",
  date: "unknown",
};

export interface BuildStatus {
  info: BuildInfo;
  attached: boolean;
}

/**
 * Reads the build identity across the Wails bridge. The fetcher is injectable
 * so callers (and tests) can exercise both outcomes without a live runtime.
 */
export async function loadBuild(
  fetchVersion: () => Promise<BuildInfo> = Version,
): Promise<BuildStatus> {
  try {
    return { info: await fetchVersion(), attached: true };
  } catch {
    return { info: detachedBuild, attached: false };
  }
}
