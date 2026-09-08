import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorFilter } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0059: 段1（ANN 検索）へ period（`occurredAfter`/`occurredBefore`）を押し下げる。
 *
 * `recall-subject-filter.test.ts`（ADR 0023）・`recall-exclude-provenance-filter.test.ts`
 * （ADR 0056）と同型の配線の歯に加え、**この押し下げが実際に何を変えるか**を測る歯を置く
 * ——マネージャー指示の「狭い窓 × 期間外の候補が距離で近いと、押し下げが無ければ 0件、
 * 在れば N件になる」歯（下の2つ目の `describe`）。
 *
 * `packages/core` 自身のテストなので `@mnemora/testkit` には依存しない
 * （`runtime-fakes.ts` 冒頭のコメントと同じ理由）。DB を要さないため手元で実行できる。
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

describe("recall() — 段1の filter に occurredAfter/occurredBefore が載ること（配線の歯、ADR 0059）", () => {
  it("occurredAfter/occurredBefore を渡すと VectorStore.search の opts.filter に渡る", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const occurredBefore = new Date("2026-05-01T00:00:00.000Z");
    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0], occurredAfter, occurredBefore });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.occurredAfter).toEqual(occurredAfter);
    expect(capturedFilters[0]?.occurredBefore).toEqual(occurredBefore);
  });

  it("occurredAfter/occurredBefore を渡さないときは段1の filter も undefined のまま渡る（期間を絞らない既定動作を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const capturedFilters = captureFilters(stores);

    const ctx: Ctx = { tenantId: "tenant-1" };
    await runtime.recall(ctx, { vector: [1, 0] });

    expect(capturedFilters).toHaveLength(1);
    expect(capturedFilters[0]?.occurredAfter).toBeUndefined();
    expect(capturedFilters[0]?.occurredBefore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⭐ 本命の歯: 押し下げを消すと「狭い窓 × 期間外の候補が距離で近い」状況で
// recall() が 0件になる（ADR 0023 が subjectId について実測した現象と同じ構造。
// マネージャー指示の変異——段1の filter から period 述語を丸ごと抜く——を
// 確実に噛ませるための歯）。
//
// `FakeVectorStore` は filter を適用しつつ limit を守る（ADR 0034）ので、
// この歯は DB 無しで core のテストとして書ける。
// ---------------------------------------------------------------------------

const ctx: Ctx = { tenantId: "tenant-1" };

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10; // 長い half-life。テスト内で減衰させない。
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

describe("recall() — period の押し下げが over-fetch の窓（k'）を無駄にしない（ADR 0059、実際に何を変えるかを測る歯）", () => {
  it("期間外の候補（distance 0）が窓を埋めても、期間内の候補（distance > 0）が返る", async () => {
    const { runtime, stores } = buildRuntime();

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const query = [1, 0];

    // crowd: 期間外（occurredAfter より前）・クエリと完全一致（distance 0）。
    // limit=3, overFetchFactor=1 -> k'=3 なので、押し下げが無ければこの3件だけで
    // ANN の窓（k'=3）が埋まり、期間内の候補は段1の hits に一度も現れない。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, query, {
        occurredAt: new Date("2020-01-01T00:00:00.000Z"),
      });
    }

    // target: 期間内（occurredAfter 以降）・クエリからわずかにずれる（distance > 0、
    // しかし similarity は十分高く既定の scoreThreshold=0.1 を大きく上回る）。
    const targetIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const memory = await createEmbeddedMemory(stores, [1, 0.01], {
        occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      });
      targetIds.push(memory.id);
    }

    const result = await runtime.recall(ctx, {
      vector: query,
      occurredAfter,
      limit: 3,
      overFetchFactor: 1,
    });

    // ⟹ 押し下げが在れば、段1の filter が crowd を最初から除外するので k'=3 の窓は
    // target 3件だけで埋まり、3件とも返る。
    // ⟹ 押し下げを段1の filter から抜く変異を当てると、段1は距離だけで crowd 3件を
    // 選んでしまい（distance 0 が最短）、後段の period 再検査で crowd が全部落ちて
    // target は一度も窓に入らない——結果は 0件になる。
    expect(result.memories).toHaveLength(3);
    expect(result.memories.map((m) => m.memoryId).sort()).toEqual([...targetIds].sort());
  });
});
