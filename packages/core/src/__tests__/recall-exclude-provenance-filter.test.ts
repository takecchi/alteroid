import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorFilter } from "../interfaces/vector-store.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ⭐ 配線の歯: `recall()` が `RecallQuery.excludeProvenanceKinds` を段1
 * （`VectorStore.search`）の filter に載せていることを検査する（ADR 0056）。
 *
 * `recall-subject-filter.test.ts`（ADR 0023 の配線の歯）と同型——`packages/core` 自身の
 * テストなので `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと
 * 同じ理由）。DB を要さないため手元で実行できる。
 *
 * ⟹ `recall-runtime.ts` の段1呼び出しから `excludeProvenanceKinds:` の行を消す変異を
 * 当てると、1つ目の it() が確実に赤くなる
 * （`capturedFilters[0]?.excludeProvenanceKinds` が `undefined` になる）。
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function captureFilters(stores: ReturnType<typeof createFakeRuntimeStores>): VectorFilter[] {
  const capturedFilters: VectorFilter[] = [];
  const originalSearch = stores.vectorStore.search.bind(stores.vectorStore);
  stores.vectorStore.search = async (ctx, space, query, opts) => {
    capturedFilters.push(opts.filter);
    return originalSearch(ctx, space, query, opts);
  };
  return capturedFilters;
}

describe("recall() — 段1の filter に excludeProvenanceKinds が載ること（配線の歯、ADR 0056）", () => {
  it("excludeProvenanceKinds を渡すと VectorStore.search の opts.filter.excludeProvenanceKinds に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0], excludeProvenanceKinds: ["inferred"] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.excludeProvenanceKinds).toEqual(["inferred"]);
  });

  it("excludeProvenanceKinds を渡さないときは段1の filter が no-op のまま渡る（undefined か空配列。ADR 0056の非対称）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    const passed = capturedFilters[0]?.excludeProvenanceKinds;
    // `RecallQuerySchema.excludeProvenanceKinds` は `.default()` を持たない zod スキーマ
    // （既定は `undefined`）——`?? []` で正規化して渡すこともこの契約上は許されるため、
    // どちらであっても段1が no-op になることだけを固定する（VectorFilter の doc 参照:
    // `undefined` と `[]` はどちらも no-op）。
    expect(passed === undefined || passed?.length === 0).toBe(true);
  });
});
