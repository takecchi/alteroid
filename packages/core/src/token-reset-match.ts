import { parseNoticeResetAt } from './usage-reset-text.js';
import type { AgentToken, CooldownSource } from './token-pool.js';

/**
 * 429 の文言に含まれる `resets` 時刻を、プールの各鍵の `cooldownUntil` と
 * 突き合わせて「世代ずれ」を名指しする（Issue #914 オーナー提案(2)）。
 *
 * ## 何のためにあるか
 *
 * オーナーの実測（#914 の 2026-09-14T20:19Z のコメント）: 走行中の4本が
 * `resets 9:30am (Asia/Tokyo)` で落ちたが、その時刻は**既に降りた鍵
 * `alteroid08` の `resetsAt` と一致**しており、現役は新品の `alteroid09`
 * だった ⟹ 4本とも古い鍵を掴んだまま落ちていた、と**時刻の突き合わせだけで
 * 確定できた**。この関数はその手作業（3箇所の時刻を突き合わせる）を機械化する。
 *
 * ## `manager.ts` の `#tokenIdentities`（世代番号の直接比較。#968・提案1）と
 * どう違うか
 *
 * 提案1はプロセス内の記憶（daemon が最後にこの委譲へ撒いた世代）と現役の世代
 * 番号を直接比べる——**daemon 自身の bookkeeping が追いついていることが前提**
 * である。`TokenGenerationUnknownReason` が挙げる3つの理由
 * （`pool-not-wired` / `not-yet-observed` / `reattached-across-restart`）は、
 * その bookkeeping がまだ・もう無い状態で、提案1はそこでは何も言えない。
 *
 * **この関数はその外側から効く。** 材料は (a) 429 の文言そのもの（SDK が
 * 返した生の事実）と (b) `TokenPoolStore`（DB 正本）が持つ各鍵の `cooldownUntil`
 * ——**daemon のプロセス内記憶に一切依存しない**。⟹ 提案1が `undefined` を
 * 返す（bookkeeping が無い）場面でも、この関数は独立に判定できる。
 *
 * ## 「待てば戻る」と「世代ずれ」の違い
 *
 * - 文言の resets 時刻が**現役**の鍵の `cooldownUntil` と一致 ⟹ `'active'`
 *   （このセッションが古い鍵を掴んでいるのではなく、現役自身がまだ冷却中——
 *   待てば戻る）
 * - 文言の resets 時刻が**現役ではない**鍵（冷却中／無効化済みのいずれか）の
 *   `cooldownUntil` と一致 ⟹ `'stale'`（このセッションは古い鍵を掴んだまま
 *   走っている——鍵が戻っても、このセッション自身は起こし直すまで戻らない）
 * - **どちらとも一致しない・時刻が読めない ⟹ `undefined`。** 「判定できない」を
 *   「世代ずれではない」へ倒さない（`ManagerSummary.turnEndedAt` の doc の
 *   「既定は『分からない』」と同じ作法）
 *
 * ## 許容幅は「分までしか無い」という事実からしか作らない
 *
 * 文言の時刻は分単位でしか書かれていない（`usage-reset-text.ts` の
 * `parseNoticeResetAt` が「秒が落ちる」ことを前提に、返す epoch を分の頭へ
 * 揃えている）。⟹ 比べる側の `cooldownUntil` も**分の頭へ丸めてから**比べる
 * ——これ以上の許容（例: ±5分）は実測が無いので発明しない。
 *
 * ## 権威ある値としか比べない
 *
 * `cooldownUntil` の出所（{@link AgentToken.cooldownSource}）が `notice_text` /
 * `default`（推測）の行とは比べない——推測どうしを比べると、**値の作られ方が
 * 同じ**（設定の既定を足しただけ、または別の文言から読んだ推測）なせいで
 * 偶然一致しうる。比べるのは `quota_reset` / `overage_reset`
 * （`AuthoritativeCooldownSource`。権威ある値）だけである。
 */
export type NoticeResetMatch = 'active' | 'stale';

/**
 * `parseNoticeResetAt` に渡す窓（探す「次の occurrence」の上限）。
 *
 * **発明した数ではない。** `usage-reset-text.ts` の `RESETS_AT_PATTERN` は
 * 日付付きの形（`resets Sep 8, 10:10pm (…)`）には当たらない——同ファイルの
 * doc が「後者を受けないのは正しい」と言っている理由がそのまま使える: **この
 * 関数が読める文言は、そもそも24時間以内のどこかを指すものに限られる。**
 * 24時間はその構造から決まる上限であって、実測で選んだ値ではない
 * （`parseNoticeResetAt` の内部で `delta` が最大1440分＝ちょうど24時間になる
 * ことに対応する）。
 */
