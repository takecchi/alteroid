import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { VectorStore } from "../interfaces/vector-store.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * roadmap.md 段階4「想起」・段階5「説明」の完了条件そのものを検査する。
 *
 * - omitted の各 kind（stage_skipped/filtered/below_threshold/over_limit/budget_dropped/
 *   not_indexed/ann_truncated）が実際に発生する条件下で返せること。
 * - 段3（矛盾の解決）の mandatory companion retrieval と隣接性。
 * - 段4（予算切り詰め）が同伴ペアを分割しないこと。
 * - 被覆不変条件（groups の総和 == totalInScope）。
 * - explain.stages が実際に走った/走らなかった段を反映すること。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

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

/**
 * `ann_unreached`（ADR 0026）の歯のためだけの、`VectorStore` の薄いラッパー。
 *
 * `FakeVectorStore`（`runtime-fakes.ts`）は「本物同様に status/decayFloor でフィルタしつつ
 * cosine 距離で ANN を模する」ことはできるが、「scope にもっと候補があるのに、ANN が
 * それより少ない件数しか返さない」——近似索引が届かなかった、という状況そのものは
 * 作れない（`limit` まで律儀に返してしまう）。この状況を作るのに `runtime-fakes.ts`
 * 自体を変える必要は無く、`search` の返り件数を後から切り詰めるだけで足りるので、
 * ここに局所的なラッパーとして置く（`runtime-fakes.ts` は変更しない）。
 */
class CappedVectorStore implements VectorStore {
  constructor(
    private readonly inner: VectorStore,
    private readonly cap: number,
  ) {}

  upsert(...args: Parameters<VectorStore["upsert"]>): ReturnType<VectorStore["upsert"]> {
    return this.inner.upsert(...args);
  }

  async search(...args: Parameters<VectorStore["search"]>): ReturnType<VectorStore["search"]> {
    const hits = await this.inner.search(...args);
    return hits.slice(0, this.cap);
  }

  delete(...args: Parameters<VectorStore["delete"]>): ReturnType<VectorStore["delete"]> {
    return this.inner.delete(...args);
  }
}

/** `buildRuntime()` と同じ配線だが、`vectorStore` だけ `CappedVectorStore` に差し替える。 */
function buildRuntimeWithCappedAnn(cap: number) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: new CappedVectorStore(stores.vectorStore, cap),
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
  // `createEmbeddedMemory` は `stores.vectorStore.upsert` を直接呼ぶ想定なので、
  // 返す `stores` は素の（capされていない）参照のままにする——upsert は cap の対象外。
  return { runtime, stores };
}

/** 埋め込み済みの Memory を1件用意する（vectorStore への upsert も行う）。 */
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

describe("recall() — omitted.kind = 'stage_skipped'（候補生成、docs/recall.md §2 段1）", () => {
  it("text も vector も無いと candidate_generation は 'empty_query_content' で skip される", async () => {
    const { runtime } = buildRuntime();
    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "empty_query_content",
    });
    expect(result.memories).toEqual([]);
    const trace = result.explain.stages.find((s) => s.stage === "candidate_generation");
    expect(trace?.executed).toBe(false);
  });

  it("embedding provider が失敗すると 'embedding_provider_unavailable' で skip される", async () => {
    const { runtime, stores } = buildRuntime();
    stores.embeddingProvider.shouldFail = true;
    const result = await runtime.recall(ctx, { text: "何かのクエリ" });
    expect(result.omitted).toContainEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "embedding_provider_unavailable",
    });
  });
});

describe("recall() — omitted.kind = 'filtered'（スコープを定義するフィルタ。マネージャー決定）", () => {
  it("status='archived' は totalInScope に含まれず、filtered(archived) として報告される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { status: "active" });
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "archived",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });

  it("status='superseded'/'forgotten' は別々の filtered omission として報告される（ADR 0027、束ねない）", async () => {
    const { runtime, stores } = buildRuntime();
    // 件数をわざと非対称にする（3 と 5）。1件ずつだと、取り違え
    // （superseded と forgotten を入れ替えて push する）も、束ねたまま
    // （両方を1つの omission に合算する）も、どちらも見抜けない。3 と 5 なら、
    // 束ねれば8、取り違えれば5/3になり、どちらも必ず落ちる。
    for (let i = 0; i < 3; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory({ status: "superseded" }));
    }
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    }

    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "superseded",
      count: 3,
      countKind: "exact",
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "forgotten",
      count: 5,
      countKind: "exact",
    });
    // 束ねられていないこと（"status" という condition はもう存在しない）を確認する。
    expect(result.omitted).not.toContainEqual(
      expect.objectContaining({ kind: "filtered", condition: "status" }),
    );
  });

  it("occurredAfter の外にある Memory は filtered(period) に報告され、totalInScope から除かれる", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date("2020-01-01T00:00:00.000Z") }),
    );
    await createEmbeddedMemory(stores, [1, 0], {
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      occurredAfter: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(result.omitted).toContainEqual({
      kind: "filtered",
      condition: "period",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });
});

describe("recall() — omitted.kind = 'not_indexed'（docs/recall.md §4）", () => {
  it("embeddingStatus !== 'ready' な in-scope Memory は not_indexed として報告される（totalInScope には残る）", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory({ embeddingStatus: "pending" }));

    const result = await runtime.recall(ctx, {});
    expect(result.omitted).toContainEqual({
      kind: "not_indexed",
      reason: "pending",
      count: 1,
      countKind: "exact",
    });
    expect(result.index.totalInScope).toBe(1);
  });
});

