import type { Ctx, MemoryStore, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { DrainResult } from "./embed-drain.js";
import {
  IDENTIFIER_PROBES,
  buildIdentifierProbeSetConversation,
  identifierDistractorExternalId,
  identifierGoldExternalId,
} from "./identifier-probe-set.js";
import type { IdentifierHaystackKind, IdentifierProbe } from "./identifier-probe-set.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import {
  collectScoreDetails,
  computeTermSpreads,
  formatScoreDetail,
  formatTermSpreads,
} from "./retrieval-quality.js";
import type { ProbeScoreDetail, TermSpread } from "./retrieval-quality.js";

/**
 * `./identifier-probe-set.js` の probe を測る arm(Issue #109)。
 *
 * **`./retrieval-quality.js` の `runRetrievalQualityArm` とほぼ同じ形**(gold/distractor
 * を1本の会話に ingest → probe ごとに `recall()` を1回投げて順位を測る)である。
 * probe set が別ファイルであるため、`./time-term-arm.js` が `./time-term-probe-set.js`
 * を別 arm として切り出した前例に倣い、こちらも独立した arm にする。
 *
 * **スコア内訳の記録・表示は使い回す**(`collectScoreDetails`/`computeTermSpreads`/
 * `formatScoreDetail`/`formatTermSpreads`——いずれも `retrieval-quality.ts` が公開する
 * 純関数で、probe の中身に依らない。`time-term-arm.ts` が同じ関数を re-export ではなく
 * 直接 import して使っているのと同じ流儀)。
 *
 * **ここでは MRR(全体)しか持たない**——`retrieval-quality.ts` の `lexicalControl`
 * (擬似 embedding でも引けるはずの対照群)に相当する区分をこの probe set は持たない
 * (`IdentifierProbe` に `lexicalControl` 相当の欄が無い。12件すべてが「識別子を
 * 含む問い」であり、対照群を分ける設計にしていない——12件という母数で対照群まで割ると
 * 1群あたりの件数がさらに小さくなり、何も主張できなくなるため)。
 */

export interface IdentifierProbeOutcome {
  probeId: string;
  category: IdentifierProbe["category"];
  /** `recall().memories` の中の gold の順位(1始まり)。居なければ null。 */
  goldRank: number | null;
  distractorRank: number | null;
  hit1: boolean;
  hit10: boolean;
  /** 同じ書式・違う識別子(distractor)が gold より上に来たか(Issue #106 の失敗そのもの)。 */
  distractorBeatsGold: boolean;
  reciprocalRank: number;
  omittedKinds: string[];
  totalInScope: number;
  scoreDetails: ProbeScoreDetail[];
  termSpreads: TermSpread[];
}

export interface IdentifierArmIngestSummary {
  observationCount: number;
  drain: DrainResult;
}

export interface IdentifierArmReport {
  armLabel: string;
  tenantId: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** どちらの haystack 条件で走ったか(マネージャー指示: 「条件が3つ(arm/空間/haystack)
   *  になったので、どれ1つ落とさない」)。`"sparse"` = 識別子を含まない既定 haystack、
   *  `"dense"` = probe と同じ書式ファミリーの識別子が密な haystack。 */
  haystackKind: IdentifierHaystackKind;
  ingest: IdentifierArmIngestSummary;
  probes: IdentifierProbeOutcome[];
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
}

