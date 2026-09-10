import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { buildConsolidatedMemory } from "../strategies/consolidate.js";
import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.consolidate`（Issue #103、ADR 0089）の歯。
 *
 * 置き場所・作法は `forget.test.ts` に揃える（ADR 0089 §9.4）:
 * - `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 * - LLM の偽物はこのファイルにローカルに定義する（`runtime.test.ts` の `llmReturning` /
 *   `throwingLlm` と同じ形）。
 *
 * 設計の要点（`runtime.ts` の `ConsolidateOutcome`/`ConsolidateSourceOutcome`/`consolidate`
 * の doc コメント参照）:
 * - 統合元は `forget`/`purge`/減衰のどれでもない第4の位置——`status: 'superseded'`。
 *   行も `content` も消えない。`forgotten` は絶対に統合元にしない。
 * - `eligible` が0件・1件なら書き込み無し（冪等性の芯）。
 * - `dryRun` は LLM を呼ばず1件も書かない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

/** `runtime.test.ts` の `llmReturning` と同じ形——統合結果を固定で返す決定的な偽物。 */
function llmConsolidatingTo(result: {
  content: string;
  digest?: string;
  tags?: string[];
}): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(result) as T,
  };
}

function throwingLlm(message = "simulated LLM outage"): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async () => {
      throw new Error(message);
    },
  };
}

function buildRuntime(llmProvider: LLMProvider = notUsedLlm) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

function supersededEvents(stores: ReturnType<typeof createFakeRuntimeStores>, memoryId: MemoryId) {
  return stores.eventStore.events.filter((e) => e.memoryId === memoryId && e.kind === "superseded");
}

/**
 * `consolidate` が新しい Memory を作ったときにだけ `kind: 'created'` のイベントを積む
 * （`createMemoriesFromCandidates` と同じ規律）。**`FakeMemoryStore` の private な `backing`
 * へ直接アクセスしない**——公開された観測（イベントログ）だけで「新しい統合先が
 * 作られたか」を数える。
 */
function createdEventCount(stores: ReturnType<typeof createFakeRuntimeStores>): number {
  return stores.eventStore.events.filter((e) => e.kind === "created").length;
}

describe("runtime.consolidate — 基本の統合", () => {
  it("N件を統合すると Memory が1件増え、元N件が superseded になり supersededById が統合先を指す", async () => {
    const { runtime, stores } = buildRuntime(
      llmConsolidatingTo({ content: "統合後の本文", digest: "統合後の要旨" }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id, c.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toBeNull();
    expect(result.nothingReason).toBeNull();
    expect(result.consolidatedMemoryId).not.toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
      { memoryId: c.id, kind: "superseded", previousStatus: "active" },
    ]);

    for (const original of [a, b, c]) {
      const stored = await stores.memoryStore.get(ctx, original.id);
      expect(stored?.status).toBe("superseded");
      expect(stored?.supersededById).toBe(result.consolidatedMemoryId);
      // 行も content も消えない（north-star 表4「元を消さない」）。
      expect(stored?.content).toBe(original.content);
    }

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.content).toBe("統合後の本文");
    expect(created?.digest).toBe("統合後の要旨");
    expect(created?.status).toBe("active");

    // docs/architecture.md:83-90「consolidate → ... → MemoryStore.create → EventStore.append」
    // ——統合先の新しい Memory にも `created` イベントが1件積まれる。
    const createdEvents = stores.eventStore.events.filter(
      (e) => e.memoryId === result.consolidatedMemoryId && e.kind === "created",
    );
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]!.meta).toEqual({ reason: "consolidated", sources: [a.id, b.id, c.id] });
  });

  it("統合先の provenance は { kind: 'consolidated', sources: [元の id...] }", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    const created = await stores.memoryStore.get(ctx, result.consolidatedMemoryId!);
    expect(created?.provenance).toEqual({ kind: "consolidated", sources: [a.id, b.id] });
  });

  it("superseded イベントの meta.reason === 'consolidated'、digestSnapshot が入り content は入らない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A本文", digest: "A要旨" }),
    );
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B本文" }));

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id] },
      reason: "手動での統合テスト",
    });

    const events = supersededEvents(stores, a.id);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("superseded");
    expect(event.digestSnapshot).toBe("A要旨");
    expect(event.meta).toEqual({
      reason: "consolidated",
      supersededById: result.consolidatedMemoryId,
      note: "手動での統合テスト",
    });
    // content はイベントのどの欄にも運ばれない。
    expect(Object.keys(event)).not.toContain("content");
    expect(JSON.stringify(event)).not.toContain("A本文");
  });
});

