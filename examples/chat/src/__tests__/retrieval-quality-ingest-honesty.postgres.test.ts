import { afterAll, describe, expect, it } from "vitest";
import {
  buildArmTenantId,
  formatArmDetail,
  newRunToken,
  runRetrievalQualityArm,
} from "../retrieval-quality.js";
import type { ArmIngestSummary } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0068 の核心を、2回実行して測る歯(オーナーの明示指示——
 * 「1回目だけを測る歯では、この欠陥は一生捕まらない」)。
 *
 * **背景**: `cli.ts` の `runRetrieval` は arm の `tenantId` が固定だった。DB を
 * リセットしないため、2回目の実行は `observe()` の externalId 冪等性に当たって
 * 新規 observation を1件も作らず、`ingest.singleTickWouldHaveStalled` が
 * 「測っていない」のに `false`(＝1回で足りた)を返す——1回目とちょうど逆の結論。
 * 順位(goldRank 等)は DB に残った前回の記憶からそのまま正しく出るため、数字を見て
 * いても気付けない。
 *
 * `haystackSize` は既定(`DEFAULT_HAYSTACK_SIZE`=60)より小さいが、
 * `DEFAULT_TICK_LIMIT`(50、`packages/core/src/runtime.ts`)は必ず超える値にしてある
 * ——超えないと `singleTickWouldHaveStalled` の分岐そのものが死ぬ。
 */
const HAYSTACK_SIZE = 55;

async function runOnce(tenantId: string): Promise<ArmIngestSummary> {
  const handle = await createExampleRuntime(requireDatabaseUrl(), {
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "deterministic",
  });
  try {
    const report = await runRetrievalQualityArm({
      armLabel: "ingest-honesty-arm",
      tenantId,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackSize: HAYSTACK_SIZE,
    });
    return report.ingest;
  } finally {
    await handle.close();
  }
}

describe("retrieval-quality: ingest の結論は run を跨いで正直か（ADR 0068 ①）", () => {
  it(
    "①-1 通常利用の再現性: newRunToken() で毎回別テナントを使えば、2回目も1回目と " +
      "同じ ingest の結論になる（deep-equal）",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const armKey = "repro";
      const first = await runOnce(buildArmTenantId(armKey, newRunToken()));
      const second = await runOnce(buildArmTenantId(armKey, newRunToken()));

      expect(second).toEqual(first);
      // 両方とも実際に測っており、既定 tick() 1回では足りなかったはず
      // (haystackSize=55 は DEFAULT_TICK_LIMIT=50 を超える)。
      expect(first.measurement).toBe("measured");
      expect(second.measurement).toBe("measured");
      expect(first.singleTickWouldHaveStalled).toBe(true);
      expect(second.singleTickWouldHaveStalled).toBe(true);
    },
  );

  it(
    "①-2 同じテナントを使い回したとき: 2回目は「1回で足りた」と主張しない " +
      "（measurement=replayed、singleTickWouldHaveStalled=null）",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const tenantId = "retrieval-quality-test-ingest-honesty-fixed";
      const first = await runOnce(tenantId);
      expect(first.measurement).toBe("measured");
      expect(first.singleTickWouldHaveStalled).toBe(true);
      expect(first.extractionCounts).toEqual({
        ok: HAYSTACK_SIZE + 14, // gold 7 + distractor 7 + haystack
        skipped: 0,
        llmFailedWholeObservation: 0,
      });

      // 同じテナントで2回目——`observe()` は externalId の冪等性に当たり、
      // 新規 observation を1件も作らない。
      const second = await runOnce(tenantId);
      expect(second.measurement).toBe("replayed");
      // ⚠ ここが本 ADR の核心: 測っていないので `false`(足りた)ではなく、
      // 「測っていない」と言える値(`null`)でなければならない。
      expect(second.singleTickWouldHaveStalled).toBeNull();
      expect(second.extractionCounts).toEqual({
        ok: 0,
        skipped: HAYSTACK_SIZE + 14,
        llmFailedWholeObservation: 0,
      });
    },
  );

  it(
    "①-3 表示層: formatArmDetail は、測っていない run で「1回で全件処理できる件数だった」" +
      "という趣旨の文字列を出さない",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const tenantId = "retrieval-quality-test-ingest-honesty-display";
      const firstReport = await runOnceReport(tenantId);
      const secondReport = await runOnceReport(tenantId);

      expect(secondReport.ingest.measurement).toBe("replayed");
      const out = formatArmDetail(secondReport);
      expect(out).not.toContain("この arm では既定の tick() 1回で全件処理できる件数だった");
      // 「測っていない」ことは、何らかの形で明示されていること。
      expect(out).toMatch(/測っていない/);

      // 対照: 1回目(実際に測った run)は、通常通りの判定文言を出す。
      const firstOut = formatArmDetail(firstReport);
      expect(firstOut).toContain("既定の tick() を1回だけ呼ぶ実装だったら");
    },
  );
});

async function runOnceReport(tenantId: string) {
  const handle = await createExampleRuntime(requireDatabaseUrl(), {
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "deterministic",
  });
  try {
    return await runRetrievalQualityArm({
      armLabel: "ingest-honesty-display-arm",
      tenantId,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackSize: HAYSTACK_SIZE,
    });
  } finally {
    await handle.close();
  }
}

afterAll(async () => {
  await closeTestClient();
});
