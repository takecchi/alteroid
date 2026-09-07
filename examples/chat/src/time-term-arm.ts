import type { Ctx, MemoryStore, RecalledMemory, Runtime, ScoreBreakdown } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { MutableClock } from "./mutable-clock.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import { formatScoreValue, formatTermSpreads, computeTermSpreads } from "./retrieval-quality.js";
import type { TermSpread } from "./retrieval-quality.js";
import {
  TIME_PROBES,
  buildTimeTermConversation,
  newerExternalId,
  olderExternalId,
} from "./time-term-probe-set.js";
import type { TimeProbe } from "./time-term-probe-set.js";

/**
 * 時間項2つ(`freshness` と `decay`)を意味的類似度から分離して測る arm(PR 本文)。
 *
 * **ペアの本文を厳密に同一にする。**⟹ `similarity` はペア内で構成上ぴったり同じになる。
 * そこから先は、動かす項ごとに口が違う——`freshness` は `observe()` の `occurredAt`、
 * `decay` は注入した `Clock`(`mutable-clock.ts`)で振る `recordedAt` である
 * (`decay` の起点は `lastReinforcedAt ?? recordedAt` であり `occurredAt` を読まない)。
 *
 * **⚠ probe ごとに時刻を1点へ凍結する。**`runOneProbe` は probe の先頭で実時刻を1回
 * 捕まえ、`recordedAt` を明示しない member にはその同じ瞬間を使う。⟹ `recordedAt` を
 * 明示しない probe では、ペアの `decay` の幅が**厳密に 0** になる。
 * **これは ADR 0033 が測った `decay` の幅(probe ごとに 1.1〜1.8×10⁻⁵)とは違う条件である**
 * ——あちらは60件超を1〜2分かけて取り込んだ実時間の産物であり、こちらは
 * 「時間項以外を動かさない」ために意図して消してある。
 *
 * **probe ごとに別テナントを使う。**理由: スコープ内にそのペアの2件だけを置けば、
 * `limit`(既定10件)/`scoreThreshold`(既定 `DEFAULT_SCORE_THRESHOLD`)の外に
 * 落ちる可能性(他の候補に押し出される)や、他 probe との語彙的な競合を消せる。
 * **この arm は「現実らしさ」を捨てて「分離」を採る**——複数の話題が同じスコープに
 * 同居する状況での現実らしさは、既存の `probe-set.ts`(`retrieval-quality.ts`)の側が
 * 既に担っている。ここでは「時間項だけが動いたときに順位がどう動くか」を、
 * 他の変数を極力削って見る。
 */

// ---------------------------------------------------------------------------
// ペアの判定
// ---------------------------------------------------------------------------

/**
 * ペアの total 差を「時間項が順位を決めていない」と読む上限。
 *
 * ⚠ 根拠(裁量値であり、強い根拠は無い): ペアの2件は連続する `observe()` 呼び出しなので
 * `recordedAt` がミリ秒〜数百ミリ秒しか違わない。`decay` の起点は
 * `lastReinforcedAt ?? recordedAt` であり(`packages/core/src/strategies/scoring.ts`)、
 * 半減期の既定 720時間(30日、`packages/postgres/src/tenant-settings-store.ts` の
 * `DEFAULT 720`)に対してミリ秒〜数百ミリ秒の差は
 * `0.5 ** (数百ミリ秒/時間 ÷ 720時間)` ≒ `1 - 1e-7` の桁にしかならず、
 * `decay` の比は 1 から 1e-7 程度しか離れない。一方 `realistic` probe の `freshness` 差は
 * `0.5**(1/30) - 0.5**(4/30)` ≒ 0.0655 で、絶対値で 0.05 前後在る。
 * ⟹ `1e-4` は「ミリ秒差の残り(decay 側のノイズ)」より十分大きく、
 * 「`realistic` probe が意図する現実的な差」より十分小さい。
 * **ただし、この数自体を裏付ける実測やより厳密な導出は無い**——「十分大きい/小さい」の
 * 判断は上記2つの実測値の桁を並べただけであり、境界付近の挙動まで検証したものではない。
 */
export const TIE_EPSILON = 1e-4;