describe("runtime.consolidate — 冪等性", () => {
  it("同じ id で2回呼ぶと、2回目は nothing_to_consolidate/no_eligible_sources・llmCalls:0・Memory が増えない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const first = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(first.outcome).toBe("consolidated");

    const createdCountAfterFirst = createdEventCount(stores);

    const second = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(second.outcome).toBe("nothing_to_consolidate");
    expect(second.nothingReason).toBe("no_eligible_sources");
    expect(second.llmCalls).toBe(0);
    expect(second.consolidatedMemoryId).toBeNull();
    expect(second.sources).toEqual([
      { memoryId: a.id, kind: "status_not_active", status: "superseded" },
      { memoryId: b.id, kind: "status_not_active", status: "superseded" },
    ]);
    expect(createdEventCount(stores)).toBe(createdCountAfterFirst);
  });

  it("eligible が1件だけなら single_eligible_source（0件の no_eligible_sources とは別の顔）", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, forgotten.id] },
    });

    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.nothingReason).toBe("single_eligible_source");
    expect(result.llmCalls).toBe(0);
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "not_attempted" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);
  });
});

describe("runtime.consolidate — forgotten は統合元にならない", () => {
  it("forgotten な Memory は status_not_active に出て、superseded にならない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, forgotten.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);

    const forgottenAfter = await stores.memoryStore.get(ctx, forgotten.id);
    expect(forgottenAfter?.status).toBe("forgotten");
    expect(forgottenAfter?.supersededById ?? null).toBeNull();
  });
});

describe("runtime.consolidate — not_found / status_not_active / not_attempted の別々の顔", () => {
  it("存在しない id・非 active・失敗による打ち切りが、それぞれ別の kind で出る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const archived = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "ARC", status: "archived" }),
    );

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, "no-such-memory", archived.id, b.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: "no-such-memory", kind: "not_found" },
      { memoryId: archived.id, kind: "status_not_active", status: "archived" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);
  });
});

describe("runtime.consolidate — dryRun", () => {
  it("dryRun: LLM を呼ばず1件も書かず、eligible を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );

    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, forgotten.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.llmCalls).toBe(0);
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: b.id, kind: "eligible" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);
    // 1件も書かない——イベント数もそのまま（新しい統合先の created イベントも積まれない）。
    expect(stores.eventStore.events.length).toBe(eventCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.consolidate — LLM 障害", () => {
  it("LLM が投げたら llm_failed で、1件も superseded にならない", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm("provider is down"));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const createdCountBefore = createdEventCount(stores);

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("llm_failed");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toEqual({ kind: null, message: "provider is down" });
    expect(result.consolidatedMemoryId).toBeNull();
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "not_attempted" },
      { memoryId: b.id, kind: "not_attempted" },
    ]);
    expect(createdEventCount(stores)).toBe(createdCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.consolidate — 並行の書き込み（CAS）", () => {
  /**
   * 🔴 `FakeMemoryStore` の穴（ADR 0087 実測）: in-memory の偽物は `Memory` をその場で
   * 書き換え、`getMany` が**同じ参照**を配る。ここは「読んでから書くまでの間に別の書き込みが
   * 割り込む」を測りたいので、`beforeUpdateStatus`（テスト専用フック、CAS 判定の直前に発火。
   * `runtime-fakes.ts` 参照）を使って決定的に割り込ませる——`reextract` の歯と同じ手口。
   */
  it("CAS が破れたら status_changed_concurrently（他の1件は続行）", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    // `FakeMemoryStore.get` は backing.memories に入っている Memory オブジェクトへの参照を
    // そのまま返す（コピーを作らない）ので、事前に取得した参照の status を書き換えるだけで
    // 「割り込み」を再現できる（`runtime.test.ts` の reextract の歯と同じ手口）。
    const aLive = await stores.memoryStore.get(ctx, a.id);
    let intervened = false;
    stores.memoryStore.beforeUpdateStatus = (id) => {
      if (!intervened && id === a.id) {
        intervened = true;
        // 割り込み: consolidate が a を読んでから書くまでの間に、別の誰かが forget した体。
        aLive!.status = "forgotten";
      }
    };

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "status_changed_concurrently", observedStatus: "forgotten" },
      { memoryId: b.id, kind: "superseded", previousStatus: "active" },
    ]);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("forgotten"); // consolidate は書き換えていない
    expect(aAfter?.supersededById ?? null).toBeNull();
  });
});

