import type { Ctx, EmbeddingProvider, Memory, MemoryStore, Runtime } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import {
  buildConsolidationCostRunJson,
  buildConsolidationMeanJson,
  buildConsolidationProbeJson,
  buildConsolidationStoreJson,
  describeThrownError,
  emptyOutcomeCounts,
} from "./consolidation-json.js";
import type {
  ConsolidationAbortJson,
  ConsolidationCostRunJson,
  ConsolidationEmbeddingSpaceJson,
  ConsolidationOutcomeCountsJson,
  ConsolidationRecallBudgetRungJson,
  ConsolidationRecallProbeJson,
  ConsolidationRecallUnbudgetedJson,
  ConsolidationRoundConsolidationJson,
  ConsolidationRoundJson,
  ConsolidationStopReason,
  RawProbeMeasurement,
} from "./consolidation-json.js";
import { splitIntoConsolidationGroups } from "./consolidation-group.js";
import { drainEmbedTicks } from "./embed-drain.js";
import { lookupLatestEmbedFailureKind } from "./embed-failure-kind.js";
import {
  DEFAULT_HAYSTACK_SIZE,
  PROBES,
  buildProbeSetConversation,
  goldExternalId,
} from "./probe-set.js";
import type { ProbeUtterance } from "./probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";

/**
 * `consolidation-cost` サブコマンド(Issue #136)——「`Runtime.consolidate()` を実際に
 * 使うと、載せる量は縮むのか」を実測するベンチの、DB/LLM/embedding を要求する側。
 *
 * **測る手順(仕様書の「測る手順(ラウンド制)」節そのもの)**:
 * 1. `probe-set.ts` の発話列を `observe()` で ingest し、embed を drain する。
 * 2. round 0(統合前)を計測する。
 * 3. round 1..3: gold/distractor を除いた active な filler を id の安定した順に
 *    `groupSize` 件ずつの群へ分け、群ごとに `runtime.consolidate()` を呼ぶ。
 *    round 2 以降は前回の統合結果も対象に含める(候補プールを引き継ぐ)。
 * 4. 1つの round の開始時点で候補が2件未満なら、そこで打ち切る。
 *
 * JSON の組み立て(型・平均・株分けの純関数)は `./consolidation-json.js` に委ねる——
 * ここは「何を読むか」「いつ呼ぶか」だけを持つ。
 */

const MAX_ROUNDS = 3;

export interface RunConsolidationCostOptions {
  runtime: Runtime;
  memoryStore: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  pool: PostgresClient["pool"];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  tenantId: string;
  groupSize: number;
  budgetLadder: readonly number[];
  recallLimit: number;
  measuredAt: Date;
  commit: string | null;
  /** 既定は `DEFAULT_HAYSTACK_SIZE`(`probe-set.ts`、既存 `retrieval` と同じ既定)。 */
  haystackSize?: number;
}

interface StoreSnapshot {
  activeIds: string[];
  json: ConsolidationRoundJson["store"];
}

export async function measureStore(
  memoryStore: MemoryStore,
  ctx: Ctx,
  allIds: readonly string[],
): Promise<StoreSnapshot> {
  const memories = await memoryStore.getMany(ctx, [...allIds]);
  const byStatus = new Map<string, Memory[]>();
  for (const memory of memories) {
    const bucket = byStatus.get(memory.status) ?? [];
    bucket.push(memory);
    byStatus.set(memory.status, bucket);
  }
  const active = byStatus.get("active") ?? [];
  const superseded = byStatus.get("superseded") ?? [];
  // ⚠ この bench は `forget`/`archive`/`contest` を一切呼ばないので、active/superseded
  // 以外の status を持つ Memory はここに現れない想定である。現れた場合は
  // `allContentChars` の合計にだけ含め(隠さない)、`activeCount`/`supersededCount` の
  // 内訳には計上しない——この bench の範囲外の状態だからである。
  const allContentChars = memories.reduce((sum, m) => sum + m.content.length, 0);
  return {
    activeIds: active.map((m) => m.id),
    json: buildConsolidationStoreJson({
      activeContentsAndDigests: active.map((m) => ({ content: m.content, digest: m.digest })),
      supersededCount: superseded.length,
      allContentChars,
    }),
  };
}

interface RecallMeasurement {
  unbudgeted: ConsolidationRecallUnbudgetedJson;
  budgeted: ConsolidationRecallBudgetRungJson[];
}