export type PairOutcome =
  | "newer-ranked-higher"
  | "older-ranked-higher"
  | "tied"
  | "newer-not-returned"
  | "older-not-returned"
  | "neither-returned"
  | "collapsed";

export interface PairMember {
  rank: number;
  score: ScoreBreakdown;
  digest: string;
}

/**
 * 純関数。返らなかったものを 0 に潰さない(ADR 0008「無いには種類がある」の適用)。
 *
 * **`collapsed` は呼び出し側が判定して渡す。**`rank` の比較では検出できない——
 * 1件の Memory は1つの externalId にしか解決されないので、2つの違う externalId を
 * `indexOf` で引いた添字が一致することは構造上起こらない。**ペアが潰れたときに実際に
 * 現れる形は「片方が返ってこない」であり、`older-not-returned` と区別が付かない。**
 * ⟹ 潰れたかどうかは `recall()` のスコープ内総数から見る(`runOneProbe` 参照)。
 *
 * **⛔ ここに `newer.rank === older.rank` の分岐を置いていたが、届かない分岐だったので
 * 外した**(ADR 0024 の「実装の無い予約を残さない」と同じ理由——検査できない経路を
 * 「念のため」で増やさない)。
 */
export function classifyPairOutcome(
  newer: PairMember | null,
  older: PairMember | null,
  options: { tieEpsilon?: number; pairCollapsed?: boolean } = {},
): PairOutcome {
  if (options.pairCollapsed === true) {
    return "collapsed";
  }
  const tieEpsilon = options.tieEpsilon ?? TIE_EPSILON;
  if (newer === null && older === null) {
    return "neither-returned";
  }
  if (newer === null) {
    return "newer-not-returned";
  }
  if (older === null) {
    return "older-not-returned";
  }
  const diff = newer.score.total - older.score.total;
  if (Math.abs(diff) <= tieEpsilon) {
    return "tied";
  }
  return newer.rank < older.rank ? "newer-ranked-higher" : "older-ranked-higher";
}

// ---------------------------------------------------------------------------
// probe ごとの指標
// ---------------------------------------------------------------------------

export interface TimeProbeOutcome {
  probeId: string;
  outcome: PairOutcome;
  newer: PairMember | null;
  older: PairMember | null;
  /** ペアの2件の similarity の差の絶対値。片方が返っていなければ null(0 と区別する)。 */
  similarityGapWithinPair: number | null;
  /**
   * ペアの2件の freshness の差の絶対値(`similarityGapWithinPair` と同じ形)。
   * `decay` 分離 probe(`decay-*`)では、両者の `occurredAt` を揃えてあるので
   * これが 0 でなければ分離できていない——`decay-*` probe の検査の要。
   */
  freshnessGapWithinPair: number | null;
  /** older / newer の freshness の比。片方が返っていなければ null。 */
  freshnessRatio: number | null;
  /** older / newer の decay の比。片方が返っていなければ null。 */
  decayRatio: number | null;
  /** older / newer の total の比。片方が返っていなければ null。 */
  totalRatio: number | null;
  omittedKinds: string[];
  totalInScope: number;
  /** 返った候補全体の項ごとの幅。`retrieval-quality.ts` の `computeTermSpreads` を再利用する。 */
  termSpreads: TermSpread[];
}

/** 片方でも欠けていれば null(0 と区別する)。 */
function ratio(
  newer: PairMember | null,
  older: PairMember | null,
  pick: (score: ScoreBreakdown) => number,
): number | null {
  if (newer === null || older === null) {
    return null;
  }
  return pick(older.score) / pick(newer.score);
}

function similarityGap(newer: PairMember | null, older: PairMember | null): number | null {
  if (newer === null || older === null) {
    return null;
  }
  const a = newer.score.similarity;
  const b = older.score.similarity;
  if (a === undefined || b === undefined) {
    return null;
  }
  return Math.abs(a - b);
}

/** `similarityGap` と同じ形。`freshness` は必須欄なので undefined チェックは要らない。 */
function freshnessGap(newer: PairMember | null, older: PairMember | null): number | null {
  if (newer === null || older === null) {
    return null;
  }
  return Math.abs(newer.score.freshness - older.score.freshness);
}

export interface TimeTermArmReport {
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now: Date;
  probes: TimeProbeOutcome[];
}

