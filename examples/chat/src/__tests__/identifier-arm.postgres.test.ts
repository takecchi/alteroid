import { afterAll, describe, expect, it } from "vitest";
import { formatIdentifierArmReport, runIdentifierProbeArm } from "../identifier-arm.js";
import { IDENTIFIER_PROBES } from "../identifier-probe-set.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `DeterministicLLMProvider.completeStructured` の digest 規則(先頭40字 + "…")を、
 * この歯の側で**独立に**再計算する(`deterministic-llm-provider.ts` からの import では
 * なく、期待値をここに逐語で書く——実装と同じ関数を呼ぶと、実装が壊れても期待値が
 * 一緒に壊れて自己整合してしまう)。
 */
function expectedDeterministicDigest(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * Issue #109: `identifier-arm.ts` の配線を、本物の Postgres + pgvector に対して
 * 実際に1回走らせる(`time-term.postgres.test.ts` と同じ構え)。
 *
 * **provider は擬似(`deterministic`)に固定する。**この歯はネットワーク・モデル重み
 * 取得に依存しない「配線の正しさ」だけを見る——`@mnemora/local-embedding` を使った
 * **実際の想起の質**の実測は、`identifier-probes` サブコマンドを手で実行して測る
 * (このリポジトリの `live.local-embedding.test.ts` と同じ区別: 配線の歯は CI で必ず
 * 走り、本物の重みを使う実測は opt-in/手動である)。
 *
 * `DeterministicEmbeddingProvider` は意味的な類似度を持たないため、ここでの
 * goldRank/hit@1/hit@10 の値そのものには意味が無い(AGENTS.md
 * 「`deterministic` で測った想起の質は、性能について何も言っていない」)。
 * 見るのは**壊れずに12 probe 分の構造化された結果が返り、ingest した総数と
 * `totalInScope` が一致すること**である。
 */
describe("examples/chat: identifier-probe arm(擬似 provider・本物の Postgres)", () => {
  it("12 probe すべてで、クラッシュせずに構造化された結果を返す", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const haystackSize = 4;
      const report = await runIdentifierProbeArm({
        armLabel: "identifier-probe-test",
        tenantId: `identifier-probe-test-${Date.now()}`,
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        haystackSize,
      });

      // ⭐ 本命の成果物: 構造化された結果をそのまま報告に貼れる形で残す。
      console.log(formatIdentifierArmReport(report));

      expect(report.probes).toHaveLength(IDENTIFIER_PROBES.length);
      expect(report.probeCount).toBe(IDENTIFIER_PROBES.length);
      expect(report.ingest.observationCount).toBe(IDENTIFIER_PROBES.length * 2 + haystackSize);

      // `DeterministicLLMProvider` は冪等な再送を起こさない新規テナントなので、
      // observe() は必ず全件を新規 Observation にする——drain の合計処理数は
      // observationCount と一致するはずである(embed ジョブは utterance の件数だけ作られる)。
      expect(report.ingest.drain.totalProcessed).toBe(report.ingest.observationCount);
      expect(report.ingest.drain.totalFailed).toBe(0);

      expect(report.hit1Count).toBeGreaterThanOrEqual(0);
      expect(report.hit1Count).toBeLessThanOrEqual(report.probeCount);
      expect(report.hit10Count).toBeGreaterThanOrEqual(0);
      expect(report.hit10Count).toBeLessThanOrEqual(report.probeCount);
      expect(report.mrrOverall).toBeGreaterThanOrEqual(0);
      expect(report.mrrOverall).toBeLessThanOrEqual(1);

      for (const p of report.probes) {
        const probeDef = IDENTIFIER_PROBES.find((probe) => probe.id === p.probeId);
        expect(probeDef).toBeDefined();
        expect(p.hit1).toBe(p.goldRank === 1);
        expect(p.hit10).toBe(p.goldRank !== null);
        // gold/distractor は同じテナントに ingest した2件+haystack のスコープ内にいる。
        expect(p.totalInScope).toBe(report.ingest.observationCount);

        // ⭐ gold/distractor の取り違えを捕まえる独立した検査。
        //
        // `DeterministicLLMProvider` は digest を「発話本文の先頭40字」にする
        // (`deterministic-llm-provider.ts`)。`p.scoreDetails` は `recall()` が返した
        // 生の `digest` をそのまま運んでいる——`runIdentifierProbeArm` が内部で
        // gold/distractor の externalId を取り違えても、`p.goldRank`/`p.hit1` は
        // "取り違えた側” を基準に自己整合してしまい、上の `expect(p.hit1).toBe(...)` は
        // 検出できない。ここでは probe 定義(`probe.fact`/`probe.distractor`)から
        // 独立に期待 digest を計算し、"gold" と役付けされた候補の digest が本当に
        // `fact` 由来か(`distractor` 由来ではないか)を見る。
        const expectedGoldDigest = expectedDeterministicDigest(probeDef!.fact);
        const expectedDistractorDigest = expectedDeterministicDigest(probeDef!.distractor);
        const goldDetail = p.scoreDetails.find((d) => d.roles.includes("gold"));
        if (goldDetail) {
          expect(goldDetail.digest).toBe(expectedGoldDigest);
          expect(goldDetail.digest).not.toBe(expectedDistractorDigest);
        }
        const distractorDetail = p.scoreDetails.find((d) => d.roles.includes("distractor"));
        if (distractorDetail) {
          expect(distractorDetail.digest).toBe(expectedDistractorDigest);
          expect(distractorDetail.digest).not.toBe(expectedGoldDigest);
        }
      }

      expect(formatIdentifierArmReport(report)).toContain("identifier-probe arm");
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
