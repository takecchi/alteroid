import { heuristicTokenCounter } from "@mnemora/core";
import type { Ctx, MemoryStore, Omission, Runtime } from "@mnemora/core";
import { buildConversation } from "./scenario.js";
import { measureNaive } from "./naive-path.js";
import { factStatementExternalId, runMnemoraPath } from "./mnemora-path.js";
import { resultContainsObservation } from "./provenance-trace.js";

/**
 * `recall().memories` の中に、冒頭の事実表明が残っているかを判定する。
 *
 * ⚠ **かつてここは `digest.includes("青")` という文字列一致だった**（ADR 0052 で置き換えた）。
 * その判定は `@mnemora/testkit` の擬似 LLM が「digest ＝ 発話の本文そのもの」を作ることに
 * 依存しており、**本物の LLM では成立しない**——digest は要約・言い換えされるので、
 * 「青」という語を使わずに要約されれば偽陰性、無関係な記憶がその語を含めば偽陽性になる。
 * その限界は当時のコメントにも書かれていたが、**限界を書いたまま使い続けていた。**
 *
 * ⟹ **`sourceObservationId` を辿って `externalId` で照合する**（`./provenance-trace.js`）。
 * digest の中身を一切見ないため、擬似・記録の再生・実 API のどれでも同じ意味になる。
 */
async function factStatementSurvived(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memories: readonly { memoryId: string }[],
): Promise<boolean> {
  return resultContainsObservation(memoryStore, ctx, memories, factStatementExternalId());
}

/** `omitted` のうち `not_indexed`（reason 問わず）の `count` を合算する。 */
function notIndexedCount(omitted: Omission[]): number {
  return omitted
    .filter((o): o is Extract<Omission, { kind: "not_indexed" }> => o.kind === "not_indexed")
    .reduce((sum, o) => sum + o.count, 0);
}

/**
 * `compare` が測る会話の長さ（filler 往復数）の既定の列。
 *
 * **`cli.ts` から移した**（ADR 0052）——カセットの被覆を検査する歯
 * （`cassette-coverage.test.ts`）が、実 API を何回叩く列なのかを知る必要があるため。
 * 合計 Σ(fillerPairs+1) = 657 回の LLM 呼び出しになる。
 */
export const DEFAULT_COMPARE_SEQUENCE = [0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320];

export interface ComparisonRow {
  fillerPairs: number;
  turnCount: number;
  naiveChars: number;
  naiveTokens: number;
  mnemoraChars: number;
  mnemoraTokens: number;
  mnemoraShareOfNaiveChars: number;
  /** そのテナントのスコープ内総数（`recall().index.totalInScope`）。テナント分離の検査に使う。 */
  totalInScope: number;
  /**
   * `recall().omitted` をそのまま持つ（要約しない）。
   *
   * 以前はここを `omittedKinds: string[]`（`kind` だけ）にしていたが、それでは
   * `reason`・`count`・`countKind` が消え、「スコープ内321件のうち271件が埋め込まれて
   * いない」のような、北極星の物差しに答えるために要る情報が失われる。ADR 0008 の芯は
   * 「推定値を実測値の顔で出さない」ことであり、`countKind`（`exact`/`lower_bound`/
   * `unknown`）を捨てるとその区別自体が消えるため、`Omission` を丸ごと保持する。
   */
  omitted: Omission[];
  /** 実際に返った件数（`recall().memories.length`）。 */
  returnedCount: number;
  /**
   * スコープ内（`totalInScope`）のうち、実際に ANN の候補になれた件数
   * （= totalInScope − `omitted` の `not_indexed`（reason 問わず）の合計）。
   *
   * これが「321件と競ったのか、50件と競ったのか」（PR 本文の核心の問い）に直接答える列。
   * ADR 0021 で `ingestConversation` が `tick()` を回し切るようになった後は、
   * この値が `totalInScope` と一致し（`not_indexed(pending)` が `omitted` に現れず）
   * なるはず——ただし本 PR ではそれを実測していない（README・報告参照）。
   *
   * ⚠ `not_indexed` の `countKind` が `exact` でない場合（Phase 1 の実装では常に
   * `exact`）でも、この引き算は常に count をそのまま差し引く。`countKind` は
   * `omitted` 列にそのまま残るので、不確かさの有無はそちらで確認できる。
   */
  annCandidateCount: number;
  /**
   * 冒頭の事実表明（`FACT_STATEMENT`）が `recall().memories` に残っているか。
   * 判定方法とその限界は `factStatementSurvived` のコメントを見ること——
   * **このシナリオと擬似 provider に固有の近似判定であり、一般的な判定ではない。**
   */
  factStatementSurvived: boolean;
}

export interface CompareOptions {
  /** 会話の長さ（filler 往復数）を変えた数点。北極星の物差しに答えるための核心。 */
  fillerPairsSequence: number[];
  /** テナントIDの接頭辞。テスト側から重複を避けるために差し替えられるようにしてある。 */
  tenantPrefix?: string;
  /**
   * 冒頭の事実が残ったかを `sourceObservationId` で辿るために必要（ADR 0052）。
   *
   * **省略可能にしていない。**省略を許すと文字列一致へ倒れる経路が残り、
   * 「どちらの判定で出た ❌ なのか」が表から読めなくなる。
   */
  memoryStore: MemoryStore;
}