describe("recall() — omitted.kind = 'below_threshold'（docs/recall.md §2 段2）", () => {
  it("similarity が低く score.total が閾値未満の候補は below_threshold へ回り、memories には出ない", async () => {
    const { runtime, stores } = buildRuntime();
    // クエリベクトル [1,0] に対して直交する [0,1] は cosine 類似度 0 -> total は 0 になる。
    await createEmbeddedMemory(stores, [0, 1]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toEqual([]);
    const omission = result.omitted.find((o) => o.kind === "below_threshold");
    expect(omission).toBeDefined();
    if (omission?.kind === "below_threshold") {
      expect(omission.count).toBe(1);
      expect(omission.countKind).toBe("exact");
      expect(omission.nearMisses?.[0]?.score).toBeCloseTo(0, 10);
    }
  });
});

describe("recall() — omitted.kind = 'over_limit'（docs/recall.md §2 段2）", () => {
  it("閾値を超える候補が limit より多いと over_limit として報告される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 10 });
    expect(result.memories).toHaveLength(1);
    expect(result.omitted).toContainEqual({ kind: "over_limit", count: 1, countKind: "exact" });
  });
});

describe("recall() — omitted.kind = 'ann_truncated'（docs/recall.md §3、ADR 0069）", () => {
  // 🔴 **この describe の契約は ADR 0069 で変わった。**
  //
  // かつては「ANN の返り件数が k' に達したら ann_truncated が付く」だった。いまは
  // **「k' に達し、かつ *損失が起こりえた* ときだけ付く」** である——窓が埋まったことは
  // 「スコープが k' 以上ある」としか言っておらず、損したかどうかを一切言っていなかった
  // （実測でスコープ 75件・k'=40 のとき 7 probe すべてが鳴り、実損は 0/7 だった）。
  //
  // **⚠ 下の1本目は、以前の歯と同じ状況をそのまま作って「鳴らなくなったこと」を測る。**
  // 歯を消して逃げるのではなく、**契約が変わった向きをそのまま固定する。**
  it("k' に達しても、窓の外が top-k へ入れないと証明できたら鳴らない（ADR 0069）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // limit=1, overFetchFactor=1 -> k'=1。候補が2件あるのに1件しか返らない（＝窓は埋まった）。
    // ただし返った1件は similarity=1.0 で、非 similarity 項は全部が上界に張り付いている
    // （clock 固定なので decay=freshness=1、クエリタグ無しで tagMatch=1、strength=1）。
    // ⟹ R = 1 / (1 × 1) = 1 ⟹ 窓の外は原理的に抜けない ⟹ 沈黙。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 1, overFetchFactor: 1 });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(false);
  });

  it("窓の外が top-k へ入りえたら、safetyRatio と前提を付けて鳴る（ADR 0069）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // 上とまったく同じ状況に、**どの候補も持っていないタグ**をクエリへ足すだけ。
    // ⟹ 上界 M_max は 1 + 0.1 = 1.1 へ上がるが、返った1件の実際の tagMatch は 1.0 のまま。
    // ⟹ R = 1.0 / (1.0 × 1.1) ≈ 0.909 < 1
    // ⟹ **「窓の外にこのタグを持つ記憶が居たら、抜かれていた」**——これがこの札の意味である。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      tags: ["どの候補も持っていないタグ"],
    });
    const found = result.omitted.find((o) => o.kind === "ann_truncated");
    if (found === undefined || found.kind !== "ann_truncated") {
      throw new Error("ann_truncated が積まれていない");
    }
    expect(found.certainty).toBe("loss_possible");
    expect(found.countKind).toBe("unknown");
    expect(found.safetyRatio).toBeLessThan(1);
    expect(found.safetyRatio).toBeCloseTo(1 / 1.1, 6);
    // **前提を名乗っていること。**コメントではなく戻り値で（ADR 0069 §6）。
    expect(found.assumptions?.join(" ")).toContain("decay");
    expect(found.assumptions?.join(" ")).toContain("strength");
  });

  it("候補が k' 未満ならフルスキャンと同精度になり ann_truncated は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, overFetchFactor: 4 });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(false);
  });
});

describe("recall() — omitted.kind = 'ann_unreached'（ADR 0025 の実測、ADR 0026 の決定）", () => {
  it("歯A（鳴る側）: scope に候補が多くあるのに ANN が eligible 未満しか返さないと ann_unreached が付く", async () => {
    const { runtime, stores } = buildRuntimeWithCappedAnn(2);
    // 5件が scope 内・embeddingStatus='ready'（= eligible = 5）だが、ANN は2件しか返さない
    // （CappedVectorStore が模する「近似索引が届かなかった」状況。2 < kPrime(=40) かつ
    // 2 < eligible(=5) なので発火するはず）。
    for (let i = 0; i < 5; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.omitted).toContainEqual({ kind: "ann_unreached", countKind: "unknown" });
  });

  it("歯B（⭐ 鳴ってはいけない側。オーナー名指し）: scope の候補を全部 ANN が返した場合は ann_unreached が鳴らない", async () => {
    const { runtime, stores } = buildRuntime();
    // 候補3件・kPrime=40（limit10×overFetchFactor4）・hits=3。3 < 40 だが 3 == eligible なので
    // 発火してはいけない——ここが赤くなったら「常に鳴る」側へ倒れたことを意味する。
    for (let i = 0; i < 3; i += 1) {
      await createEmbeddedMemory(stores, [1, 0]);
    }

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, overFetchFactor: 4 });
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });

  it("歯C: ann_truncated が鳴る状況（hits == k'）では ann_unreached は同時に鳴らない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    await createEmbeddedMemory(stores, [1, 0.001]);

    // limit=1, overFetchFactor=1 -> k'=1。候補2件のうち1件しか返らない（＝窓が埋まる）。
    // **ADR 0069 以降、この状況で ann_truncated が鳴るかは「損しえたか」次第**なので、
    // 鳴る側になる形（どの候補も持たないタグをクエリへ足す）で作る——
    // **この歯の主題は「ann_unreached が同時に鳴らないこと」であって、ann_truncated の鳴り方ではない。**
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 1,
      tags: ["どの候補も持っていないタグ"],
    });
    expect(result.omitted.some((o) => o.kind === "ann_truncated")).toBe(true);
    expect(result.omitted.some((o) => o.kind === "ann_unreached")).toBe(false);
  });
});