describe("runtime.consolidate — 途中で store が投げたら打ち切る", () => {
  it("2件目の superseded 更新が例外を投げたら、それ以降は not_attempted・例外は外へ出ない", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const c = await stores.memoryStore.createMemory(ctx, newMemory({ content: "C" }));

    const base = stores.memoryStore;
    let updateCalls = 0;
    const failing = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "updateStatusWithEvent") {
          return async (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
            updateCalls += 1;
            if (updateCalls === 2) {
              throw new Error("simulated connection reset");
            }
            return target.updateStatusWithEvent(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeFailing = createRuntime({
      memoryStore: failing,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmConsolidatingTo({ content: "統合後" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });
    void runtime;

    const result = await runtimeFailing.consolidate(ctx, {
      target: { memoryIds: [a.id, b.id, c.id] },
    });

    expect(result.outcome).toBe("consolidated");
    expect(result.sources).toEqual([
      { memoryId: a.id, kind: "superseded", previousStatus: "active" },
      { memoryId: b.id, kind: "failed", error: "simulated connection reset" },
      { memoryId: c.id, kind: "not_attempted" },
    ]);

    const cAfter = await stores.memoryStore.get(ctx, c.id);
    expect(cAfter?.status).toBe("active"); // 3件目には一切触れていない
  });
});

describe("runtime.consolidate — recall() との裏取り（recall 側は変更していない）", () => {
  it("consolidate 後の recall() に元 Memory が出ず、omitted に filtered/superseded が出る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A", embeddingStatus: "ready" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "B", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const beforeConsolidate = await runtime.recall(ctx, { vector: [1, 0] });
    expect(beforeConsolidate.memories.map((m) => m.memoryId)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );

    await runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

    const afterConsolidate = await runtime.recall(ctx, { vector: [1, 0] });
    expect(afterConsolidate.memories.map((m) => m.memoryId)).not.toContain(a.id);
    expect(afterConsolidate.memories.map((m) => m.memoryId)).not.toContain(b.id);
    expect(afterConsolidate.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      count: 2,
      countKind: "exact",
    });
  });
});

describe("runtime.consolidate — target の { query } の形", () => {
  it("{ query, maxCandidates } は recall() を1回呼び、返った順に先頭から切る", async () => {
    const { runtime, stores } = buildRuntime(llmConsolidatingTo({ content: "統合後" }));
    const a = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "A", embeddingStatus: "ready" }),
    );
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "B", embeddingStatus: "ready" }),
    );
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, b.id, [1, 0]);

    const result = await runtime.consolidate(ctx, {
      target: { query: { vector: [1, 0] }, maxCandidates: 1 },
    });

    // maxCandidates: 1 に切られた結果、eligible は1件だけ ⟹ single_eligible_source。
    expect(result.outcome).toBe("nothing_to_consolidate");
    expect(result.nothingReason).toBe("single_eligible_source");
    expect(result.sources).toHaveLength(1);
  });

  it("query が0件なら not_examined・store の Memory には一切触れない", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    void stores;

    const result = await runtime.consolidate(ctx, {
      target: { query: { vector: [9, 9] } },
    });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      consolidatedMemoryId: null,
      sources: [],
      llmCalls: 0,
      llmFailure: null,
    });
  });
});

