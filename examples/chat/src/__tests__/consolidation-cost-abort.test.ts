import type { EmbeddingProvider, Memory, MemoryStore, Runtime } from "@mnemora/core";
import type { PostgresClient } from "@mnemora/postgres";
import { describe, expect, it } from "vitest";
import { exitCodeForConsolidationCostRun } from "../consolidation-json.js";
import { formatConsolidationCostReport } from "../consolidation-cost-format.js";
import { runConsolidationCost } from "../consolidation-cost.js";

/**
 * `runConsolidationCost()` そのものに、round 2 で投げる runtime を注入する e2e の歯。
 *
 * **なぜこれが要るか**: `consolidation-json.test.ts` / `consolidation-cost-format.test.ts` の
 * 11本は、`describeThrownError()` / `exitCodeForConsolidationCostRun()` / 各 formatter という
 * *純関数*だけに当たっており、`runConsolidationCost()` 自身が持つ round の `for` ループの
 * **構造**(`try` がどこを囲むか・`catch` の中が `break` か `continue` か)は一切測っていない。
 * この歯は DB/LLM/embedding を実物で叩く代わりに `RunConsolidationCostOptions` の
 * `runtime`/`memoryStore`/`embeddingProvider`/`pool` を最小の偽物で埋め、
 * `runConsolidationCost()` を直接呼ぶ。
 *
 * 偽物が実装するのは、`consolidation-cost.ts` を読んで実際に呼ばれると確認した口だけ:
 * - `runtime.observe` — ingest 段で utterance 数(gold/distractor 14件 + haystack 4件)回。
 * - `runtime.tick` — `drainEmbedTicks` から。即時に `processed: 0` を返して1回で終える。
 * - `runtime.recall` — `measureRecallForRound` から probe 数(7) × round数回
 *   (`budgetLadder: []` にして unbudgeted のみに絞った)。`memories: []` を返すことで
 *   `resolveExternalId`(→ `memoryStore.get`/`getObservation`)が呼ばれない経路を選んでいる
 *   ——そのため `memoryStore` は `getMany` だけを実装する。
 * - `runtime.consolidate` — 群ごとに1回。`opts.reason`(`"consolidation-cost round N"`)から
 *   round番号を読み、round 1 は成功、round 2 は注入した例外を投げる。
 * - `memoryStore.getMany` — `measureStore`/`measureNewMemoriesEmbedding` から。全件を
 *   `status: "active"`・`embeddingStatus: "ready"` の偽 Memory として返す(→ "failed" 分岐が
 *   一度も起きないため `pool`/`lookupLatestEmbedFailureKind` は実際には呼ばれない——
 *   `pool` はダミーのまま渡す)。
 * - `embeddingProvider.space` — プロパティとして読まれるだけ(メソッド呼び出しではない)。
 */

const INJECTED_TOP_MESSAGE = "e2e-injected-pg-message-5t8w-top";
const INJECTED_MID_MESSAGE = "e2e-injected-pg-message-5t8w-mid";
const INJECTED_INNER_MESSAGE = "e2e-injected-pg-message-5t8w-inner";
const INJECTED_SQL_STATE = "23503";

function buildInjectedError(): Error {
  const inner = Object.assign(new Error(INJECTED_INNER_MESSAGE), { code: INJECTED_SQL_STATE });
  const mid = new Error(INJECTED_MID_MESSAGE, { cause: inner });
  const top = new Error(INJECTED_TOP_MESSAGE, { cause: mid });
  return top;
}