describe("recall() — omitted.kind = 'unit_assembly_dropped'（ADR 0043）", () => {
  // **⚠ この歯は Phase 1 では一度も本番経路を通らない。**
  // `Runtime`（observe/tick/recall/reextract）は `contested` も `contestedWithId` も書かないため、
  // 一対一が破れた状態を作れない（`docs/memory-model.md`「関係グラフ本体は Phase 2」）。
  // ⟹ ここで測っているのは「いま壊れているもの」ではなく、
  //    **`contested` を作る主体が入ったときに機構が黙らない**という契約である。
  //
  // ⚠ この歯は「候補が単位から漏れること」を*正しい振る舞いとして固定しない*。
  //    固定するのは「漏れたときに黙らないこと」だけである。

  /**
   * 一対一が破れた `contested` の鎖 A→B→C を作る。
   * `contestedWithId` は一対一と定められているので、これは**壊れたデータ**である。
   *
   * 単位を組む繰り返しは A から始まり、A の対向として B を消費してペア [A,B] を作る。
   * 次の B は消費済みなので飛ばされ、**B の同伴として取られた C はどの単位にも入らない。**
   * ⟹ 候補3件に対して単位が覆うのは2件。
   */
  async function seedBrokenChain(stores: ReturnType<typeof createFakeRuntimeStores>) {
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "C" }),
    );
    const b = await createEmbeddedMemory(stores, [0.9, 0.1], {
      status: "contested",
      digest: "B",
      contestedWithId: c.id,
    });
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });
    return { a, b, c };
  }

  it("🔴 一対一が破れて候補が単位から漏れたら、omitted に出す（黙らない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { c } = await seedBrokenChain(stores);

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });

    // 前提: C は返っていない（返っているなら「消えた」は成り立たない）。
    expect(result.memories.map((m) => m.memoryId)).not.toContain(c.id);
    // 本題: 消えたことが omitted に出る。**直す前はここに何も出なかった。**
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("⚠ 鳴ってはいけない側: 一対一が破れていなければ出ない（対向ペア）", async () => {
    // ⚠ 件数を 2 対 1 と違える（ペア1組＋単独1件 = 候補3件）。
    //    同じ件数で作ると、単位の取り違えが出力を変えない。
    const { runtime, stores } = buildRuntime();
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "B" }),
    );
    await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });
    await createEmbeddedMemory(stores, [0.8, 0.2], { digest: "単独" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.memories.length).toBe(3);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("⚠ 鳴ってはいけない側: contested が1件も無い普通の recall でも出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "普通1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "普通2" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});

describe("recall() — budget_dropped の countKind は単位の網羅性から決まる（ADR 0045）", () => {
  it("🔴 単位が候補を網羅していないとき、budget_dropped は 'exact' を名乗らない", async () => {
    // **⚠ この歯は「候補が単位から漏れること」を*正しい振る舞いとして固定するものではない*。**
    // 固定しているのは「漏れているときに `'exact'` と名乗らないこと」——つまり**正直さ**である。
    // 漏れること自体は別の欠陥として報告してある（下記）。
    //
    // 作り方: contested の鎖 A→B→C を作る。`contestedWithId` は
    // `docs/memory-model.md` §5 が**一対一の対向関係**と定めているので、この鎖は**壊れたデータ**である。
    // ⟹ 機構はそれを拒まないので、こう並ぶ:
    //   - withinLimit = [A, B]（C は埋め込みが無いので候補にならない）
    //   - A の対向 B は withinLimit に居るので、同伴取得の対象は B の対向 C だけ
    //   - 単位を組む繰り返しは A から始まり、A の対向として B を消費してペア [A,B] を作る
    //   - 次の B は消費済みなので飛ばされ、**C はどの単位にも入らない**
    // ⟹ 候補3件に対して単位が覆うのは2件。**`countKindForUnits` が `'unknown'` へ落とす。**
    const { runtime, stores } = buildRuntime();
    const c = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "C" }),
    );
    const b = await createEmbeddedMemory(stores, [0.9, 0.1], {
      status: "contested",
      digest: "B",
      contestedWithId: c.id,
    });
    await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      digest: "A",
      contestedWithId: b.id,
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 },
    });
    const dropped = result.omitted.find((o) => o.kind === "budget_dropped");
    expect(dropped).toBeDefined();
    // 件数そのものは出す（数えられた分は数えられている）。
    expect(dropped).toMatchObject({ count: 2 });
    // **本題**: 覆えていないので `'exact'` とは名乗らない。
    expect(dropped).toMatchObject({ countKind: "unknown" });
  });

  it("⚠ 鳴ってはいけない側: 単位が候補を網羅していれば 'exact' のまま", async () => {
    // 対向関係を持たない普通の候補だけ。単位は1候補1つずつになり、必ず網羅する。
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "A".repeat(30) });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "B".repeat(30) });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryChars: 1 },
    });
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 2,
      countKind: "exact",
    });
  });
});

