import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/openai/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。
// CI は typecheck → lint → test → build の順で走るため、test の時点で @mnemora/core の
// dist は無い。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