function fakeMemory(id: string): Memory {
  return {
    id,
    tenantId: "t",
    content: `content-${id}`,
    contentHash: `hash-${id}`,
    digest: `digest-${id}`,
    digestSource: "fallback",
    provenance: { kind: "stated" },
    status: "active",
    tags: [],
    recordedAt: new Date(0),
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: new Date(0),
    embeddingStatus: "ready",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as Memory;
}

function buildFakeRuntime(): Runtime {
  let nextObserveId = 0;
  let nextConsolidatedId = 0;

  const observe: Runtime["observe"] = async () => {
    nextObserveId += 1;
    return {
      observationId: `obs-${nextObserveId}`,
      memoryIds: [`mem-observe-${nextObserveId}`],
      extraction: "ok",
      extractionFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["observe"]>>;
  };

  const tick: Runtime["tick"] = async () =>
    ({ processed: 0, failed: 0, unsupported: [] }) as unknown as Awaited<
      ReturnType<Runtime["tick"]>
    >;

  const recall: Runtime["recall"] = async () =>
    ({
      recallId: "recall-1",
      memories: [],
      omitted: [],
      index: { groups: [], totalInScope: 0, countKind: "exact" },
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      explain: { stages: [] },
    }) as unknown as Awaited<ReturnType<Runtime["recall"]>>;

  const consolidate: Runtime["consolidate"] = async (_ctx, opts) => {
    const reason = opts.reason ?? "";
    const match = /round (\d+)/.exec(reason);
    const round = match ? Number(match[1]) : -1;
    if (round === 2) {
      throw buildInjectedError();
    }
    nextConsolidatedId += 1;
    return {
      outcome: "consolidated",
      atomicity: "store_supported",
      nothingReason: null,
      consolidatedMemoryId: `mem-consolidated-${nextConsolidatedId}`,
      sources: [],
      llmCalls: 1,
      llmFailure: null,
    } as unknown as Awaited<ReturnType<Runtime["consolidate"]>>;
  };

  return {
    observe,
    tick,
    recall,
    consolidate,
  } as unknown as Runtime;
}

function buildFakeMemoryStore(): MemoryStore {
  const getMany: MemoryStore["getMany"] = async (_ctx, ids) => ids.map((id) => fakeMemory(id));
  return { getMany } as unknown as MemoryStore;
}

function buildFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    space: { provider: "fake", model: "fake-model", dimensions: 4 },
  } as unknown as EmbeddingProvider;
}

describe("runConsolidationCost: round の途中の例外を受け止める(e2e、偽物注入)", () => {
  it("round 2 で例外を投げても、round 0・1 の結果を捨てず、exitCode/abort が正しい", async () => {
    const runtime = buildFakeRuntime();
    const memoryStore = buildFakeMemoryStore();
    const embeddingProvider = buildFakeEmbeddingProvider();
    const pool = {} as unknown as PostgresClient["pool"];

    const json = await runConsolidationCost({
      runtime,
      memoryStore,
      embeddingProvider,
      pool,
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      tenantId: "consolidation-cost-abort-e2e",
      groupSize: 2,
      budgetLadder: [],
      recallLimit: 10,
      measuredAt: new Date(0),
      commit: null,
      haystackSize: 4,
    });

    // 要求1: 終了コードが非0、stopReason が aborted_on_error。
    expect(exitCodeForConsolidationCostRun(json)).toBe(1);
    expect(json.stopReason).toBe("aborted_on_error");

    // 要求2: round < 2 の行は捨てられていない(json と format 出力の両方)。
    expect(json.rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(json.stoppedAfterRound).toBe(1);

    const report = formatConsolidationCostReport(json);
    expect(report).toContain("| 0 |");
    expect(report).toContain("| 1 |");

    // 要求3: 投げた例外の値(cause 連鎖・SQLSTATE・round)が残っている。
    expect(json.abort).not.toBeNull();
    expect(json.abort?.round).toBe(2);
    expect(json.abort?.sqlState).toBe(INJECTED_SQL_STATE);
    expect(json.abort?.causeChain).toContain(INJECTED_TOP_MESSAGE);
    expect(json.abort?.causeChain).toContain(INJECTED_MID_MESSAGE);
    expect(json.abort?.causeChain).toContain(INJECTED_INNER_MESSAGE);
  });
});