describe("recall() — omitted.kind = 'score_not_comparable'（ADR 0044）", () => {
  // 段2の閾値比較がどちらにも決まらなかった候補が、`omitted` に出ること。
  //
  // **⚠ NaN を作る経路の選び方**: ゼロベクトル（`similarity = NaN`）は本命の経路だが、
  // `FakeVectorStore` はゼロベクトルに 1 を返すのでここでは作れない
  // （そちらは `packages/postgres` 側の歯で本物の pgvector に対して測る）。
  // ここでは `halfLifeHours = 0` かつ経過時間ちょうど 0 を使う——
  // `0.5 ** (0 / 0)` が `NaN` になる（実測: +1ms なら 0、−1ms なら +Infinity）。
  // この歯の時計は `NOW` に固定してあり、`recordedAt` も `NOW` なので経過時間は厳密に 0。

  it("比較が決まらない候補は score_not_comparable に出る（件数と countKind つき）", async () => {
    const { runtime, stores } = buildRuntime();
    // ⚠ 件数を 1 対 2 と違える。同数だと取り違えが観測できない。
    await createEmbeddedMemory(stores, [1, 0], { digest: "壊れた", halfLifeHours: 0 });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "正常2" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain("正常1");
    expect(digests).toContain("正常2");
    expect(digests).not.toContain("壊れた");

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("🔴 三分割は網羅である: scored = passed + below_threshold + score_not_comparable", async () => {
    // これが本 PR の不変条件である。**直す前は偽だったので書けなかった。**
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "壊れた", halfLifeHours: 0 });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, scoreThreshold: 0 });
    const rescore = result.explain.stages.find((st) => st.stage === "rescore");
    const detail = rescore?.detail as
      { scored: number; passedThreshold: number; notComparable: number } | undefined;
    const below = result.omitted.find((o) => o.kind === "below_threshold")?.count ?? 0;
    const notComparable = result.omitted.find((o) => o.kind === "score_not_comparable")?.count ?? 0;

    expect(detail?.scored).toBe(2);
    expect(detail?.notComparable).toBe(notComparable);
    expect(detail!.passedThreshold + below + notComparable).toBe(detail!.scored);
  });

  it("⭐ ゼロベクトルの記憶が混ざると score_not_comparable が出る（ADR 0040 と繋がる端）", async () => {
    // **これが端から端まで繋がる唯一の場所である。**
    //
    // [ADR 0040](../../../../docs/decisions/0040-zero-vector-never-returned.md) は
    // 「ゼロベクトルが絡む候補は recall() の結果に出ない」を契約にし、
    // `FakeVectorStore` もゼロベクトルに `NaN` を返すようになった（ADR 0042 の PR で追随）。
    // **⟹ Fake が NaN を作り、本 PR の三分割がそれを omitted に出す。**
    // その組み合わせをここで一度だけ通しで測る。
    //
    // ⚠ 上の歯が `halfLifeHours = 0` で NaN を作っているのは、
    // **本物の pgvector と同じ経路ではないから**である（Fake が NaN を返すようになる前に書いた）。
    // どちらも残す——**NaN の作られ方が2通りあることを、歯の側でも示しておく。**
    const { runtime, stores } = buildRuntime();
    // ⚠ 件数を 1 対 2 と違える。
    await createEmbeddedMemory(stores, [0, 0], { digest: "ゼロベクトル" });
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "正常2" });

    // ⚠ scoreThreshold: 0 で測る。既定の 0.1 では、Fake が 1 を返していた頃でも
    // 「返らない」ところまでは同じだったので差が観測できない。
    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10, scoreThreshold: 0 });
    const digests = result.memories.map((m) => m.digest);
    expect(digests).toContain("正常1");
    expect(digests).toContain("正常2");
    expect(digests).not.toContain("ゼロベクトル");

    expect(result.omitted).toContainEqual({
      kind: "score_not_comparable",
      count: 1,
      countKind: "exact",
    });
  });

  it("⚠ 鳴ってはいけない側: 正常な候補だけなら score_not_comparable は出ない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "正常1" });
    await createEmbeddedMemory(stores, [0.5, 0.5], { digest: "正常2" });

    // 既定の閾値と 0 の両方で鳴らないことを見る（差が出るのは 0 側なので、両方要る）。
    for (const scoreThreshold of [undefined, 0]) {
      const result = await runtime.recall(ctx, {
        vector: [1, 0],
        limit: 10,
        ...(scoreThreshold === undefined ? {} : { scoreThreshold }),
      });
      expect(result.omitted.some((o) => o.kind === "score_not_comparable")).toBe(false);
    }
  });
});

describe("recall() — provenanceKind（roadmap.md §5.5 のオーナー回答の条件）", () => {
  // オーナーの回答は条件付きだった——「既定の recall に含める。**ただし provenance.kind で
  // 区別して返す**」。前半（既定で含める）は元から満たされていたが、後半は
  // `RecalledMemory` が provenance を一切持たないため満たされていなかった。
  //
  // ⚠ ここでの fixture は **kind をすべて違える**。同じ kind を並べると、
  // 「その Memory の kind」ではなく「どれか1つの kind」を全件に配ってしまう実装を
  // この検査が通してしまう。newMemory() の既定は 'imported' なので、
  // 'stated' / 'inferred' はどちらも既定と異なる。

  it("ANN 経由の候補は、その Memory 自身の provenance.kind を名乗る（候補ごとに違う値になる）", async () => {
    const { runtime, stores } = buildRuntime();
    const stated = await createEmbeddedMemory(stores, [1, 0], {
      digest: "stated の記憶",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });
    const inferred = await createEmbeddedMemory(stores, [0.99, 0.01], {
      digest: "inferred の記憶",
      provenance: {
        kind: "inferred",
        model: "gpt-4o-mini",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: ["obs-1"] },
        confidence: 0.7,
      },
    });
    const imported = await createEmbeddedMemory(stores, [0.98, 0.02], {
      digest: "imported の記憶",
    });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const kindById = new Map(result.memories.map((m) => [m.memoryId, m.provenanceKind]));
    expect(kindById.get(stated.id)).toBe("stated");
    expect(kindById.get(inferred.id)).toBe("inferred");
    expect(kindById.get(imported.id)).toBe("imported");
  });

  it("同伴取得（mandatory_companion）でも、対向の Memory 自身の kind を名乗る", async () => {
    // 同伴側は ANN を通らず getMany で拾われる別経路である。
    // ここを別に見ないと、「ANN 経由だけ正しく、同伴側は主の kind を配る」実装が通る。
    const { runtime, stores } = buildRuntime();
    const companion = await stores.memoryStore.createMemory(
      ctx,
      newMemory({
        status: "contested",
        digest: "B".repeat(20),
        provenance: {
          kind: "inferred",
          model: "gpt-4o-mini",
          promptVersion: "v1",
          basis: { memoryIds: [], observationIds: ["obs-1"] },
          confidence: 0.4,
        },
      }),
    );
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "A".repeat(5),
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    expect(returnedCompanion?.provenanceKind).toBe("inferred");
    expect(returnedOwner?.provenanceKind).toBe("stated");
  });

  it("usage は provenanceKind を数に入れない（測るのは digest と目次帯だけ）", async () => {
    // 北極星の物差しは「毎回プロンプトへ積む量」である。provenanceKind は
    // score/retrievedVia/companionOf と同じ**付加情報**であり、digest tier には入らない。
    // ⟹ 欄が1つ増えても usage.chars は動かない、という不変条件をここで押さえる。
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      digest: "digest-1",
      provenance: { kind: "stated", sourceObservationId: "obs-1", at: NOW.toISOString() },
    });
    await createEmbeddedMemory(stores, [0.99, 0.01], { digest: "digest-22" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 10 });
    const digestChars = result.memories.reduce((sum, m) => sum + m.digest.length, 0);
    expect(result.memories).toHaveLength(2);
    expect(result.usage.byTier.digest).toBe(digestChars);
    expect(result.usage.chars).toBe(digestChars + result.usage.indexChars);
  });
});

