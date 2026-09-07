import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import type { ReextractSkip } from "../strategies/reextract.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";
import type { FakeMemoryStore } from "./runtime-fakes.js";

/**
 * ADR 0047: `MemoryStore.recordUsage` は `recall_usages.recall_id → recalls(id)` の
 * 外部キー相当を要求するようになった（`FakeMemoryStore` にも適用した）。以前この節の
 * 2つのテストは実体の無い固定文字列 `"recall-1"` を渡していたが、それは「本番経路では
 * 起きえない `recall_usages` 行」を手元でだけ緑にしていた（ADR 0047 の決め手）。
 * `MemoryStore.createRecall`（recall 段6の書き込み口そのもの）で実在の recallId を用意する。
 */
async function createRecallFixture(stores: { memoryStore: FakeMemoryStore }, ctx: Ctx) {
  return stores.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "fixture" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemoryIds: [],
  });
}

const ctx: Ctx = { tenantId: "tenant-1" };
// このファイルの歯はリースの境界そのものを検査しない(それは
// outbox-store-conformance.ts の役目)ので、十分に長く固定した値を使う。
const TEST_LEASE_MS = 60_000;

function llmReturning(
  memories: {
    content: string;
    digest?: string;
    provenanceKind: "stated" | "inferred";
    confidence?: number;
  }[],
): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse({ memories }) as T,
  };
}

function throwingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async () => {
      throw new Error("simulated LLM outage");
    },
  };
}

function buildRuntime(
  llmProvider: LLMProvider,
  overrides: Partial<Parameters<typeof createRuntime>[0]> = {},
) {
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
    ...overrides,
  });
  return { runtime, stores };
}

describe("runtime.observe — extract: 'sync'（既定, D2）", () => {
  it("utterance を観測すると、その場で抽出されて Memory が作られる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "東京出張がある", digest: "東京出張", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "明日東京に出張します" });

    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.digest).toBe("東京出張");
    expect(memory?.digestSource).toBe("llm");
    expect(memory?.sourceObservationId).toBe(result.observationId);
  });

  it("digest 生成に失敗した候補は digestSource: 'fallback' で content は必ず保持される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "長い本文がここに入ります", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "テスト発話" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.digestSource).toBe("fallback");
    expect(memory?.content).toBe("長い本文がここに入ります");
  });

  it("LLM 呼び出し自体が失敗しても observe() 全体は失敗せず、全文を保持した Memory が1件残る", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "障害時でも残したい発話",
    });
    expect(result.extraction).toBe("llm_failed_whole_observation");
    expect(result.memoryIds).toHaveLength(1);
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.content).toBe("障害時でも残したい発話");
    expect(memory?.provenance.kind).toBe("stated");
  });

  /**
   * ADR 0008 の判定基準を取り込み側に当てる。
   *
   * LLM 呼び出しが失敗して全文フォールバックへ倒れた Memory は、**抽出されたものではない**
   * ——未処理の生テキストである。監査ログがこれを `reason: 'extracted'` として記録すると、
   * 監査ログ自体が事実でないことを主張することになる（「消えたことが見える」ための仕組みが、
   * 「起きなかったことが起きた」と言う）。
   *
   * この歯は、`meta.reason` が抽出の成否を区別し続けることを守る。
   */
  it("LLM が失敗して全文フォールバックへ倒れたことが、監査ログの meta.reason に残る", async () => {
    const { runtime, stores } = buildRuntime(throwingLlm());
    const result = await runtime.observe(ctx, { kind: "utterance", text: "障害時の発話" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect(created).toBeDefined();
    expect((created!.meta as { reason?: string }).reason).toBe(
      "extraction_failed_whole_observation_fallback",
    );
  });

  it("正常に抽出できたときの監査ログは reason: 'extracted' のままである（上の歯と対になる）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文Y", digest: "要旨Y", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文Y" });

    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    const created = events.find((event) => event.kind === "created");
    expect((created!.meta as { reason?: string }).reason).toBe("extracted");
  });

  it("createMemory の contentHash は注入された hashContent で計算される（core は計算しない, D16）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文X", digest: "要旨X", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文X" });
    const memory = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(memory?.contentHash).toBe("sha256(本文X)");
  });

  it("Memory 作成時に 'created' イベントが監査ログへ記録される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const events = await stores.eventStore.list(ctx, { memoryId: result.memoryIds[0]! });
    expect(events.some((e) => e.kind === "created")).toBe(true);
  });

  it("LLM が0件の候補を返したら Memory は作られない（ゴミ記憶を増やさない）", async () => {
    const { runtime } = buildRuntime(llmReturning([]));
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "特に記憶するまでもない雑談",
    });
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toEqual([]);
  });

  it("extract 済みの extract ジョブは outbox 上で completed になる（黙って溜め込まない）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["extract"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toEqual([]);
  });

  it("embed ジョブは sync 抽出でも常に outbox 経由（未処理のまま残る）", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
  });
});

