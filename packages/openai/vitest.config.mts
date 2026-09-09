import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/testkit/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。
// CI は typecheck → lint → test → build の順で走るため、test 実行時点では
// @mnemora/testkit の dist も無い（packages/postgres/vitest.config.mts と同じ狙い）。
// `@mnemora/testkit/fixtures` は base の `@mnemora/testkit` より前に書く——
// vite のエイリアス解決は文字列一致に加えて「pattern + '/'」の前方一致も見るため、
// base を先に書くと `@mnemora/testkit/fixtures` が base 側にマッチして
// 壊れたパス（`.../testkit/src/index.ts/fixtures`）に化ける。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/testkit/fixtures": fileURLToPath(
        new URL("../testkit/src/fixtures.ts", import.meta.url),
      ),
      "@mnemora/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
