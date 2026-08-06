import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
    // The browser APIs Radix needs and jsdom lacks. See src/test-setup.ts.
    setupFiles: ["src/test-setup.ts"],
    restoreMocks: true,
    onConsoleLog(log, type) {
      // xterm.js measures colours through a canvas when its module loads, and
      // jsdom does not implement getContext. The message is jsdom's, it fires
      // on import rather than on anything a test did, and the renderer itself
      // is never exercised here — panes take an injected one. Dropping it keeps
      // a failing assertion visible in the output instead of buried.
      if (
        type === "stderr" &&
        log.includes("HTMLCanvasElement.prototype.getContext")
      ) {
        return false;
      }
      return undefined;
    },
  },
});
