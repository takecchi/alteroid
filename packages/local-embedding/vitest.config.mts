import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// packages/openai/vitest.config.mts と同じ理由: dist ではなく core/src を直接参照する。
// CI は typecheck → lint → test → build の順で走るため、test の時点で @mnemora/core の
// dist は無い。
export default defineConfig({
  resolve: {
    alias: {
      "@mnemora/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      // ADR 0090: テーブル名／索引名の導出関数（`embeddingSpaceTableName` /
      // `embeddingSpaceIndexName`）を**本物を import して**使う歯のため。
      // 名前をベタ書きすると、導出が変わったときに歯が嘘になる。
      "@mnemora/postgres": fileURLToPath(new URL("../postgres/src/index.ts", import.meta.url)),
      // Issue #116 の残債: ADR 0095 の適合テストを本物の LocalEmbeddingProvider に当てるため。
      // ⚠ `@mnemora/testkit/fixtures` は使わない——使うなら base より前に書く必要がある
      // （packages/openai/vitest.config.mts のコメント参照）。使わないので base だけを置く。
      "@mnemora/testkit": fileURLToPath(new URL("../testkit/src/index.ts", import.meta.url)),
    },
  },
});