const NOTICE_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * 推測（権威ある値ではない）出所。**`AuthoritativeCooldownSource` の定義
 * （`Exclude<CooldownSource, 'default' | 'notice_text'>`）の裏返しを、ここでも
 * 手で持つ**——実行時に「権威あるか」を判定するには具体の文字列が要るため
 * （型の `Exclude` はコンパイル時にしか効かない）。`token-reset-match.test.ts`
 * が `cooldownSourceSchema` の全値とここを両方向で突き合わせるので、
 * `CooldownSource` に値が増えても・ここが古びれば赤くなる。
 */
const GUESSED_COOLDOWN_SOURCES: ReadonlySet<CooldownSource> = new Set(['default', 'notice_text']);

/** その行が「権威ある」`cooldownUntil` を持つか（`GUESSED_COOLDOWN_SOURCES` の裏返し）。 */
function hasAuthoritativeCooldown(
  token: AgentToken,
): token is AgentToken & { cooldownUntil: number; cooldownSource: CooldownSource } {
  return (
    token.cooldownUntil !== undefined &&
    token.cooldownSource !== undefined &&
    !GUESSED_COOLDOWN_SOURCES.has(token.cooldownSource)
  );
}

/** 分の頭へ揃える。帯の差は必ず分単位なので、epoch の分の頭はどの帯でも分の頭である。 */
function roundDownToMinute(ms: number): number {
  return ms - (ms % 60_000);
}

export interface MatchNoticeResetOptions {
  /** 通知を受け取った時刻（epoch ミリ秒）。**観測した時刻を渡す。** */
  at: number;
}

/**
 * 429 の文言の `resets` 時刻を、プールの各鍵の権威ある `cooldownUntil` と
 * 突き合わせる。
 *
 * @param noticeText SDK が出した文言そのまま（`UsageLimitNotice.text`）。
 * @param activeTokenId いまの現役の鍵の id。**分からなければ `undefined` を渡す
 *   こと**——比べる相手（「現役かどうか」の軸）が無いまま推測しない。
 * @param pool `TokenPoolStore#list()` の全行（値を含んでいてよい。ここは
 *   `id` / `cooldownUntil` / `cooldownSource` しか見ない）。
 * @param options `{ at }`——文言を受け取った時刻。
 * @returns
 * - `'active'`: 文言の resets 時刻が現役の鍵の `cooldownUntil` と一致
 *   （待てば戻る。世代ずれではない）
 * - `'stale'`: 文言の resets 時刻が現役ではない鍵の `cooldownUntil` と一致
 *   （世代ずれ——このセッションは古い鍵を掴んだまま走っている）
 * - `undefined`: どちらとも言えない（一致しない・文言が読めない・比べる材料が
 *   無い）。**「世代ずれではない」という意味には読まないこと。**
 */
export function matchNoticeResetAgainstPool(
  noticeText: string,
  activeTokenId: string | undefined,
  pool: readonly AgentToken[],
  options: MatchNoticeResetOptions,
): NoticeResetMatch | undefined {
  if (activeTokenId === undefined) return undefined;

  const impliedResetAt = parseNoticeResetAt(noticeText, {
    at: options.at,
    withinMs: NOTICE_RESET_HORIZON_MS,
  });
  if (impliedResetAt === undefined) return undefined;
  // `parseNoticeResetAt` は既に分の頭へ揃えた epoch を返すが、比較対象の
  // `cooldownUntil` 側にも同じ丸めを明示で通す（この関数の doc「許容幅は
  // 分までしか無いという事実からしか作らない」を、読んだだけで分かる形にする）。
  const target = roundDownToMinute(impliedResetAt);

  const active = pool.find((token) => token.id === activeTokenId);
  if (
    active !== undefined &&
    hasAuthoritativeCooldown(active) &&
    roundDownToMinute(active.cooldownUntil) === target
  ) {
    return 'active';
  }

  const stale = pool.find(
    (token) =>
      token.id !== activeTokenId &&
      hasAuthoritativeCooldown(token) &&
      roundDownToMinute(token.cooldownUntil) === target,
  );
  return stale === undefined ? undefined : 'stale';
}