describe("recall() — 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §8）", () => {
  async function setupContestedPair(stores: ReturnType<typeof createFakeRuntimeStores>) {
    // b を先に作り、a から b を指す(一対一の対向関係。docs/memory-model.md §5)。
    // このテストが必要とするのは a.contestedWithId -> b の一方向だけ
    // (段3の実装は「候補として見つかった側」から対向を辿るため)。
    const b = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "contested", digest: "B".repeat(20) }),
    );
    const a = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: b.id,
      digest: "A".repeat(5),
    });
    return { a, b };
  }

  it("contested な Memory が候補に入ると、対向する Memory がスコアに関係なく同伴取得される", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);

    const companion = result.memories.find((m) => m.memoryId === b.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");
    expect(companion?.companionOf).toBe(a.id);
  });

  it("同伴取得された Memory は提示順で必ず隣接する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    // 無関係な候補をもう1件混ぜて、隣接性が並び替えで崩れないことを確認する。
    await createEmbeddedMemory(stores, [0.9, 0.1], { digest: "C" });

    const result = await runtime.recall(ctx, { vector: [1, 0], limit: 5 });
    const ids = result.memories.map((m) => m.memoryId);
    const indexA = ids.indexOf(a.id);
    const indexB = ids.indexOf(b.id);
    expect(Math.abs(indexA - indexB)).toBe(1);
  });

  it("予算に両方載らない場合、ペアごと落とす（片方だけを残さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    // maxMemoryChars は a.digest（5文字）だけなら収まるが、a+b（5+20=25文字）は収まらない大きさにする。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 10 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(result.omitted).toContainEqual({ kind: "budget_dropped", count: 2, countKind: "exact" });
  });

  it("予算が十分ならペアは両方とも残る", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupContestedPair(stores);
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 100 },
    });
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
  });
});

describe("recall() — 段4: トークン予算による切り詰め（Issue #108。maxMemoryChars 以外の経路に歯が無かった）", () => {
  /**
   * `maxMemoryTokens` / `promptBudgetTokens` を実際に行使する経路
   * （`recall-runtime.ts` の `effectiveTokenBudget` / `unitTokens` / 段4）には、
   * このテストを書く前はリポジトリ全体で歯が0本だった——既存の予算の歯は全部
   * `maxMemoryChars` を使っている。Issue #108（既定 `TokenCounter` が日本語を
   * 過小評価し、`maxMemoryTokens` の判定が静かに緩む）が壊れると言っている当の経路に
   * 歯が無かった、という穴をここで塞ぐ。
   *
   * 3件の日本語 digest を用意し、ベクトルの向きで優先順位（rankScore の大小）を
   * 明示的に制御する——`units.sort((a,b) => b.rankScore - a.rankScore)` が
   * どちらを先に残すかは、テストが安定して同じ結果を出すために自分で決めておく必要がある。
   * digest はどれも "あ" x10（CJK のみ）= `heuristicTokenCounter` で 9 トークン
   * （ceil(10 * 18 / 20) = ceil(9) = 9）。3件合計 27 トークンは
   * `maxMemoryTokens: 20` に収まらないので、スコアの高い2件（18トークン）だけが残り、
   * 3件目（9トークン）が `budget_dropped` に回るはずである。
   */
  it("maxMemoryTokens は既定カウンタで数えた digest 合計を上限内に切り詰める", async () => {
    const { runtime, stores } = buildRuntime();
    const digest = "あ".repeat(10);
    expect(heuristicTokenCounter.count(digest).tokens).toBe(9);

    const top = await createEmbeddedMemory(stores, [1, 0], { digest });
    const middle = await createEmbeddedMemory(stores, [0.99, 0.14], { digest });
    const bottom = await createEmbeddedMemory(stores, [0.9, 0.44], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 20 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    expect(returnedIds).toEqual([top.id, middle.id]);
    expect(returnedIds).not.toContain(bottom.id);

    const returnedTokenSum = result.memories.reduce(
      (sum, m) => sum + heuristicTokenCounter.count(m.digest).tokens,
      0,
    );
    expect(returnedTokenSum).toBeLessThanOrEqual(20);
    expect(returnedTokenSum).toBe(18);

    // 予算に入りきらなかった分は budget_dropped として出る（黙って消えない）。
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });

  /**
   * `effectiveTokenBudget` は `maxMemoryTokens` と `promptBudgetTokens` のうち
   * **小さいほう**を採る（`recall-runtime.ts` のコメント「最も厳しい(小さい)ものを1本にまとめる」）。
   * `maxMemoryTokens` だけなら2件とも残る大きさ（100）にしておき、
   * `promptBudgetTokens: 10` を同時に渡す——1件なら9トークンで収まるが2件では18トークンに
   * なり10を超えるので、`promptBudgetTokens` のほうが効いて1件しか残らないはずである。
   * これが緩いほう（100）を採っていたら2件とも残ってしまうので、区別できる歯になっている。
   */
  it("promptBudgetTokens は maxMemoryTokens より小さいほうが優先される", async () => {
    const { runtime, stores } = buildRuntime();
    const digest = "あ".repeat(10); // 9トークン/件
    const top = await createEmbeddedMemory(stores, [1, 0], { digest });
    const second = await createEmbeddedMemory(stores, [0.99, 0.14], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 10,
      budget: { maxMemoryTokens: 100, promptBudgetTokens: 10 },
    });

    const returnedIds = result.memories.map((m) => m.memoryId);
    expect(returnedIds).toEqual([top.id]);
    expect(returnedIds).not.toContain(second.id);
    expect(result.omitted).toContainEqual({
      kind: "budget_dropped",
      count: 1,
      countKind: "exact",
    });
  });
});