describe("runtime.observe — extract: 'deferred'", () => {
  it("deferred では抽出されず、extract ジョブが outbox に残る", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      extract: "deferred",
    });
    expect(result.extraction).toBe("skipped");
    expect(result.memoryIds).toEqual([]);

    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["extract"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.observationId).toBe(result.observationId);
  });

  it("runtime.tick で deferred の extract ジョブを消化すると Memory が作られる", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      extract: "deferred",
    });
    expect(result.memoryIds).toEqual([]);

    const tickResult = await runtime.tick(ctx, { kinds: ["extract"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 1, failed: 0 });

    const aggregate = await stores.memoryStore.aggregateScope(ctx, {});
    expect(aggregate.totalInScope).toBe(1);
  });
});

describe("runtime.observe — 冪等性（roadmap.md 段階3の完了条件）", () => {
  it("同じ externalId の Observation を二重に送っても Memory が重複して作られない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文",
      externalId: "ext-1",
    });
    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "本文（無視されるべき別内容）",
      externalId: "ext-1",
    });

    expect(second.observationId).toBe(first.observationId);
    expect(second.extraction).toBe("skipped");
    expect(second.memoryIds).toEqual([]);

    const aggregate = await stores.memoryStore.aggregateScope(ctx, {});
    expect(aggregate.totalInScope).toBe(1);
  });

  it("冪等な再送では新しい outbox ジョブを積まない", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    await runtime.observe(ctx, { kind: "utterance", text: "本文", externalId: "ext-2" });
    await runtime.observe(ctx, { kind: "utterance", text: "本文", externalId: "ext-2" });

    // 最初の1回の抽出で作られた embed ジョブ(1件)だけが残っているはず。
    const pending = await stores.outboxStore.claimBatch(ctx, {
      kinds: ["embed"],
      limit: 10,
      now: new Date(),
      claimedBy: "test",
      leaseMs: TEST_LEASE_MS,
    });
    expect(pending).toHaveLength(1);
  });
});

describe("runtime.observe — memory_usage（ADR 0009）", () => {
  it("使用報告は抽出器を通らず、recall_usages への挿入と reinforce だけを行う", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    const recallId = await createRecallFixture(stores, ctx);
    const result = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });

    expect(result.extraction).toBe("skipped");
    expect(result.memoryIds).toEqual([memory.id]);
    const reinforced = await stores.memoryStore.get(ctx, memory.id);
    expect(reinforced?.lastReinforcedAt).not.toBeNull();
  });

  it("同じ (recallId, memoryId) の再送では reinforce が二重に走らない（insertedMemoryIds が空）", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    const memory = await stores.memoryStore.createMemory(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: null,
      extractorVersion: null,
      content: "本文",
      contentHash: "hash",
      digest: "要旨",
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "batch-1" },
      tags: [],
      occurredAt: null,
      recordedAt: new Date("2026-01-01T00:00:00.000Z"),
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 720,
      decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
      embeddingStatus: "pending",
    });

    const recallId = await createRecallFixture(stores, ctx);
    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    const second = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    expect(second.memoryIds).toEqual([]);
  });
});

