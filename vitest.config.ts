import { defineConfig } from "vitest/config";

const MAP_CACHE = ["packages/tools/test/setup-map-cache.ts"];

/**
 * Three projects (M10.0, test speed):
 * - `pure`: sim and data. Their tests share modules within a worker (`isolate: false`): these packages hold no
 *   module state a test could leave behind, so each file need not reload them.
 * - `view`: render and ui, isolated, with the shared map cache.
 * - `tools`: labs, scenarios, battles, goldens, isolated (some tests patch module-level tables), with the shared map
 *   cache (`packages/tools/src/map-cache.ts`; `TCS_MAP_CACHE=0` turns it off).
 * `npm run test:quick` runs `pure` and `view` only.
 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    projects: [
      { extends: true, test: { name: "pure", include: ["packages/{sim,data,ai,scenario,campaign}/test/**/*.test.ts"], isolate: false } },
      { extends: true, test: { name: "view", include: ["packages/{render,ui,app}/test/**/*.test.ts"], setupFiles: MAP_CACHE } },
      { extends: true, test: { name: "tools", include: ["packages/tools/test/**/*.test.ts"], setupFiles: MAP_CACHE } },
    ],
  },
});