describe("recall() — 被覆不変条件（docs/recall.md §5）", () => {
  it("groups の総和は totalInScope と一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-1" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "user-2" }));
    await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: null }));
    await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));

    const result = await runtime.recall(ctx, {});
    const sumOfGroups = result.index.groups.reduce((sum, g) => sum + g.count, 0);
    expect(sumOfGroups).toBe(result.index.totalInScope);
    expect(result.index.totalInScope).toBe(4);
  });
});

describe("recall() — digestBand（目次帯。docs/recall.md §5、本 PR）", () => {
  it("『返さなかったもの』だけが帯に載る。memories に返ったものは帯に含まれない", async () => {
    const { runtime, stores } = buildRuntime();
    const returned = await createEmbeddedMemory(stores, [1, 0]);
    const notReturned1 = await stores.memoryStore.createMemory(ctx, newMemory());
    const notReturned2 = await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.recall(ctx, { vector: [1, 0] });

    expect(result.memories.map((m) => m.memoryId)).toEqual([returned.id]);
    const bandIds = (result.index.digestBand ?? []).map((e) => e.memoryId);
    expect(bandIds).not.toContain(returned.id);
    expect(bandIds.sort()).toEqual([notReturned1.id, notReturned2.id].sort());
  });

  it("digestBandCoverage.shown は digestBand.length と一致する", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.memoryStore.createMemory(ctx, newMemory());
    await stores.memoryStore.createMemory(ctx, newMemory());

    const result = await runtime.recall(ctx, {});
    expect(result.index.digestBandCoverage).toBeDefined();
    expect(result.index.digestBandCoverage?.shown).toBe((result.index.digestBand ?? []).length);
  });

  it("スコープ内が全部 memories に返っているとき（eligible=0）、帯は空で limitedBy は付かない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.index.digestBand).toEqual([]);
    expect(result.index.digestBandCoverage).toEqual({
      shown: 0,
      eligible: 0,
      countKind: "exact",
      // limitedBy は省略される（どの上限にも当たらなかった）。
    });
  });

  it("digestBandLimit を小さく渡すと limitedBy === 'entry_limit' になる", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 2 });
    expect(result.index.digestBand).toHaveLength(2);
    expect(result.index.digestBandCoverage?.eligible).toBe(5);
    expect(result.index.digestBandCoverage?.limitedBy).toBe("entry_limit");
  });

  /**
   * 変異試験で見つかった穴を埋める歯（本 PR）。
   *
   * `shown <= eligible` は「帯に載せた件数が、載せる資格のあった件数を超えない」という
   * 被覆の基本条件である。変異試験の時点では、この条件を破る変異（`eligible` を `shown` で
   * 上書きする／store が `digestEligible` を実際より小さく申告する）を捕まえていたのが
   * 上の `entry_limit` の歯の `eligible` の主張1行だけだった——**その1行が書き換われば
   * 2つの変異が同時に素通りする。**条件そのものを主張する歯をここに独立して置く。
   *
   * `digestBandLimit` に巨大な値を渡すのは、**上限を緩めても資格件数を超えないこと**を
   * 見るためである（`packDigestBand` の同名の歯は純関数の層で同じ条件を見ているが、
   * store から段5までを通した経路ではここが唯一の歯になる）。
   */
  it("digestBandLimit に巨大な値を渡しても shown は eligible を超えない", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 10_000 });
    const coverage = result.index.digestBandCoverage;
    expect(coverage).toBeDefined();
    expect(coverage!.eligible).toBe(5);
    expect(coverage!.shown).toBeLessThanOrEqual(coverage!.eligible);
    expect(coverage!.shown).toBe(5);
    // 上限に当たっていないので limitedBy は付かない。
    expect(coverage!.limitedBy).toBeUndefined();
  });

  /**
   * 上と対になる歯（本 PR、変異試験で見つかった穴を埋めるもの）。
   *
   * 上の歯は「上限を緩めたとき `shown` が `eligible` を超えない」を見るが、そこでは
   * 切り詰めが起きないため `eligible === shown` であり、**`eligible` を `shown` で
   * 上書きしてしまう壊れ方は素通りする**（実際に変異で確かめた）。
   * **切り詰めが起きている状態で `eligible` が `shown` より大きいこと**を、ここで独立に主張する。
   * これが無いと「切ったのに、切っていない顔で報告する」が歯をすり抜ける——
   * それは docs/recall.md §4 / ADR 0008 の「推定値を実測値の顔で出さない」の、この欄での破れである。
   */
  it("上限で切られたとき、eligible は shown より大きい（切ったことを隠さない）", async () => {
    const { runtime, stores } = buildRuntime();
    for (let i = 0; i < 5; i++) {
      await stores.memoryStore.createMemory(ctx, newMemory());
    }

    const result = await runtime.recall(ctx, { digestBandLimit: 2 });
    const coverage = result.index.digestBandCoverage;
    expect(coverage).toBeDefined();
    expect(coverage!.limitedBy).toBeDefined();
    expect(coverage!.eligible).toBeGreaterThan(coverage!.shown);
  });
});

describe("recall() — explain.stages（roadmap.md 段階5）", () => {
  it("happy path ではすべての段が executed:true になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const byStage = new Map(result.explain.stages.map((s) => [s.stage, s.executed]));
    expect(byStage.get("scope")).toBe(true);
    expect(byStage.get("candidate_generation")).toBe(true);
    expect(byStage.get("rescore")).toBe(true);
    expect(byStage.get("contradiction_resolution")).toBe(true);
    expect(byStage.get("budget_truncation")).toBe(true);
    expect(byStage.get("index_band")).toBe(true);
    expect(byStage.get("record")).toBe(true);
  });
});