describe("runtime.tick — embed ジョブ（embeddingStatus の遷移）", () => {
  it("embed ジョブを処理すると embeddingStatus が 'ready' になり、vector が upsert される", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 1, failed: 0 });

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("ready");
    expect(stores.vectorStore.entries.size).toBe(1);
  });

  it("embedding provider が失敗すると embeddingStatus が 'failed' になり、tick は failed をカウントする", async () => {
    const { runtime, stores } = buildRuntime(
      llmReturning([{ content: "本文", digest: "要旨", provenanceKind: "stated" }]),
    );
    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "本文" });
    const memoryId = observeResult.memoryIds[0]!;

    stores.embeddingProvider.shouldFail = true;
    const tickResult = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 0, failed: 1 });

    const memory = await stores.memoryStore.get(ctx, memoryId);
    expect(memory?.embeddingStatus).toBe("failed");
  });
});

describe("runtime.tick — 未知の outbox job kind", () => {
  it("未知の kind は無視して溜め込まず、失敗として扱う", async () => {
    const { runtime, stores } = buildRuntime(llmReturning([]));
    // observe を経由せず、直接 outbox に不正な kind のジョブを積む状況を再現する。
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: "tenant-1", subjectId: null, externalId: null, kind: "utterance", payload: {} },
      ["mystery-kind"],
    );
    expect(jobs).toHaveLength(1);

    const tickResult = await runtime.tick(ctx, { kinds: ["mystery-kind"], leaseMs: TEST_LEASE_MS });
    expect(tickResult).toEqual({ processed: 0, failed: 1 });
  });
});

