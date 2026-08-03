import { describe, expect, it } from "vitest";
import { type BuildInfo, detachedBuild, loadBuild } from "./build";

describe("loadBuild", () => {
  it("reports the backend's build identity when the bridge answers", async () => {
    const info: BuildInfo = {
      version: "v1.2.0",
      commit: "a1b2c3d4e5f6",
      date: "2026-08-02",
    };

    const status = await loadBuild(() => Promise.resolve(info));

    expect(status).toEqual({ info, attached: true });
  });

  it("falls back to the detached placeholder when the bridge is absent", async () => {
    const status = await loadBuild(() =>
      Promise.reject(new Error("go.app.App.Version is not a function")),
    );

    expect(status).toEqual({ info: detachedBuild, attached: false });
  });

  it("does not let a rejected bridge call escape to the caller", async () => {
    await expect(
      loadBuild(() => Promise.reject(new Error("boom"))),
    ).resolves.toHaveProperty("attached", false);
  });
});