describe("recall() — 段6: 記録（必須の段。ADR 0008）", () => {
  it("recallId が発行され、observe({kind:'memory_usage'}) から参照できる", async () => {
    const { runtime, stores } = buildRuntime();
    const memory = await createEmbeddedMemory(stores, [1, 0]);

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.recallId).toBeTruthy();

    const usageResult = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: result.recallId,
      usedMemoryIds: [memory.id],
    });
    expect(usageResult.memoryIds).toEqual([memory.id]);
  });
});

describe("recall() — usage（docs/recall.md §6: 計測と強制を混同しない）", () => {
  it("budget を渡さない場合は usage.share が無く、切り詰めも起きない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.usage.share).toBeUndefined();
    expect(result.usage.counter).toBe("heuristic");
  });

  it("budget を渡すと usage.share が「予算の対象（memories tier）が予算のどれだけを使ったか」になる", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: { maxMemoryChars: 1000 } });
    expect(result.usage.share).toBeDefined();
    // 分子は memories tier だけ = chars から目次帯を除いた分。
    // （以前は chars 全体を分子にしていたため、目次帯のぶんだけ share が水増しされていた。）
    expect(result.usage.share).toBeCloseTo(
      (result.usage.chars - result.usage.indexChars) / 1000,
      10,
    );
    expect(result.usage.indexChars).toBeGreaterThan(0);
  });

  /**
   * ⭐ 目次帯が budget の対象外であることと、share が割合として成立することの歯。
   *
   * 目次帯を budget の対象にしない理由は ADR 0008 の芯にある——「0件でも何が在るかは言える」
   * という目次帯の唯一の存在理由が、呼び出し側の渡した数字ひとつで消えてはならない。
   * その帰結として、**目次帯より小さい budget を渡しても目次帯は削られない**。
   *
   * このとき share の分子に目次帯を含めていると 1 を超える（実際に 248% が観測されていた）。
   * 「予算の何割を使ったか」と「全体でいくらかかったか」は別の問いであり、
   * 1つの数で両方に答えようとするとどちらかが嘘になる。
   */
  it("目次帯より小さい budget でも、目次帯は削られず、share は 1 を超えない", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: { maxMemoryChars: 1 } });

    // 目次帯は予算の外なので、予算が 1 文字でも残っている。
    expect(result.usage.indexChars).toBeGreaterThan(1);
    // 全量は予算を超える（目次帯のぶん）——これは仕様どおりであり、隠さない。
    expect(result.usage.chars).toBeGreaterThan(1);
    // だが share は「予算の対象がどれだけ使ったか」なので 1 を超えない。
    expect(result.usage.share).toBeLessThanOrEqual(1);
  });
});

/**
 * `usage.budgetExceeded`（Issue #108「案3」、PR #114/ADR 0083 が意図的に切り出した残件）。
 *
 * 3状態を区別する: 予算が1次元も申告されていない ⟹ 欄が無い（undefined）。
 * 申告されていて超えていない ⟹ false。申告されていて超えた ⟹ true。
 * 存在条件は `usage.share` と同じ（`recall-runtime.ts` の `usageShareDenominator`）。
 *
 * **`share` からは導出しない**——強制側（段4の `fits`/`unitTokens`）は digest ごとに
 * `tokenCounter.count()` を呼ぶため `Math.ceil` が件数ぶん掛かるのに対し、`share` の分子は
 * 連結した1本に対して `ceil` を1回だけ行う。両者は加法的に一致しない
 * （このファイル内の「非CJK20字×2件」の歯が、その不一致を実測で示す）。
 */
