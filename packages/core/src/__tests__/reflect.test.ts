import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { ExtractionResultSchema } from "../extraction.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { ConsolidationLLMResultSchema } from "../strategies/consolidate.js";
import { ReflectionLLMResultSchema } from "../strategies/reflect.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `runtime.reflect`（Issue #104）の歯。
 *
 * 置き場所・作法は `consolidate.test.ts` / `forget.test.ts` に揃える:
 * - `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 * - LLM の偽物はこのファイルにローカルに定義する。
 *
 * 設計の要点（`runtime.ts` の `ReflectOutcome`/`ReflectBasisOutcome`/`reflect` の
 * doc コメント参照）:
 * - `reflect` は `consolidate` の双子だが意味論は正反対——N→1 の**置換**ではなく「足すだけ」。
 *   既存の行の `status` を1つも動かさない（決定4）。
 * - 土台に `provenance.kind === 'reflected'` の Memory は採らない（自己増幅を止める、決定9）。
 * - 冪等性は買っていない——同じ target で2回呼ぶと `reflected` Memory が2件できる（決定11）。
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

/** 反映結果を固定で返す決定的な偽物（`consolidate.test.ts` の `llmConsolidatingTo` と同じ形）。 */
function llmReflectingTo(result: {
  content: string;
  digest?: string;
  tags?: string[];
}): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ outcome: "reflected", ...result }) as T,
  };
}

/** モデルが「一般化するものは無い」と断る側を固定で返す決定的な偽物。 */
function llmDeclining(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ outcome: "nothing" }) as T,
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

function createdEventCount(stores: ReturnType<typeof createFakeRuntimeStores>): number {
  return stores.eventStore.events.filter((e) => e.kind === "created").length;
}

describe("runtime.reflect — 基本の反映", () => {
  it("eligible な Memory から新しい Memory が1件できる。outcome: 'reflected'", async () => {
    const { runtime, stores } = buildRuntime(
      llmReflectingTo({ content: "気づき", digest: "気づきの要旨" }),
    );
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("reflected");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toBeNull();
    expect(result.nothingReason).toBeNull();
    expect(result.reflectedMemoryId).not.toBeNull();
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "used" },
      { memoryId: b.id, kind: "used" },
    ]);

    const created = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(created?.content).toBe("気づき");
    expect(created?.digest).toBe("気づきの要旨");
    expect(created?.status).toBe("active");
  });

  it("1件だけの eligible からでも反映できる（consolidate の single_eligible_source 制約は無い）", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id] } });

    expect(result.outcome).toBe("reflected");
    expect(result.basis).toEqual([{ memoryId: a.id, kind: "used" }]);
  });
});

describe("runtime.reflect — provenance は必ず sources を埋める（決定7）", () => {
  it("反映先の provenance は { kind: 'reflected', sources: [元の id...] }", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    const created = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(created?.provenance).toEqual({ kind: "reflected", sources: [a.id, b.id] });
    // 型としては ReflectedProvenance.sources は省略可のままだが、実装は常に埋める。
    expect((created?.provenance as { sources?: string[] }).sources).toBeDefined();
    expect((created?.provenance as { sources?: string[] }).sources!.length).toBeGreaterThan(0);
  });

  it("1件だけの eligible でも sources は空にならない", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id] } });

    const created = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(created?.provenance).toEqual({ kind: "reflected", sources: [a.id] });
  });
});

describe("runtime.reflect — strength は consolidate と同じ値（決定8）", () => {
  it("反映先の strength は 1（逐語のリテラル。MAX_STRENGTH から導かない）", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    const created = await stores.memoryStore.get(ctx, result.reflectedMemoryId!);
    expect(created?.strength).toBe(1);
  });
});

describe("runtime.reflect — created イベント", () => {
  it("meta.reason === 'reflected'、meta.sources に基底の id、opts.reason は meta.note に載る", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A本文" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B本文" }));

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [a.id, b.id] },
      reason: "手動での反映テスト",
    });

    const events = stores.eventStore.events.filter(
      (e) => e.memoryId === result.reflectedMemoryId && e.kind === "created",
    );
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.meta).toEqual({
      reason: "reflected",
      sources: [a.id, b.id],
      note: "手動での反映テスト",
    });
    // content はイベントのどの欄にも運ばれない。
    expect(JSON.stringify(event)).not.toContain("A本文");
    expect(JSON.stringify(event)).not.toContain("B本文");
  });

  it("opts.reason を省略すると meta に note キー自体が無い", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    const event = stores.eventStore.events.find(
      (e) => e.memoryId === result.reflectedMemoryId && e.kind === "created",
    )!;
    expect(event.meta).toEqual({ reason: "reflected", sources: [a.id, b.id] });
    expect(Object.keys(event.meta)).not.toContain("note");
  });
});

describe("runtime.reflect — 既存の行の status を1つも動かさない（決定4）", () => {
  it("updateStatus / updateStatusWithEvent は1度も呼ばれない。イベントは created のみ", async () => {
    const { stores } = buildRuntime();
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    // `consolidate.test.ts`「途中で store が投げたら打ち切る」と同じ手口——`stores` の
    // 他の面（eventStore 等）は共有したまま、`memoryStore` だけ Proxy で差し替える
    // （`backing` を共有しない別の fake 束を新しく作ると、created イベントの実在チェックが
    // 割れて壊れる）。
    const base = stores.memoryStore;
    let updateStatusCalls = 0;
    let updateStatusWithEventCalls = 0;
    const spied = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "updateStatus") {
          return async (...args: Parameters<MemoryStore["updateStatus"]>) => {
            updateStatusCalls += 1;
            return target.updateStatus(...args);
          };
        }
        if (prop === "updateStatusWithEvent") {
          return async (...args: Parameters<MemoryStore["updateStatusWithEvent"]>) => {
            updateStatusWithEventCalls += 1;
            return target.updateStatusWithEvent(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryStore;

    const runtimeSpied = createRuntime({
      memoryStore: spied,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReflectingTo({ content: "気づき" }),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => NOW },
    });

    const result = await runtimeSpied.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("reflected");
    expect(updateStatusCalls).toBe(0);
    expect(updateStatusWithEventCalls).toBe(0);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter?.status).toBe("active");
    expect(aAfter?.supersededById ?? null).toBeNull();
    expect(bAfter?.status).toBe("active");
    expect(bAfter?.supersededById ?? null).toBeNull();

    // reflect 自身が積むのは反映先の created イベントだけ。
    const nonCreatedEvents = stores.eventStore.events.filter((e) => e.kind !== "created");
    expect(nonCreatedEvents).toHaveLength(0);
  });
});

describe("runtime.reflect — not_found / status_not_active / basis_is_reflected の別々の顔", () => {
  it("存在しない id・非 active（forgotten を含む）・reflected 由来がそれぞれ別の kind で出る", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const archived = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "ARC", status: "archived" }),
    );
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );
    const priorReflection = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "PRIOR", provenance: { kind: "reflected", sources: [a.id] } }),
    );

    const result = await runtime.reflect(ctx, {
      target: {
        memoryIds: [a.id, "no-such-memory", archived.id, forgotten.id, priorReflection.id],
      },
    });

    expect(result.outcome).toBe("reflected");
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "used" },
      { memoryId: "no-such-memory", kind: "not_found" },
      { memoryId: archived.id, kind: "status_not_active", status: "archived" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
      { memoryId: priorReflection.id, kind: "basis_is_reflected" },
    ]);

    // forgotten / archived / 既存の reflected 由来は一切書き換えられていない。
    const forgottenAfter = await stores.memoryStore.get(ctx, forgotten.id);
    expect(forgottenAfter?.status).toBe("forgotten");
    const archivedAfter = await stores.memoryStore.get(ctx, archived.id);
    expect(archivedAfter?.status).toBe("archived");
    const priorAfter = await stores.memoryStore.get(ctx, priorReflection.id);
    expect(priorAfter?.status).toBe("active");
    expect(priorAfter?.supersededById ?? null).toBeNull();
  });

  it("判定の優先順: status を先に見る——forgotten かつ provenance.kind: 'reflected' は status_not_active", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const forgottenReflected = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        content: "FR",
        status: "forgotten",
        provenance: { kind: "reflected", sources: [] },
      }),
    );

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [a.id, forgottenReflected.id] },
    });

    expect(result.outcome).toBe("reflected");
    // `basis_is_reflected` ではなく `status_not_active`——status を先に見る（algorithm 手順2）。
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "used" },
      { memoryId: forgottenReflected.id, kind: "status_not_active", status: "forgotten" },
    ]);
  });
});

describe("runtime.reflect — basis は入力と同じ順序・同じ長さ", () => {
  it("重複を含む入力でも basis は同じ順序・同じ長さで返る", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [a.id, a.id, b.id, a.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.basis).toHaveLength(4);
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: a.id, kind: "eligible" },
      { memoryId: b.id, kind: "eligible" },
      { memoryId: a.id, kind: "eligible" },
    ]);
  });
});

describe("runtime.reflect — nothing_to_reflect", () => {
  it("no_eligible_basis: 採れる対象が0件なら LLM を呼ばずに打ち切る", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );
    const priorReflection = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "PRIOR", provenance: { kind: "reflected", sources: [] } }),
    );

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [forgotten.id, priorReflection.id] },
    });

    expect(result.outcome).toBe("nothing_to_reflect");
    expect(result.nothingReason).toBe("no_eligible_basis");
    expect(result.llmCalls).toBe(0);
    expect(result.reflectedMemoryId).toBeNull();
    expect(result.basis).toEqual([
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
      { memoryId: priorReflection.id, kind: "basis_is_reflected" },
    ]);
  });

  it("llm_declined: LLM が 'nothing' と答えたら書き込みゼロ・llmCalls: 1", async () => {
    const { runtime, stores } = buildRuntime(llmDeclining());
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("nothing_to_reflect");
    expect(result.nothingReason).toBe("llm_declined");
    expect(result.llmCalls).toBe(1);
    expect(result.reflectedMemoryId).toBeNull();
    expect(result.llmFailure).toBeNull();
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: b.id, kind: "eligible" },
    ]);
    expect(stores.eventStore.events.length).toBe(eventCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.reflect — dryRun", () => {
  it("LLM を呼ばず1件も書かず、eligible を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const forgotten = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ content: "F", status: "forgotten" }),
    );
    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.reflect(ctx, {
      target: { memoryIds: [a.id, forgotten.id] },
      dryRun: true,
    });

    expect(result.outcome).toBe("dry_run");
    expect(result.llmCalls).toBe(0);
    expect(result.reflectedMemoryId).toBeNull();
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: forgotten.id, kind: "status_not_active", status: "forgotten" },
    ]);
    expect(stores.eventStore.events.length).toBe(eventCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.reflect — LLM 障害", () => {
  it("LLM が投げたら llm_failed で、1件も書かれない", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm("provider is down"));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));
    const eventCountBefore = stores.eventStore.events.length;

    const result = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

    expect(result.outcome).toBe("llm_failed");
    expect(result.llmCalls).toBe(1);
    expect(result.llmFailure).toEqual({ kind: null, message: "provider is down" });
    expect(result.reflectedMemoryId).toBeNull();
    expect(result.basis).toEqual([
      { memoryId: a.id, kind: "eligible" },
      { memoryId: b.id, kind: "eligible" },
    ]);
    expect(stores.eventStore.events.length).toBe(eventCountBefore);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
  });
});

describe("runtime.reflect — target の空・not_examined", () => {
  it("空の { memoryIds: [] } は store に一切触れず not_examined を返す", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);

    const result = await runtime.reflect(ctx, { target: { memoryIds: [] } });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      reflectedMemoryId: null,
      basis: [],
      llmCalls: 0,
      llmFailure: null,
    });
    expect(stores.eventStore.events).toHaveLength(0);
  });

  it("{ query } が0件なら not_examined・store の Memory には一切触れない", async () => {
    const { runtime, stores } = buildRuntime(notUsedLlm);
    void stores;

    const result = await runtime.reflect(ctx, {
      target: { query: { vector: [9, 9] } },
    });

    expect(result).toEqual({
      outcome: "not_examined",
      nothingReason: null,
      reflectedMemoryId: null,
      basis: [],
      llmCalls: 0,
      llmFailure: null,
    });
  });
});

describe("runtime.reflect — 冪等性は買っていない（決定11、意図的に固定する）", () => {
  /**
   * 🔴 **この歯は「バグを検出する」歯ではない。「意図した挙動を固定する」歯である。**
   * 赤くなったときに読む人が間違えやすい歯なので、先にそれを名乗っておく。
   *
   * **冪等性は ADR 0091 決定11 で明示的に「買わない」と決めた。** 買わなかったのは
   * 「難しいから」ではなく「道具が無いから」である:
   * - `reflect` の産物は `sourceObservationId: null` なので、
   *   `packages/postgres/migrations/0001_init.sql:106-108` の部分一意索引
   *   （`WHERE source_observation_id IS NOT NULL`）の**外**に落ちる。
   * - ADR 0089 決定3 の「読んで status で弾く」（`consolidate` が冪等性を買った方法）は、
   *   **ADR 0091 決定4**（`reflect` は既存の行の `status` を1つも動かさない）**により
   *   使えない**——2回目の呼び出しでも同じ土台が `eligible` のまま在り続ける。
   * - `MemoryStore` に `content_hash` で引く口は無い。足せば公開 interface の必須メソッドが
   *   増え、第三者の adapter を壊す（`docs/autonomy.md` §3）。索引を足すのはマイグレーションで
   *   あり、ADR 0091 の範囲外。
   *
   * ⟹ **同じ `target` で2回呼ぶと、内容が同じ `reflected` Memory が2件できる。**
   * 塞がずに、歯で固定して負債として引き受けた（ADR 0091「引き受ける負債」1）。
   *
   * 🔴 **この歯が赤くなったのは、`reflect` が冪等になったからである。それ自体は改善かもしれない。**
   * ⟹ **その場合に直すのは、この歯ではなく ADR である。** ADR 0091 決定11 と
   * 「引き受ける負債」1 を先に更新してから、この歯を書き換えること
   * （ADR 0082 の時限式の歯・ADR 0089 決定7 が採っているのと同じ形——
   * コメントで済ませない。コメントは検査されず、黙って嘘になる）。
   *
   * ⚠ **`tick` の `reflect` ジョブ（Phase 3）を入れる人は、ここが痛む場所である**
   * ——常駐処理は同じ土台を繰り返し内省して重複を積む（ADR 0091「これが覆るとしたら」）。
   */
  it("🔴 冪等でない: 同じ target で2回呼ぶと reflected Memory が2件できる（ADR 0091 決定11 で「買わない」と決めた挙動。この歯が赤くなったら実装ではなく ADR を先に見ること）", async () => {
    const { runtime, stores } = buildRuntime(llmReflectingTo({ content: "気づき" }));
    const a = await stores.memoryStore.createMemory(ctx, newMemory({ content: "A" }));
    const b = await stores.memoryStore.createMemory(ctx, newMemory({ content: "B" }));

    const first = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(first.outcome).toBe("reflected");

    const second = await runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
    expect(second.outcome).toBe("reflected");

    // 🔴 2回目も「reflected」——冪等ではない。専用の冪等キー・索引は作っていない。
    expect(second.reflectedMemoryId).not.toBeNull();
    expect(second.reflectedMemoryId).not.toBe(first.reflectedMemoryId);
    expect(createdEventCount(stores)).toBe(2);

    const firstMemory = await stores.memoryStore.get(ctx, first.reflectedMemoryId!);
    const secondMemory = await stores.memoryStore.get(ctx, second.reflectedMemoryId!);
    expect(firstMemory?.content).toBe(secondMemory?.content);
    expect(firstMemory?.provenance).toEqual(secondMemory?.provenance);

    // 元の a / b は2回目の呼び出しでも active のまま——basis_is_reflected の対象にもならない
    // （a, b 自身の provenance は 'imported' のまま変わらない）。
    const aAfter = await stores.memoryStore.get(ctx, a.id);
    expect(aAfter?.status).toBe("active");
    expect(aAfter?.provenance.kind).toBe("imported");
  });
});

describe("3つの LLM スキーマ（extraction / consolidation / reflection）が互いに素であること", () => {
  const extractionCandidate = {
    memories: [{ content: "x", tags: [], provenanceKind: "stated" as const }],
  };
  const consolidationCandidate = { content: "x", digest: "d", tags: [] };
  const reflectedCandidate = { outcome: "reflected" as const, content: "x", digest: "d", tags: [] };
  const nothingCandidate = { outcome: "nothing" as const };

  it("それぞれ自分のスキーマには一致する", () => {
    expect(ExtractionResultSchema.safeParse(extractionCandidate).success).toBe(true);
    expect(ConsolidationLLMResultSchema.safeParse(consolidationCandidate).success).toBe(true);
    expect(ReflectionLLMResultSchema.safeParse(reflectedCandidate).success).toBe(true);
    expect(ReflectionLLMResultSchema.safeParse(nothingCandidate).success).toBe(true);
  });

  it("extraction 候補は consolidation / reflection のどちらのスキーマにも一致しない", () => {
    expect(ConsolidationLLMResultSchema.safeParse(extractionCandidate).success).toBe(false);
    expect(ReflectionLLMResultSchema.safeParse(extractionCandidate).success).toBe(false);
  });

  it("consolidation 候補は extraction / reflection のどちらのスキーマにも一致しない", () => {
    expect(ExtractionResultSchema.safeParse(consolidationCandidate).success).toBe(false);
    expect(ReflectionLLMResultSchema.safeParse(consolidationCandidate).success).toBe(false);
  });

  it("reflection の両候補（reflected / nothing）は extraction のスキーマに一致しない", () => {
    expect(ExtractionResultSchema.safeParse(reflectedCandidate).success).toBe(false);
    expect(ExtractionResultSchema.safeParse(nothingCandidate).success).toBe(false);
  });

  it("'nothing' 候補は consolidation のスキーマにも一致しない（content が無い）", () => {
    expect(ConsolidationLLMResultSchema.safeParse(nothingCandidate).success).toBe(false);
  });

  /**
   * ⚠ **食い違いの報告**: `outcome` 判別子は `ExtractionResultSchema` とは完全に素だが、
   * `ConsolidationLLMResultSchema` とは**片方向でだけ**素である。`z.object` は既定で
   * 未知キーを黙って剥がす（`.strict()` を付けていない）ため、`reflected` 候補
   * （`{ outcome, content, digest, tags }`）は `outcome` を剥がされたうえで
   * `ConsolidationLLMResultSchema` にも**一致してしまう**（実測、下のテスト）。
   *
   * これは `DeterministicLLMProvider` の実際の分岐順（extraction → consolidation →
   * reflection の順に candidate を試す）では問題にならない——req.schema が実際に
   * consolidation のときは、reflection の candidate を試す前に consolidation の
   * candidate がその時点で一致して返るため、この「片方向の非対称」が表面化する経路が無い。
   * ただし「2つのスキーマが数学的に素である」という主張はこの限りでは正確ではないため、
   * ここに測って残す（設計側への報告事項。詳細は PR 本文・報告を参照）。
   */
  it("[既知の非対称] reflected 候補は outcome を剥がされて consolidation のスキーマにも一致する", () => {
    expect(ConsolidationLLMResultSchema.safeParse(reflectedCandidate).success).toBe(true);
  });
});