describe("runtime.reextract（ADR 0028: 「やり直したら重複が残る」の掃除）", () => {
  /**
   * runtime1（失敗する LLM）で observe() させ、全文フォールバックの Memory を1件作る。
   * runtime2（成功する LLM）は同じ stores を共有する——「provider が復旧した後」を模す。
   */
  function buildReextractScenario(succeedingCandidates: Parameters<typeof llmReturning>[0]) {
    const { runtime: runtime1, stores } = buildRuntime(throwingLlm());
    const runtime2 = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llmReturning(succeedingCandidates),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    return { runtime1, runtime2, stores };
  }

  it("⭐ reextract を2回走らせても、2回目では Memory が増えない（冪等は『数が増えない』で測る。オーナーの線）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "抽出結果A", digest: "要旨A", provenanceKind: "stated" },
      { content: "抽出結果B", digest: "要旨B", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, {
      kind: "utterance",
      text: "障害時に取り込まれた発話",
    });
    expect(observeResult.extraction).toBe("llm_failed_whole_observation");

    const countFor = async () =>
      (await stores.memoryStore.listBySourceObservation(ctx, observeResult.observationId, "v1"))
        .length;

    expect(await countFor()).toBe(1); // フォールバックの1件のみ

    const first = await runtime2.reextract(ctx, observeResult.observationId);
    expect(first.extraction).toBe("ok");
    const afterFirst = await countFor();
    expect(afterFirst).toBe(3); // フォールバック(superseded) + 新規2件

    const second = await runtime2.reextract(ctx, observeResult.observationId);
    expect(second.extraction).toBe("ok");
    const afterSecond = await countFor();
    // ⚠ 「キーが在る」ではなく「数が増えない」を assert する。
    expect(afterSecond).toBe(afterFirst);
  });

  it("全文フォールバックの Memory が superseded になり、superseded_by_id が新しい Memory を指す", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.supersededMemoryIds).toEqual([fallbackId]);

    const fallbackMemory = await stores.memoryStore.get(ctx, fallbackId);
    expect(fallbackMemory?.status).toBe("superseded");
    expect(fallbackMemory?.supersededById).toBe(result.memoryIds[0]);

    const target = await stores.memoryStore.get(ctx, fallbackMemory!.supersededById!);
    expect(target?.status).toBe("active");
  });

  it("🔴 候補が0件なら、何も supersede しない（0件は正常な抽出結果であり、これを根拠に既存を消さない）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toEqual([]);
    expect(result.supersededMemoryIds).toEqual([]);

    const fallbackMemory = await stores.memoryStore.get(ctx, fallbackId);
    expect(fallbackMemory?.status).toBe("active"); // 触られていない
  });

  it("🔴 forgotten の Memory は supersede されない（利用者が意図して忘れさせたものを機構の都合で上書きしない）", async () => {
    const { runtime1, runtime2, stores } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    const fallbackId = observeResult.memoryIds[0]!;
    await stores.memoryStore.updateStatus(ctx, fallbackId, "forgotten");

    const result = await runtime2.reextract(ctx, observeResult.observationId);
    expect(result.supersededMemoryIds).toEqual([]);

    const stillForgotten = await stores.memoryStore.get(ctx, fallbackId);
    expect(stillForgotten?.status).toBe("forgotten");
    expect(stillForgotten?.supersededById ?? null).toBeNull();
  });

  it("reextract のあと、recall() の omitted に filtered(superseded) が出る（ADR 0027 と繋がる）", async () => {
    const { runtime1, runtime2 } = buildReextractScenario([
      { content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" },
    ]);
    const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
    await runtime2.reextract(ctx, observeResult.observationId);

    const recallResult = await runtime2.recall(ctx, {});
    expect(recallResult.omitted).toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "superseded" }),
    );
  });

  it("変わっていない候補は、2回目の reextract でも superseded にならない（content_hash 比較を外すと壊れる歯）", async () => {
    // ここでは observe() 自体が最初から成功する（フォールバックを経由しない）。
    const stores = createFakeRuntimeStores();
    const succeedingLlm = llmReturning([
      { content: "変わらない内容", digest: "要旨", provenanceKind: "stated" },
    ]);
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: succeedingLlm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(observeResult.extraction).toBe("ok");
    const originalId = observeResult.memoryIds[0]!;

    // 同じ候補で reextract を2回走らせる——LLM は毎回同じ内容を返す（決定的）。
    await runtime.reextract(ctx, observeResult.observationId);
    const result = await runtime.reextract(ctx, observeResult.observationId);

    expect(result.supersededMemoryIds).toEqual([]);
    const original = await stores.memoryStore.get(ctx, originalId);
    expect(original?.status).toBe("active");
    expect(original?.supersededById ?? null).toBeNull();
  });

  // ADR 0029: ADR 0028 が「引き受ける負債」に記録した欠落を埋める歯。
  // `ReextractResult.skipped` が「見ていない」「見たが対象外」「見て変わっていなかった」を
  // 別の顔で出すことを確かめる。
  describe("skipped（ADR 0029: 既存 Memory を supersede しなかった理由を出す）", () => {
    /** 同じ stores を共有しつつ、llmProvider だけ差し替えた runtime を作る。 */
    function runtimeWithLlm(
      stores: ReturnType<typeof createFakeRuntimeStores>,
      llmProvider: LLMProvider,
    ) {
      return createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider,
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
    }

    function skipForId(skipped: ReextractSkip[], id: string) {
      return skipped.find((s) => s.kind !== "not_examined" && s.memoryId === id);
    }

    it("⭐ contested 1件・forgotten 2件が status 付きで非対称に skipped へ出る（隣の値への入れ替え変異を検出する）", async () => {
      const stores = createFakeRuntimeStores();
      const runtime1 = runtimeWithLlm(
        stores,
        llmReturning([
          { content: "候補1", digest: "要旨1", provenanceKind: "stated" },
          { content: "候補2", digest: "要旨2", provenanceKind: "stated" },
          { content: "候補3", digest: "要旨3", provenanceKind: "stated" },
        ]),
      );
      const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });
      expect(observeResult.memoryIds).toHaveLength(3);
      const [contestedId, forgotten1Id, forgotten2Id] = observeResult.memoryIds as [
        string,
        string,
        string,
      ];
      await stores.memoryStore.updateStatus(ctx, contestedId, "contested");
      await stores.memoryStore.updateStatus(ctx, forgotten1Id, "forgotten");
      await stores.memoryStore.updateStatus(ctx, forgotten2Id, "forgotten");

      // 別内容を返す LLM で reextract する——3件とも今回の content_hash 集合に含まれない。
      const runtime2 = runtimeWithLlm(
        stores,
        llmReturning([{ content: "新しい抽出結果", digest: "要旨", provenanceKind: "stated" }]),
      );
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.skipped).toHaveLength(3);
      expect(result.supersededMemoryIds).toEqual([]); // 3件とも active ではないので supersede 対象外

      const contestedSkip = skipForId(result.skipped, contestedId);
      const forgotten1Skip = skipForId(result.skipped, forgotten1Id);
      const forgotten2Skip = skipForId(result.skipped, forgotten2Id);
      expect(contestedSkip).toEqual({
        kind: "status_not_active",
        memoryId: contestedId,
        status: "contested",
      });
      expect(forgotten1Skip).toEqual({
        kind: "status_not_active",
        memoryId: forgotten1Id,
        status: "forgotten",
      });
      expect(forgotten2Skip).toEqual({
        kind: "status_not_active",
        memoryId: forgotten2Id,
        status: "forgotten",
      });

      // 非対称であることそのものを assert する——同数だと入れ替え変異が生き残る。
      const statuses = result.skipped
        .filter(
          (s): s is Extract<ReextractSkip, { kind: "status_not_active" }> =>
            s.kind === "status_not_active",
        )
        .map((s) => s.status);
      expect(statuses.filter((status) => status === "contested")).toHaveLength(1);
      expect(statuses.filter((status) => status === "forgotten")).toHaveLength(2);
    });

    it("content_hash が一致した既存 Memory は { kind: 'unchanged' } として skipped に出る", async () => {
      const stores = createFakeRuntimeStores();
      const succeedingLlm = llmReturning([
        { content: "変わらない内容", digest: "要旨", provenanceKind: "stated" },
      ]);
      const runtime = runtimeWithLlm(stores, succeedingLlm);

      const observeResult = await runtime.observe(ctx, { kind: "utterance", text: "発話" });
      expect(observeResult.extraction).toBe("ok");
      const originalId = observeResult.memoryIds[0]!;

      // 同じ内容を返す LLM で reextract する——content_hash が一致し続ける。
      const result = await runtime.reextract(ctx, observeResult.observationId);

      expect(result.skipped).toEqual([{ kind: "unchanged", memoryId: originalId }]);
      expect(result.supersededMemoryIds).toEqual([]);
    });

    it("🔴 候補が0件のとき skipped は [{ kind: 'not_examined', reason: 'no_candidates' }]（listBySourceObservation を呼ぶ前の早期 return）", async () => {
      const { runtime1, runtime2 } = buildReextractScenario([]);
      const observeResult = await runtime1.observe(ctx, { kind: "utterance", text: "発話" });

      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("ok");
      expect(result.skipped).toEqual([{ kind: "not_examined", reason: "no_candidates" }]);
    });

    it("🔴 LLM がまた失敗したとき skipped は [{ kind: 'not_examined', reason: 'llm_failed_whole_observation' }]（listBySourceObservation を呼ぶ前の早期 return）", async () => {
      const stores = createFakeRuntimeStores();
      const runtime1 = runtimeWithLlm(stores, throwingLlm());
      const observeResult = await runtime1.observe(ctx, {
        kind: "utterance",
        text: "障害時に取り込まれた発話",
      });
      expect(observeResult.extraction).toBe("llm_failed_whole_observation");

      // reextract でも同じく LLM が失敗し続ける。
      const runtime2 = runtimeWithLlm(stores, throwingLlm());
      const result = await runtime2.reextract(ctx, observeResult.observationId);

      expect(result.extraction).toBe("llm_failed_whole_observation");
      expect(result.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);
    });

    it("⭐ 「飛ばすものが無かった」・「候補0件」・「LLM失敗」の3つの顔が違う（オーナーの追加要求）", async () => {
      const stores = createFakeRuntimeStores();
      // 候補0件の LLM で observe() する——Memory は1件も作られない。
      const zeroLlm = llmReturning([]);
      const zeroRuntime = runtimeWithLlm(stores, zeroLlm);

      // 顔1: 「飛ばすものが無かった」——既存 Memory が無い Observation に、候補が有る LLM で
      // reextract する。本経路（`classifyReextractTargets`）を通るが、existingBefore が
      // 空なので skipped も空になる。
      const observeResult1 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話1" });
      expect(observeResult1.memoryIds).toEqual([]);
      const succeedingRuntime = runtimeWithLlm(
        stores,
        llmReturning([{ content: "新規", digest: "要旨", provenanceKind: "stated" }]),
      );
      const nothingToSkip = await succeedingRuntime.reextract(ctx, observeResult1.observationId);
      expect(nothingToSkip.skipped).toEqual([]);

      // 顔2: 「候補0件」——別の Observation に対し、候補0件の LLM のまま reextract する。
      // listBySourceObservation を呼ぶ前の早期 return。
      const observeResult2 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話2" });
      const noCandidates = await zeroRuntime.reextract(ctx, observeResult2.observationId);
      expect(noCandidates.skipped).toEqual([{ kind: "not_examined", reason: "no_candidates" }]);

      // 顔3: 「LLM失敗」——さらに別の Observation に対し、LLM 自体が例外を投げる。
      // これも listBySourceObservation を呼ぶ前の早期 return。
      const observeResult3 = await zeroRuntime.observe(ctx, { kind: "utterance", text: "発話3" });
      const throwingRuntime = runtimeWithLlm(stores, throwingLlm());
      const llmFailed = await throwingRuntime.reextract(ctx, observeResult3.observationId);
      expect(llmFailed.skipped).toEqual([
        { kind: "not_examined", reason: "llm_failed_whole_observation" },
      ]);

      // 3つの顔がそれぞれ違うことを並べて確認する——顔1だけが空配列（見たうえで、飛ばす
      // ものが無かった）で、顔2・顔3は同じ「見ていない」でも reason が違う。
      expect(nothingToSkip.skipped).not.toEqual(noCandidates.skipped);
      expect(noCandidates.skipped).not.toEqual(llmFailed.skipped);
      expect(nothingToSkip.skipped).not.toEqual(llmFailed.skipped);
    });
  });

  // ADR 0030（安全弁3）: 読み（listBySourceObservation）と書き（updateStatus）の間に
  // 割り込む書き込みで安全弁が破れる TOCTOU を、compare-and-swap で塞いだことを検査する。
  describe("compare-and-swap（ADR 0030: 読んでから書くまでの間の TOCTOU を検知する）", () => {
    it("⭐ 対象 M の1件目を書きに来た瞬間に M を forgotten へ変えても、M は forgotten のまま・supersede されず・イベントも積まれない（別の対象 N は普通に supersede される）", async () => {
      const stores = createFakeRuntimeStores();
      // 既存 Memory を2件作る（非対称: M は割り込みで forgotten に変わる、N は変わらない）。
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "M候補", digest: "M要旨", provenanceKind: "stated" },
          { content: "N候補", digest: "N要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });
      const [mId, nId] = observeResult.memoryIds as [string, string];

      // reextract 用の runtime（別内容を返す LLM——M・N とも今回の content_hash 集合に無い）。
      const reextractRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      // 決定的な差し込み: toSupersede は existingBefore の順（M, N）でループされる
      // （FakeBackingStore.memories は Map で挿入順を保つ）。M への1件目の書き込みが
      // 来た「まさにその瞬間」に、別の誰か（利用者による forget 相当）が M を
      // forgotten に変えたことにする。N には介入しない——フィクスチャを非対称にする
      // ことで「件数は合っているが対応が崩れている」変異も捕まえられるようにする。
      //
      // `FakeMemoryStore.get` は backing.memories に入っている Memory オブジェクトへの
      // 参照をそのまま返す実装（コピーを作らない）なので、事前に取得した参照の
      // `status` を書き換えるだけで「割り込み」を再現できる。
      const mBeforeIntervention = await stores.memoryStore.get(ctx, mId);
      let intervened = false;
      stores.memoryStore.beforeUpdateStatus = (id) => {
        if (!intervened && id === mId) {
          intervened = true;
          mBeforeIntervention!.status = "forgotten";
        }
      };

      const result = await reextractRuntime.reextract(ctx, observeResult.observationId);

      // M: forgotten のまま・supersede されていない・skipped に status_changed_concurrently。
      const mAfter = await stores.memoryStore.get(ctx, mId);
      expect(mAfter?.status).toBe("forgotten");
      expect(result.supersededMemoryIds).not.toContain(mId);
      expect(result.skipped).toContainEqual({
        kind: "status_changed_concurrently",
        memoryId: mId,
        observedStatus: "forgotten",
      });
      const mEvents = stores.eventStore.events.filter(
        (e) => e.memoryId === mId && e.kind === "superseded",
      );
      expect(mEvents).toEqual([]); // superseded イベントは一切積まれていない

      // N: 同じ呼び出しの中で、普通に supersede されている（非対称であることの確認）。
      expect(result.supersededMemoryIds).toContain(nId);
      const nAfter = await stores.memoryStore.get(ctx, nId);
      expect(nAfter?.status).toBe("superseded");
      const nEvents = stores.eventStore.events.filter(
        (e) => e.memoryId === nId && e.kind === "superseded",
      );
      expect(nEvents).toHaveLength(1);
    });

    it("競合でない例外（updateStatus が想定外のエラーを投げた）はそのまま再送出される", async () => {
      const stores = createFakeRuntimeStores();
      const setupRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([{ content: "候補", digest: "要旨", provenanceKind: "stated" }]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });
      const observeResult = await setupRuntime.observe(ctx, { kind: "utterance", text: "発話" });

      const reextractRuntime = createRuntime({
        memoryStore: stores.memoryStore,
        outboxStore: stores.outboxStore,
        vectorStore: stores.vectorStore,
        eventStore: stores.eventStore,
        tenantSettingsStore: stores.tenantSettingsStore,
        llmProvider: llmReturning([
          { content: "新しい抽出結果", digest: "新要旨", provenanceKind: "stated" },
        ]),
        embeddingProvider: stores.embeddingProvider,
        hashContent: (content: string) => `sha256(${content})`,
      });

      // 競合ではない、ただの障害（例: 接続断）を模す。`reextract` は ADR 0031 以降
      // `updateStatus` ではなく `updateStatusWithEvent` を呼ぶ（status 更新とイベント追記を
      // 1回のトランザクションにまとめたため）——ここで差し替えるのもそちらにする。
      stores.memoryStore.updateStatusWithEvent = async () => {
        throw new Error("simulated connection reset");
      };

      await expect(reextractRuntime.reextract(ctx, observeResult.observationId)).rejects.toThrow(
        "simulated connection reset",
      );
    });
  });
});