async function measureProbe(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  probeId: string,
  query: string,
  budget: { maxMemoryTokens: number } | undefined,
  limit: number | undefined,
): Promise<RawProbeMeasurement> {
  const result = await runtime.recall(
    ctx,
    budget !== undefined ? { text: query, limit, budget } : { text: query },
  );
  const resolvedExternalIds = await Promise.all(
    result.memories.map((m) => resolveExternalId(memoryStore, ctx, m.memoryId)),
  );
  const goldIndex = resolvedExternalIds.indexOf(goldExternalId(probeId));
  const goldRank = goldIndex === -1 ? null : goldIndex + 1;
  return {
    probeId,
    memoryDigests: result.memories.map((m) => m.digest),
    goldRank,
    totalInScope: result.index.totalInScope,
    omittedKinds: result.omitted.map((o) => o.kind),
    usageChars: result.usage.chars,
    usageEstimatedTokens: result.usage.estimatedTokens,
    usageIndexChars: result.usage.indexChars,
    budgetExceeded: result.usage.budgetExceeded ?? false,
  };
}

export async function measureRecallForRound(
  runtime: Runtime,
  memoryStore: MemoryStore,
  ctx: Ctx,
  activeCount: number,
  budgetLadder: readonly number[],
  recallLimit: number,
): Promise<RecallMeasurement> {
  const unbudgetedRaw = await Promise.all(
    PROBES.map((probe) =>
      measureProbe(runtime, memoryStore, ctx, probe.id, probe.query, undefined, undefined),
    ),
  );
  const unbudgetedProbes: ConsolidationRecallProbeJson[] = unbudgetedRaw.map((raw) =>
    buildConsolidationProbeJson(raw, activeCount),
  );

  const budgeted: ConsolidationRecallBudgetRungJson[] = [];
  for (const budgetTokens of budgetLadder) {
    const rungRaw = await Promise.all(
      PROBES.map((probe) =>
        measureProbe(
          runtime,
          memoryStore,
          ctx,
          probe.id,
          probe.query,
          { maxMemoryTokens: budgetTokens },
          recallLimit,
        ),
      ),
    );
    const rungProbes = rungRaw.map((raw) => buildConsolidationProbeJson(raw, activeCount));
    budgeted.push({
      budgetTokens,
      probes: rungProbes,
      mean: buildConsolidationMeanJson(rungProbes),
    });
  }

  return {
    unbudgeted: { probes: unbudgetedProbes, mean: buildConsolidationMeanJson(unbudgetedProbes) },
    budgeted,
  };
}

function bucketEmbeddingStatus(status: Memory["embeddingStatus"]): "ok" | "pending" | "failed" {
  switch (status) {
    case "ready":
      return "ok";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "skipped":
      // この経路では実際には起きない(embed ジョブが "skipped" を書く分岐は
      // `packages/core` に無い——型にのみ存在する値)。観測されたら見失わないよう
      // failed 側へ丸めておく。
      return "failed";
    default: {
      const exhaustive: never = status;
      throw new Error(`bucketEmbeddingStatus: 未知の embeddingStatus: ${String(exhaustive)}`);
    }
  }
}

export async function measureNewMemoriesEmbedding(
  memoryStore: MemoryStore,
  pool: PostgresClient["pool"],
  ctx: Ctx,
  newMemoryIds: readonly string[],
): Promise<{
  embeddingStatus: { ok: number; pending: number; failed: number };
  embeddingFailureKinds: string[];
}> {
  const memories = await memoryStore.getMany(ctx, [...newMemoryIds]);
  const counts = { ok: 0, pending: 0, failed: 0 };
  const failureKinds = new Set<string>();
  for (const memory of memories) {
    const bucket = bucketEmbeddingStatus(memory.embeddingStatus);
    counts[bucket] += 1;
    if (bucket === "failed") {
      const kind = await lookupLatestEmbedFailureKind(pool, ctx.tenantId, memory.id);
      failureKinds.add(kind ?? "unknown");
    }
  }
  return { embeddingStatus: counts, embeddingFailureKinds: [...failureKinds].sort() };
}

/**
 * この関数は常に `status: "measured"` を返す(重み取得の失敗はこの関数に来る前、
 * `cli.ts` の `warmupLocalEmbedding` の段で打ち切られる——`ConsolidationCostRunJson` が
 * 持つ `status: "weights_unavailable"` はこの関数の外側の関心事)。
 */