export interface RunTimeTermArmOptions {
  armLabel: string;
  /** probe ごとに `${tenantIdPrefix}-${probe.id}` を使う。 */
  tenantIdPrefix: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  /** 既定は `new Date()`。検査から固定できるように受ける。 */
  now?: Date;
  /**
   * `decay` を `freshness` から分離して測る probe(`decay-*`)だけが使う。
   * この `clock` は `createExampleRuntime` に渡した `MutableClock` と**同じインスタンス**
   * でなければならない——別インスタンスを渡しても `Runtime` 内部の `recordedAt` 計算には
   * 反映されない。省略した場合、`newerRecordedDaysAgo`/`olderRecordedDaysAgo` は無視され
   * (常に実時刻のまま)、`decay-*` probe は「分離できていない」結果になる。
   */
  clock?: MutableClock;
}

function toPairMember(memory: RecalledMemory, index: number): PairMember {
  return { rank: index + 1, score: memory.score, digest: memory.digest };
}

async function runOneProbe(
  probe: TimeProbe,
  options: RunTimeTermArmOptions,
  now: Date,
): Promise<TimeProbeOutcome> {
  const ctx: Ctx = { tenantId: `${options.tenantIdPrefix}-${probe.id}` };
  const utterances = buildTimeTermConversation(probe, now);
  // この probe のあいだ「実時刻」として使う1点。**member ごとに `new Date()` を
  // 取り直さない**——取り直すと `recordedAt` を明示しない member どうしにミリ秒差が
  // 残り、`decay` に測るつもりの無い幅が入る。
  const realNow = new Date();

  for (const utterance of utterances) {
    // ⭐ member を observe する直前に、**必ず** Clock を置く。
    // `recordedAt` を明示する member(`decay-*` probe)はその時刻へ、明示しない member は
    // `realNow` へ。**「明示しないときは何もしない」にはしない**——それだと、片方だけ
    // `recordedAt` を持つ probe を足したときに、もう片方が前の member の過去時刻を
    // そのまま引き継いでしまう(いまの `TIME_PROBES` には無いが、罠は残さない)。
    options.clock?.set(utterance.recordedAt ?? realNow);
    await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
      ...(utterance.occurredAt !== null ? { occurredAt: utterance.occurredAt } : {}),
    });
  }

  // ⭐ recall の直前に必ず実時刻へ戻す——`recall()` の `now`(freshness/decay の基準時刻)も
  // `clock.now()` から来る(`packages/core/src/recall-runtime.ts` の
  // `const now = deps.clock.now()`)。ここで戻し忘れると、この probe の recall 自体が
  // 過去の時刻で評価されてしまう。
  //
  // ⭐⚠ **戻す先は `realNow` ではなく、いま取り直した実時刻でなければならない。**
  // `outbox.available_at` は Postgres の SQL `now()` で入り、アプリ側の `Clock` を
  // 読まない(`packages/postgres/src/memory-store.ts` の `INSERT INTO outbox`)。
  // 一方 `tick()` の claim 条件は `available_at <= clock.now()` を**アプリ側の
  // `Clock` で**評価する(`packages/core/src/runtime.ts`)。⟹ `clock` を取り込み開始
  // より前の時刻(= `realNow`)に戻すと、`available_at`(取り込み中の DB 時刻)のほうが
  // 後になり、**embed ジョブが1件も claim されずに ANN 候補が空になる。**
  // **実測でこれを踏んだ**——8 probe すべてが「この項を持つ候補が無い」になった。
  const afterIngest = new Date();
  options.clock?.set(afterIngest);

  await drainEmbedTicks(options.runtime, ctx);

  // ⛔ `text` 以外を渡さない——既定の limit/閾値/overFetchFactor のまま測る
  // (既存 `runRetrievalQualityArm` と同じ規律)。
  const result = await options.runtime.recall(ctx, { text: probe.query });

  const resolvedExternalIds = await Promise.all(
    result.memories.map((m) => resolveExternalId(options.memoryStore, ctx, m.memoryId)),
  );
  const newerIndex = resolvedExternalIds.indexOf(newerExternalId(probe.id));
  const olderIndex = resolvedExternalIds.indexOf(olderExternalId(probe.id));
  const newer = newerIndex === -1 ? null : toPairMember(result.memories[newerIndex]!, newerIndex);
  const older = olderIndex === -1 ? null : toPairMember(result.memories[olderIndex]!, olderIndex);

  // ペアが2件として残ったか。**この arm は probe ごとに専用のテナントを使う**ので、
  // スコープ内の Memory はそのペアだけである。⟹ `totalInScope < 2` は「2つの
  // Observation が2件の Memory にならなかった」＝ペアが潰れたことを意味する。
  //
  // いまは起きない——Memory の抽出の冪等キーに `source_observation_id` が入っているため、
  // 同一内容でも別 Observation なら別 Memory になる(`packages/core/src/interfaces/
  // memory-store.ts` の `createMemoryWithOutbox` の契約)。**dedupe や矛盾検出が入れば
  // 起きる。そのとき `older-not-returned` へ黙って読み替えないために独立して見る。**
  //
  // ⚠ 見るのは `< 2` の側だけである。本物の LLM は1発話から複数の Memory を作りうるので、
  // `> 2` は異常ではない。
  const pairCollapsed = result.index.totalInScope < 2;

  return {
    probeId: probe.id,
    outcome: classifyPairOutcome(newer, older, { pairCollapsed }),
    newer,
    older,
    similarityGapWithinPair: similarityGap(newer, older),
    freshnessGapWithinPair: freshnessGap(newer, older),
    freshnessRatio: ratio(newer, older, (s) => s.freshness),
    decayRatio: ratio(newer, older, (s) => s.decay),
    totalRatio: ratio(newer, older, (s) => s.total),
    omittedKinds: result.omitted.map((o) => o.kind),
    totalInScope: result.index.totalInScope,
    termSpreads: computeTermSpreads(result.memories),
  };
}

