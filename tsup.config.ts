import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/protocol/index.ts",
    "src/unstable/testing.ts",
  ],
  format: ["esm"],
  sourcemap: true,
});