export async function runConsolidationCost(
  options: RunConsolidationCostOptions,
): Promise<Extract<ConsolidationCostRunJson, { status: "measured" }>> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackSize = options.haystackSize ?? DEFAULT_HAYSTACK_SIZE;
  const utterances: ProbeUtterance[] = buildProbeSetConversation(haystackSize);

  const allIds: string[] = [];
  const fillerIds: string[] = [];
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
    allIds.push(...observed.memoryIds);
    if (utterance.kind === "haystack") {
      fillerIds.push(...observed.memoryIds);
    }
  }
  await drainEmbedTicks(options.runtime, ctx);

  const embeddingSpace: ConsolidationEmbeddingSpaceJson = { ...options.embeddingProvider.space };

  const rounds: ConsolidationRoundJson[] = [];

  const round0Store = await measureStore(options.memoryStore, ctx, allIds);
  const round0Recall = await measureRecallForRound(
    options.runtime,
    options.memoryStore,
    ctx,
    round0Store.json.activeCount,
    options.budgetLadder,
    options.recallLimit,
  );
  rounds.push({ round: 0, consolidation: null, store: round0Store.json, recall: round0Recall });

  let candidatePool = [...fillerIds];
  let stoppedAfterRound = 0;
  let stopReason: ConsolidationStopReason = "completed_all_rounds";
  let abort: ConsolidationAbortJson | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    if (candidatePool.length < 2) {
      stopReason = "insufficient_candidates";
      break;
    }

    // ⚠ この try は round の本体まるごとを囲む(群のループ・drainEmbedTicks・
    // measureNewMemoriesEmbedding・measureStore・measureRecallForRound)。全部 store を
    // 触るので、どの段で例外が起きても「測れた分を捨てて死ぬ」のではなく、
    // 完走した round までの結果を持って `aborted_on_error` で打ち切る
    // (`consolidate()` は ADR 0100 / PR #144 以降、失敗時に投げる)。
    // 関数全体を1つの try で囲まないのは、そうすると「どの round で死んだか」が
    // 分からなくなるため。
    try {
      const { groups, leftover } = splitIntoConsolidationGroups(candidatePool, options.groupSize);
      const outcomes: ConsolidationOutcomeCountsJson = emptyOutcomeCounts();
      let llmCalls = 0;
      const nextPool: string[] = [];
      const newMemoryIdsThisRound: string[] = [];

      for (const group of groups) {
        const result = await options.runtime.consolidate(ctx, {
          target: { memoryIds: group },
          reason: `consolidation-cost round ${round}`,
        });
        outcomes[result.outcome] += 1;
        llmCalls += result.llmCalls;
        if (result.outcome === "consolidated" && result.consolidatedMemoryId !== null) {
          nextPool.push(result.consolidatedMemoryId);
          newMemoryIdsThisRound.push(result.consolidatedMemoryId);
          allIds.push(result.consolidatedMemoryId);
        } else {
          // この bench では起きない想定だが(全対象は直前の round で active と確認した
          // filler/統合結果のみ)、起きた場合は対象を「未統合のまま」次の round へ持ち越す
          // ——黙って消さない。
          nextPool.push(...group);
        }
      }
      candidatePool = [...nextPool, ...leftover];

      await drainEmbedTicks(options.runtime, ctx);

      const embedding = await measureNewMemoriesEmbedding(
        options.memoryStore,
        options.pool,
        ctx,
        newMemoryIdsThisRound,
      );

      const store = await measureStore(options.memoryStore, ctx, allIds);
      const recall = await measureRecallForRound(
        options.runtime,
        options.memoryStore,
        ctx,
        store.json.activeCount,
        options.budgetLadder,
        options.recallLimit,
      );

      const consolidation: ConsolidationRoundConsolidationJson = {
        groups: groups.length,
        llmCalls,
        outcomes,
        newMemoryCount: newMemoryIdsThisRound.length,
        embeddingStatus: embedding.embeddingStatus,
        embeddingFailureKinds: embedding.embeddingFailureKinds,
      };

      rounds.push({ round, consolidation, store: store.json, recall });
      // ⚠ この行の直前で例外が起きた場合は実行されない——`stoppedAfterRound` は
      // 最後に完走した round のままになる(落ちた round は完走していない)。
      stoppedAfterRound = round;
    } catch (error) {
      abort = describeThrownError(error, round);
      stopReason = "aborted_on_error";
      break;
    }
  }

  return buildConsolidationCostRunJson({
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    embeddingSpace,
    probeCount: PROBES.length,
    haystackSize,
    groupSize: options.groupSize,
    budgetLadder: options.budgetLadder,
    recallLimit: options.recallLimit,
    stoppedAfterRound,
    stopReason,
    rounds,
    measuredAt: options.measuredAt,
    commit: options.commit,
    abort,
  });
}
