import { defineConfig } from "tsup";

const shared = { dts: true, sourcemap: true, target: "node20" } as const;

export default defineConfig([
  { ...shared, entry: ["src/index.ts"], format: ["esm", "cjs"] },
  // Vitest cannot be loaded with require(), so its integration ships as ESM only.
  { ...shared, entry: ["src/vitest.ts"], format: ["esm"] },
  { ...shared, entry: { cli: "src/bin.ts" }, format: ["esm"], dts: false, banner: { js: "#!/usr/bin/env node" } },
]);