describe("recall() — usage.budgetExceeded（Issue #108「案3」）", () => {
  it("budget を渡さない場合は budgetExceeded が無い（欄そのものが存在しない）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.usage.budgetExceeded).toBeUndefined();
    // 存在条件が share と一致することの歯——`share` も無いはず。
    expect(result.usage.share).toBeUndefined();
  });

  it("budget: {}（予算次元が1つも無い）でも budgetExceeded は無い（share と存在条件が一致する）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0]);
    const result = await runtime.recall(ctx, { vector: [1, 0], budget: {} });
    expect(result.usage.budgetExceeded).toBeUndefined();
    expect(result.usage.share).toBeUndefined();
  });

  it("予算内に収まっていれば budgetExceeded は false（undefined ではなく明示的に false）", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "short" });
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 10_000, maxMemoryTokens: 10_000, promptBudgetTokens: 10_000 },
    });
    expect(result.usage.budgetExceeded).toBe(false);
  });

  /**
   * 🔴🔴 実際に true になる入力（ADR 0083 / PR #114 が挙げている再現をここで作る）。
   *
   * 非CJK 20文字の digest を2件（各 `heuristicTokenCounter` で5トークン）用意し、
   * `maxMemoryTokens: 10` を渡す。まず前提の数値そのものを自分で確かめる
   * （書き写さない）: 段4の強制（`fits`/`unitTokens`）は digest ごとに ceil してから
   * 合算するので `5+5=10 <= 10` となり両方残るが、実際に返した量（連結した41字）を
   * 測り直すと `ceil(41/4) = 11 > 10` で超えている。
   */
  it("非CJK20字×2件・maxMemoryTokens:10 ⟹ 強制側は両方残すが、連結して測り直すと超えている", async () => {
    const digestA = "01234567890123456789"; // 20 chars, 全て非CJK
    const digestB = "abcdefghijklmnopqrst"; // 20 chars, 全て非CJK
    expect(digestA).toHaveLength(20);
    expect(digestB).toHaveLength(20);

    // 前提1: 1件あたりのトークン数（段4の `unitTokens` と同じ計算: digest ごとに count()）。
    expect(heuristicTokenCounter.count(digestA).tokens).toBe(5);
    expect(heuristicTokenCounter.count(digestB).tokens).toBe(5);
    expect(
      heuristicTokenCounter.count(digestA).tokens + heuristicTokenCounter.count(digestB).tokens,
    ).toBe(10);
    // 前提2: 連結して測った場合（usage の `memoryTokens` と同じ計算）。
    expect(heuristicTokenCounter.count(`${digestA}\n${digestB}`).tokens).toBe(11);

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 10 },
    });

    // 強制側は両方残す——budget_dropped は起きていない。この歯が「常に false を返す欄」
    // ではないことの証明であり、budget_dropped が起きた入力からの true では意味が無い。
    expect(result.memories).toHaveLength(2);
    expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);

    expect(result.usage.budgetExceeded).toBe(true);
  });

  // `promptBudgetTokens` 単独でも同じ再現が起きることを確かめる（`effectiveTokenBudget` は
  // `maxMemoryTokens` と `promptBudgetTokens` の最小値を1本にまとめて強制側へ渡すため、
  // enforcement 側の挙動は同一である）。この歯が無いと、`promptTokensExceeded` の項を
  // 判定から落とす変異が検出できない（他の歯はどれも `promptBudgetTokens` を使わない）。
  it("promptBudgetTokens 単独でも、maxMemoryTokens と同じ再現で budgetExceeded が true になる", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { promptBudgetTokens: 10 },
    });

    expect(result.memories).toHaveLength(2);
    expect(result.usage.budgetExceeded).toBe(true);
  });

  // 境界値（ちょうど予算どおり）では false のままである。`>` を `>=` に変える変異は
  // ここで初めて検出できる——ここまでの「実際に true になる」歯は測定値が予算を
  // 上回っているため、`>` でも `>=` でも同じ true を返してしまい、この変異を見抜けない。
  //
  // 単一の memory を使う（結合の "\n" が挟まらないため、連結して測っても
  // digest 単体の ceil と完全に一致し、この境界を厳密に作れる）。
  it("トークン予算にちょうど収まる境界値では budgetExceeded は false のまま（`>` と `>=` を区別する歯）", async () => {
    const digest = "01234567890123456789"; // 20 chars, non-CJK ⟹ ceil(20/4) = 5 トークン
    expect(heuristicTokenCounter.count(digest).tokens).toBe(5);

    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryTokens: 5 },
    });

    expect(result.memories).toHaveLength(1);
    expect(result.usage.budgetExceeded).toBe(false);
  });

  it("chars 予算とトークン予算を両方申告しても、chars 次元が判定から落ちない（トークン超過は検知され続ける）", async () => {
    const digestA = "01234567890123456789";
    const digestB = "abcdefghijklmnopqrst";
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: digestA });
    await createEmbeddedMemory(stores, [1, 0], { digest: digestB });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      // maxMemoryChars は十分大きく、chars 次元では超えない。
      // `share` の分母はトークン予算優先（`effectiveTokenBudget`）で maxMemoryChars を
      // 無視するようになるが、budgetExceeded はそれとは独立に両方の次元を見ている。
      budget: { maxMemoryChars: 10_000, maxMemoryTokens: 10 },
    });

    expect(result.usage.budgetExceeded).toBe(true);
    expect(result.usage.share).toBeDefined();
  });

  /**
   * `maxMemoryChars` は強制側（`unitChars`）と計測側（`digestChars`）が
   * 「digest.length の単純な合計」という同じ式であり、連結の区切り文字も複数回の ceil も
   * 無い。段4の `fits` は `maxMemoryChars` が申告されていれば必ずそれを満たしてから
   * 候補を確定するので、切り詰め後に `digestChars > maxMemoryChars` になることは構造上
   * 起こらない。**⟹ この経路では常に false のままである**（tokens の側と違って
   * true になる入力は原理的に作れない——この非対称自体が本 PR の発見であり、
   * PR 本文に明記する）。
   */
  it("maxMemoryChars のみの経路では budgetExceeded は false のままである", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], { digest: "0123456789" }); // 10 chars
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      budget: { maxMemoryChars: 5 },
    });
    // 予算に収まらないので候補ごと落ちる（budget_dropped）が、budgetExceeded は
    // 「予算内に収まっていない」ことを示す欄ではなく「返した量が超えている」ことを示す欄
    // ——落ちた結果 digestChars=0 になり、超えようがない。
    expect(result.usage.budgetExceeded).toBe(false);
  });
});

describe("recall() — D5: 既定で provenance.kind='inferred' を含める。除外オプション", () => {
  it("既定では inferred な Memory も返る", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      provenance: {
        kind: "inferred",
        model: "test-model",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.9,
      },
    });
    const result = await runtime.recall(ctx, { vector: [1, 0] });
    expect(result.memories).toHaveLength(1);
  });

  it("excludeProvenanceKinds: ['inferred'] を渡すと除外される", async () => {
    const { runtime, stores } = buildRuntime();
    await createEmbeddedMemory(stores, [1, 0], {
      provenance: {
        kind: "inferred",
        model: "test-model",
        promptVersion: "v1",
        basis: { memoryIds: [], observationIds: [] },
        confidence: 0.9,
      },
    });
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      excludeProvenanceKinds: ["inferred"],
    });
    expect(result.memories).toHaveLength(0);
  });
});

describe("recall() — status ゲート（段1と同じ status IN ('active','contested')）", () => {
  const excludedStatuses: MemoryStatus[] = ["superseded", "archived", "forgotten"];
  for (const status of excludedStatuses) {
    it(`status='${status}' の Memory は ANN 候補に現れない`, async () => {
      const { runtime, stores } = buildRuntime();
      await createEmbeddedMemory(stores, [1, 0], { status });
      const result = await runtime.recall(ctx, { vector: [1, 0] });
      expect(result.memories).toEqual([]);
    });
  }
});

describe("recall() — RecallQuerySchema による入力検証", () => {
  it("limit が非正の場合は zod のエラーで拒否する", async () => {
    const { runtime } = buildRuntime();
    await expect(runtime.recall(ctx, { limit: 0 })).rejects.toThrow();
  });

  it("excludeProvenanceKinds に未知の値を渡すと拒否する", async () => {
    const { runtime } = buildRuntime();
    await expect(
      // @ts-expect-error 意図的に不正な値を渡す
      runtime.recall(ctx, { excludeProvenanceKinds: ["fabricated"] }),
    ).rejects.toThrow();
  });
});
