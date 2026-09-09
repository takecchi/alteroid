import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/testkit/vitest.config.mts と同じ理由: dist ではなく src を直接参照する。
// @mnemora/openai も devDependency（provider-parity.test.ts が両方の provider を並べて検査する
// ためだけに使う）なので、同じ理由で openai/src も直接参照する——CI の
// typecheck → lint → test → build の順では、test の時点で openai の dist が無い前提になる。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@mnemora/openai": fileURLToPath(new URL("../openai/src/index.ts", import.meta.url)),
    },
  },
});