/**
 * 会話の長さを変えて、経路A（naive）・経路B（mnemora）が実際に焼く量を測る
 * （PR 本文「量の比較」。docs/roadmap.md §4「計測と抑止を混同しない」を踏まえ、
 * ここでは budget を渡さない——「切り詰めずに、そのままだと何文字になるか」を見る）。
 *
 * `fillerPairsSequence` の要素ごとに新しい tenantId を使う。recall() のスコープは
 * テナント単位（docs/recall.md 段0）であり、同じテナントに会話を積み増していくと、
 * 後の計測が前の会話の記憶を引きずってしまい「その長さの会話単体で何文字になるか」
 * を独立に測れなくなる。
 */
export async function runComparison(
  runtime: Runtime,
  options: CompareOptions,
): Promise<ComparisonRow[]> {
  const tenantPrefix = options.tenantPrefix ?? "example-compare";
  const rows: ComparisonRow[] = [];
  for (const fillerPairs of options.fillerPairsSequence) {
    const ctx: Ctx = { tenantId: `${tenantPrefix}-${fillerPairs}` };
    const conversation = buildConversation(fillerPairs);
    const naive = measureNaive(conversation, heuristicTokenCounter);
    const { recall } = await runMnemoraPath(runtime, ctx, conversation);
    rows.push({
      fillerPairs,
      turnCount: conversation.turns.length,
      naiveChars: naive.chars,
      naiveTokens: naive.estimatedTokens,
      mnemoraChars: recall.usage.chars,
      mnemoraTokens: recall.usage.estimatedTokens,
      mnemoraShareOfNaiveChars: recall.usage.chars / naive.chars,
      totalInScope: recall.index.totalInScope,
      omitted: recall.omitted,
      returnedCount: recall.memories.length,
      annCandidateCount: recall.index.totalInScope - notIndexedCount(recall.omitted),
      factStatementSurvived: await factStatementSurvived(options.memoryStore, ctx, recall.memories),
    });
  }
  return rows;
}

export function formatComparisonTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const ratio = `${(r.mnemoraShareOfNaiveChars * 100).toFixed(1)}%`;
    return `| ${r.turnCount} | ${r.naiveChars} | ${r.naiveTokens} | ${r.mnemoraChars} | ${r.mnemoraTokens} | ${ratio} |`;
  });
  return [header, sep, ...body].join("\n");
}

/** `omitted` を `kind(detail):count` の形にまとめた1行にする（件数を落とさない）。 */
function formatOmittedSummary(omitted: Omission[]): string {
  if (omitted.length === 0) {
    return "(無し)";
  }
  return omitted
    .map((o) => {
      switch (o.kind) {
        case "not_indexed":
          return `not_indexed(${o.reason}):${o.count}`;
        case "filtered":
          return `filtered(${o.condition}):${o.count}`;
        case "below_threshold":
          return `below_threshold:${o.count}`;
        case "over_limit":
          return `over_limit:${o.count}`;
        case "budget_dropped":
          return `budget_dropped:${o.count}`;
        case "stage_skipped":
          return `stage_skipped(${o.stage}/${o.reason})`;
        case "ann_truncated":
          return "ann_truncated";
        case "ann_unreached":
          return "ann_unreached";
        // ADR 0084。件数を持たない札なので、ann_truncated / ann_unreached と同じ形で名前だけ出す。
        case "lexical_truncated":
          return "lexical_truncated";
        case "unit_assembly_dropped":
          return `unit_assembly_dropped:${o.count}`;
        case "score_not_comparable":
          return `score_not_comparable:${o.count}`;
        default: {
          // 網羅性の歯: Omission に新しい kind が増えたらここが型エラーになる。
          const exhaustive: never = o;
          return String(exhaustive);
        }
      }
    })
    .join(", ");
}

/**
 * 北極星の物差し（「会話ログを全部プロンプトへ積むのをやめられたか」）に直接答える表。
 *
 * `formatComparisonTable`（量だけの表）と違い、こちらは「削っても目的の記憶が
 * 落ちていないか」——README「⭐ 削減率だけでは意味を持たない」節の表に対応する。
 * 「返った件数」だけでなく「実際に ANN の候補になれた件数」を並べることで、
 * 「スコープ内 totalInScope 件と競ったのか、それより少ない候補としか競っていないのか」
 * を1行で読めるようにしてある（ADR 0021 が直した欠陥の再発を、この表だけで検知できる
 * ——`annCandidateCount` が `totalInScope` を下回れば、`omitted` 列の
 * `not_indexed(pending):N` がその内訳を示す）。
 */
export function formatRecallQualityTable(rows: ComparisonRow[]): string {
  const header =
    "| 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実が残っているか | `omitted` の内訳 |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const survived = r.factStatementSurvived ? "✅" : "❌";
    return `| ${r.turnCount} | ${r.totalInScope} | ${r.annCandidateCount} | ${r.returnedCount} | ${survived} | ${formatOmittedSummary(r.omitted)} |`;
  });
  return [header, sep, ...body].join("\n");
}
