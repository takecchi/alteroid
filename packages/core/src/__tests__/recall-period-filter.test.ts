import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { VectorFilter, VectorHit, VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeVectorStore } from "./runtime-fakes.js";

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

/**
 * `vectorStoreOverride` を渡さなければ従来どおり `stores.vectorStore`（FakeVectorStore 本体）を
 * runtime に注入する。渡すと、その結果を注入する——下の「段2専用の歯」が
 * `PeriodStrippingVectorStore` を挟むために使う。`stores` に載っている実体
 * （`FakeBackingStore` 経由の memory / vector）は override の有無に関わらず同じものを指す
 * ——`createEmbeddedMemory` はいつも `stores.vectorStore.upsert` を直接呼ぶ。
 */
function buildRuntime(vectorStoreOverride?: (fvs: FakeVectorStore) => VectorStore) {
  const stores = createFakeRuntimeStores();
  const vectorStore = vectorStoreOverride
    ? vectorStoreOverride(stores.vectorStore)
    : stores.vectorStore;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore,
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

// ---------------------------------------------------------------------------
// ⭐⭐ 段2（recall-runtime.ts の後段 period 再検査、`effectiveTime` による2つの
// `continue`）専用の歯。ADR 0059 が変異試験の表に「🔴🔴 緑（生き残る）／歯 0本」と
// 記録した2件目の生き残りを塞ぐ（1件目の `occurredBefore` 境界は PR #72 で塞いだ）。
//
// **上の2つの describe を含め、通常の歯は必ず段1（FakeVectorStore）と段2
// （recall-runtime.ts）の両方を経由する。** 段1が `VectorFilter` の period を正しく
// 適用している限り、段2の2行はコードとしては実行されても「落とす」役には立たない
// （段1が既に落としているため）——ADR 0059 の変異試験が「段2を丸ごと消しても
// フルスイートが1本も赤くならない」と記録した理由そのもの。
//
// ここでは `FakeVectorStore` を薄く包み、`search()` に渡ってきた `opts.filter` から
// `occurredAfter`/`occurredBefore` **だけ**を剥がしてから委譲する
// （`PeriodStrippingVectorStore`）。ADR 0056 が「段1がわざと絞らない adapter を使って
// 段2だけを検査する歯が要る」と書き残していた処方をそのまま実装したもの
// ——「`VectorFilter` の契約（ADR 0034）を守らない adapter」を歯の中だけで再現し、
// 段2だけが period を落とす状況を作る。他のフィールド（tenantId/status/subjectId/
// excludeProvenanceKinds/decayFloorAtAfter）はそのまま通す——period 以外まで段1で
// ザルにすると、この歯が「period だけを測っている」ことが言えなくなる。
//
// ⛔ 本番コード（recall-runtime.ts / vector-store.ts）は1文字も変えない——
// ラッパはこの test ファイルの中に閉じている。
// ---------------------------------------------------------------------------

class PeriodStrippingVectorStore implements VectorStore {
  constructor(private readonly inner: VectorStore) {}

  upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["upsert"]>[2],
    vector: number[],
  ): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(ctx, space, memoryId, vector);
  }

  delete(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: Parameters<VectorStore["delete"]>[2],
  ): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(ctx, space, memoryId);
  }

  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    // 🔑 occurredAfter/occurredBefore「だけ」を剥がす。他は素通し。
    const {
      occurredAfter: _occurredAfter,
      occurredBefore: _occurredBefore,
      ...periodStripped
    } = opts.filter;
    return this.inner.search(ctx, space, query, { ...opts, filter: periodStripped });
  }
}

describe("recall() — 段2（recall-runtime.ts の後段 period 再検査）専用の歯（ADR 0059、生き残り2件目）", () => {
  it("段1が period を見ない adapter でも、段2の再検査だけで期間外の候補が落ちる", async () => {
    const { runtime, stores } = buildRuntime((fvs) => new PeriodStrippingVectorStore(fvs));

    const occurredAfter = new Date("2026-01-01T00:00:00.000Z");
    const occurredBefore = new Date("2026-05-01T00:00:00.000Z");
    const query = [1, 0];

    // occurredAfter 側（期間より古い記憶）。段2の1行目
    // （`effectiveTime < scope.occurredAfter` の continue）だけが落とせる。
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "old-outside-period",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    // occurredBefore 側（期間より新しい記憶）。段2の2行目
    // （`effectiveTime > scope.occurredBefore` の continue）だけが落とせる。
    await createEmbeddedMemory(stores, [1, 0.02], {
      digest: "future-outside-period",
      occurredAt: new Date("2026-05-15T00:00:00.000Z"),
    });
    // 期間内。2件（複数にしておくと、たまたま1件だけ残る実装でも見分けが付く）。
    await createEmbeddedMemory(stores, [1, 0.01], {
      digest: "recent-inside-period-1",
      occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    await createEmbeddedMemory(stores, [1, 0.015], {
      digest: "recent-inside-period-2",
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const result = await runtime.recall(ctx, {
      vector: query,
      occurredAfter,
      occurredBefore,
      limit: 10,
      overFetchFactor: 4,
    });

    const digests = result.memories.map((m) => m.digest);
    // 順序に依存しない（distance の僅差でタイブレークしうるため toContain/not.toContain で見る。
    // ADR 0040: ゼロベクトルは距離が NaN になるため、ここでは使わない）。limit=10 は
    // 候補4件に対して十分な余裕を持たせてあり、ぎりぎりにしていない。
    expect(digests).toContain("recent-inside-period-1");
    expect(digests).toContain("recent-inside-period-2");
    expect(digests).not.toContain("old-outside-period");
    expect(digests).not.toContain("future-outside-period");
  });
});