export async function runTimeTermArm(options: RunTimeTermArmOptions): Promise<TimeTermArmReport> {
  const now = options.now ?? new Date();
  const probes: TimeProbeOutcome[] = [];
  for (const probe of TIME_PROBES) {
    probes.push(await runOneProbe(probe, options, now));
  }
  return {
    armLabel: options.armLabel,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    now,
    probes,
  };
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function formatRatio(value: number | null): string {
  return value === null ? "(片方が返っていない)" : formatScoreValue(value);
}

function formatPairMember(label: "newer" | "older", member: PairMember | null): string {
  if (member === null) {
    return `  ${label}: (返っていない)`;
  }
  const s = member.score;
  const similarity =
    s.similarity === undefined ? "(ANN 経由でない)" : formatScoreValue(s.similarity);
  return (
    `  ${label}: #${member.rank} total=${formatScoreValue(s.total)} = ` +
    `similarity ${similarity} × decay ${formatScoreValue(s.decay)} × ` +
    `tagMatch ${formatScoreValue(s.tagMatch)} × freshness ${formatScoreValue(s.freshness)} × ` +
    `strength ${formatScoreValue(s.strength)}  ${member.digest}`
  );
}

/** probe ごとの outcome・両者の内訳・比・omitted を出す。 */
export function formatTimeTermReport(report: TimeTermArmReport): string {
  const lines: string[] = [];
  lines.push(`=== time-term arm ${report.armLabel} ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`now: ${report.now.toISOString()}`);
  for (const p of report.probes) {
    lines.push(
      `  - ${p.probeId}: outcome=${p.outcome} ` +
        `omitted=[${p.omittedKinds.join(",")}] totalInScope=${p.totalInScope}`,
    );
    lines.push(formatPairMember("newer", p.newer));
    lines.push(formatPairMember("older", p.older));
    lines.push(
      `  similarityGapWithinPair=${formatRatio(p.similarityGapWithinPair)} ` +
        `freshnessGapWithinPair=${formatRatio(p.freshnessGapWithinPair)}`,
    );
    lines.push(
      `  freshnessRatio=${formatRatio(p.freshnessRatio)} decayRatio=${formatRatio(p.decayRatio)} ` +
        `totalRatio=${formatRatio(p.totalRatio)}`,
    );
    lines.push(`  項ごとの値の幅(返った候補全体): ${formatTermSpreads(p.termSpreads)}`);
  }
  return lines.join("\n");
}