describe("runtime.consolidate — 空の target", () => {
  it("空の { memoryIds: [] } は store に一切触れず not_examined を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);

    const result = await runtime.consolidate(ctx, { target: { memoryIds: [] } });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      consolidatedMemoryId: null,
      sources: [],
      llmCalls: 0,
      llmFailure: null,
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });
});

describe("buildConsolidatedMemory（純関数）", () => {
  function fixtureMemory(overrides: Partial<Memory> = {}): Memory {
    const recordedAt = overrides.recordedAt ?? NOW;
    const strength = overrides.strength ?? 1;
    const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
    return {
      id: overrides.id ?? `mem-${Math.random()}`,
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "digest",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fixture" },
      status: "active" as MemoryStatus,
      supersededById: null,
      contestedWithId: null,
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
      createdAt: recordedAt,
      updatedAt: recordedAt,
      ...overrides,
    };
  }

  it("subjectId が eligible 全件で一致すればその値、割れていれば null", () => {
    const same = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", subjectId: "subject-x" }),
        fixtureMemory({ id: "m2", subjectId: "subject-x" }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(same.subjectId).toBe("subject-x");

    const split = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", subjectId: "subject-x" }),
        fixtureMemory({ id: "m2", subjectId: "subject-y" }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(split.subjectId).toBeNull();
  });

  it("occurredAt は eligible のうち最も新しいもの。全部 null なら null", () => {
    const withDates = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", occurredAt: new Date("2026-01-01T00:00:00.000Z") }),
        fixtureMemory({ id: "m2", occurredAt: new Date("2026-03-01T00:00:00.000Z") }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(withDates.occurredAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));

    const allNull = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(allNull.occurredAt).toBeNull();
  });

  it("tags は LLM の tags があればそれを使い、無ければ eligible の tags の和集合", () => {
    const withLlmTags = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", tags: ["x"] }),
        fixtureMemory({ id: "m2", tags: ["y"] }),
      ],
      llmResult: { content: "統合後", tags: ["z"] },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(withLlmTags.tags).toEqual(["z"]);

    const unionTags = buildConsolidatedMemory({
      ctx,
      eligible: [
        fixtureMemory({ id: "m1", tags: ["x", "shared"] }),
        fixtureMemory({ id: "m2", tags: ["shared", "y"] }),
      ],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(unionTags.tags).toEqual(["x", "shared", "y"]);
  });

  it("provenance は { kind: 'consolidated', sources: <eligible の id> }", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" }), fixtureMemory({ id: "m2" })],
      llmResult: { content: "統合後" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 200,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.provenance).toEqual({ kind: "consolidated", sources: ["m1", "m2"] });
    expect(memory.sourceObservationId).toBeNull();
    expect(memory.extractorVersion).toBeNull();
  });

  it("LLM の digest が空なら機械的フォールバックへ倒す（resolveDigest と同じ規律）", () => {
    const memory = buildConsolidatedMemory({
      ctx,
      eligible: [fixtureMemory({ id: "m1" })],
      llmResult: { content: "統合後の本文がとても長い場合はフォールバックで切り詰められる" },
      hashContent: (c) => `hash(${c})`,
      digestFallbackLength: 10,
      halfLifeHours: 24,
      now: NOW,
    });
    expect(memory.digestSource).toBe("fallback");
    expect(memory.digest.length).toBeLessThanOrEqual(11); // 10文字 + "…"
  });
});