describe("observe の冪等な再送は、同時に別の観測が入っても抽出をやり直さない（ADR 0054）", () => {
  /**
   * `handleExtractableObservation` は `createObservationWithOutbox` の `created` だけを見て
   * 「抽出をやり直すか」を決める。擬似実装が `created` を大域の件数差から導いていると、
   * **同時に別の観測が作られただけで再送が「新規」に化け**、同じ observation に対して
   * 抽出がもう一度走る——LLM がもう一度叩かれ、`extraction` が `"skipped"` ではなく
   * 抽出結果になり、`memoryIds` が空でなくなる。ここで測っているのはその**値**である。
   */
  it("再送は extraction: 'skipped'・memoryIds: [] のままで、LLM は増えない", async () => {
    let llmCalls = 0;
    const countingLlm: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        llmCalls += 1;
        return req.schema.parse({
          memories: [{ content: "東京出張がある", digest: "東京出張", provenanceKind: "stated" }],
        }) as T;
      },
    };
    const { runtime } = buildRuntime(countingLlm);

    const seed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "明日東京に出張します",
      externalId: "utt-adr54",
    });
    expect(seed.extraction).toBe("ok");
    const llmCallsAfterSeed = llmCalls;

    const [resend, fresh] = await Promise.all([
      runtime.observe(ctx, {
        kind: "utterance",
        text: "明日東京に出張します",
        externalId: "utt-adr54",
      }),
      runtime.observe(ctx, {
        kind: "utterance",
        text: "来週大阪に行きます",
        externalId: "utt-adr54-other",
      }),
    ]);

    expect({
      resendExtraction: resend.extraction,
      resendMemoryIds: resend.memoryIds,
      resendIsSeedObservation: resend.observationId === seed.observationId,
      freshExtraction: fresh.extraction,
      freshMemoryCount: fresh.memoryIds.length,
      freshIsDistinctObservation: fresh.observationId !== seed.observationId,
      llmCallsAddedByResendAndFresh: llmCalls - llmCallsAfterSeed,
    }).toEqual({
      resendExtraction: "skipped",
      resendMemoryIds: [],
      resendIsSeedObservation: true,
      freshExtraction: "ok",
      freshMemoryCount: 1,
      freshIsDistinctObservation: true,
      // fresh のぶんの1回だけ。再送は抽出を走らせない。
      llmCallsAddedByResendAndFresh: 1,
    });
  });
});