export interface RunIdentifierProbeArmOptions {
  armLabel: string;
  /** **必ず、この run で初めて使うテナントを渡すこと。**`./retrieval-quality.js` の
   *  `newRunToken()`/`buildArmTenantId()` と同じ理由(ADR 0068)——固定文字列だと2回目の
   *  実行が externalId の冪等性に当たり、ingest の欄が「今回は測っていない」のに
   *  「1回で足りた」という逆の結論を印字する。この arm はその判定式(`IngestMeasurement`)
   *  までは持たない——**このオプションの docstring で「毎回新しいテナントを渡すこと」を
   *  呼び出し側の責務として明示することで代える**(判定式を複製すると、
   *  `retrieval-quality.ts` 側の定義と食い違ったときにどちらが正しいか分からなくなる)。
   */
  tenantId: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** `"sparse"`(既定)か `"dense"` か。`./identifier-probe-set.js` の
   *  `buildIdentifierProbeSetConversation` へそのまま渡す。 */
  haystackKind?: IdentifierHaystackKind;
  /** 既定は haystackKind に応じて `./identifier-probe-set.js` 側が決める
   *  (`DEFAULT_HAYSTACK_SIZE`/`DEFAULT_DENSE_HAYSTACK_SIZE`)。 */
  haystackSize?: number;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export async function runIdentifierProbeArm(
  options: RunIdentifierProbeArmOptions,
): Promise<IdentifierArmReport> {
  const ctx: Ctx = { tenantId: options.tenantId };
  const haystackKind = options.haystackKind ?? "sparse";
  const utterances = buildIdentifierProbeSetConversation(options.haystackSize, haystackKind);

  for (const utterance of utterances) {
    await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
    });
  }

  const drain = await drainEmbedTicks(options.runtime, ctx);

  const probes: IdentifierProbeOutcome[] = [];
  for (const probe of IDENTIFIER_PROBES) {
    // ⛔ `text` 以外を渡さない(既存 arm と同じ規律)——閾値・limit・overFetchFactor は
    // 一切変えない。
    const result = await options.runtime.recall(ctx, { text: probe.query });
    const resolvedExternalIds = await Promise.all(
      result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
    );
    const goldIndex = resolvedExternalIds.indexOf(identifierGoldExternalId(probe.id));
    const distractorIndex = resolvedExternalIds.indexOf(identifierDistractorExternalId(probe.id));
    const goldRank = goldIndex === -1 ? null : goldIndex + 1;
    const distractorRank = distractorIndex === -1 ? null : distractorIndex + 1;
    const distractorBeatsGold =
      distractorRank !== null && (goldRank === null || distractorRank < goldRank);

    probes.push({
      probeId: probe.id,
      category: probe.category,
      goldRank,
      distractorRank,
      hit1: goldRank === 1,
      hit10: goldRank !== null,
      distractorBeatsGold,
      reciprocalRank: goldRank !== null ? 1 / goldRank : 0,
      omittedKinds: result.omitted.map((o) => o.kind),
      totalInScope: result.index.totalInScope,
      scoreDetails: collectScoreDetails(result.memories, { goldRank, distractorRank }),
      termSpreads: computeTermSpreads(result.memories),
    });
  }

  return {
    armLabel: options.armLabel,
    tenantId: options.tenantId,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    haystackKind,
    ingest: {
      observationCount: utterances.length,
      drain,
    },
    probes,
    mrrOverall: average(probes.map((p) => p.reciprocalRank)),
    hit1Count: probes.filter((p) => p.hit1).length,
    hit10Count: probes.filter((p) => p.hit10).length,
    probeCount: probes.length,
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function formatRank(rank: number | null): string {
  return rank === null ? "(無し)" : String(rank);
}

/** probe ごとの内訳と、arm 全体の MRR/hit@1/hit@10 を出す。 */
export function formatIdentifierArmReport(report: IdentifierArmReport): string {
  const lines: string[] = [];
  lines.push(`=== identifier-probe arm ${report.armLabel}(tenant=${report.tenantId}) ===`);
  lines.push(
    `provider: llm=${report.llmMode} / embedding=${report.embeddingMode} / ` +
      `haystack=${report.haystackKind}`,
  );
  lines.push(
    `ingest: observations=${report.ingest.observationCount} ` +
      `ticks=${report.ingest.drain.ticks} ` +
      `firstTickProcessed=${report.ingest.drain.firstTickProcessed} ` +
      `totalProcessed=${report.ingest.drain.totalProcessed} ` +
      `totalFailed=${report.ingest.drain.totalFailed}`,
  );
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}[${p.category}]: goldRank=${formatRank(p.goldRank)} hit@1=${p.hit1} ` +
        `hit@10=${p.hit10} distractorRank=${formatRank(p.distractorRank)} ` +
        `distractorBeatsGold=${p.distractorBeatsGold} omitted=[${p.omittedKinds.join(",")}] ` +
        `totalInScope=${p.totalInScope}`,
    );
    lines.push(`      項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
    for (const detail of p.scoreDetails) {
      lines.push(`      ${formatScoreDetail(detail)}`);
    }
  }
  lines.push(
    `MRR: ${report.mrrOverall.toFixed(3)} ` +
      `hit@1=${report.hit1Count}/${report.probeCount} ` +
      `hit@10=${report.hit10Count}/${report.probeCount}`,
  );
  return lines.join("\n");
}
