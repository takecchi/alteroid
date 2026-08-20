import {
  dailyReportEntry,
  parseTimeOfDay,
  selfInitiativeEntry,
  type ScheduleEntry,
  type TimeOfDay,
} from '@alteroid/core';

/**
 * デーモンに仕込む定期ジョブの設定。
 *
 * **既定は「動く」である。** 常駐と自律は後から足す機能ではないので、何も設定
 * しなくても日報と発意 tick は回る（PRD「自律」「可観測性」）。
 *
 * 間隔と締め時刻は方針なので設定で変えられ、`off` で外すこともできる。ただしこれは
 * 「暴走が怖いから回数を絞る」ための旋盤ではない — 抑止は実行環境の境界で行う
 * （north_star 禁止2 / AGENTS.md 地雷2）。
 */
export interface ScheduleConfig {
  /** 日報の締め時刻（ローカル時刻）。null なら日報を仕込まない。 */
  dailyReportAt: TimeOfDay | null;
  /** 発意 tick の間隔（分）。null なら仕込まない。 */
  initiativeEveryMinutes: number | null;
  /** 起動時に、取りこぼした日報を何日前まで遡って作るか。 */
  reportLookbackDays: number;
  /** 読めなかった設定値についての注意（呼び出し元が人間に見せる）。 */
  notes: string[];
}

export const DEFAULT_DAILY_REPORT_AT = '22:00';
/**
 * 発意 tick の既定間隔（分）。
 *
 * **60 ではない理由。** 導入時（PR #4, 1b6d67c）から根拠不明のまま 60 分だった
 * （コミットメッセージ・PR 本文・レビューコメント・docs のどこにも由来は無く、
 * PR #4 自身が「既定値（22:00・60分）が妥当か」を人間の確認待ちのまま残していた。
 * #96 も 60 を既知の値として引用するだけで由来には触れていない）。それとは別に
 * 構造的な不利がある — クローンが暇なときに目を覚ますのはちょうど tick の瞬間で、
 * それがプロンプトキャッシュの失効瞬間と重なると、そのターンは文脈を全部書き直す
 * 最も高い1回になる。**キャッシュ読みは基本入力単価の約 0.1 倍だが、キャッシュ
 * 書き直しは 5分 TTL で 1.25 倍・1時間 TTL で 2 倍**（Anthropic の prompt caching
 * ドキュメント）なので、失効の境界に重ならなければ避けられたはずの上乗せが乗る。
 * **しかもこの重なりは #96（`packages/core/src/schedule.ts` の `#seedBase` /
 * `dueFromSeed`）が位相を器の入れ替えを越えて永続化したことで、いま初めて本当に
 * 周期的になった** — #96 以前は再デプロイのたびに位相が `now + 周期` へ捨て直されて
 * いたので、この重なりは「起きたり起きなかったり」で直す動機が弱かった（#96 の本文
 * の実測: 器の入れ替えで発意が丸1時間先へずれた）。**ただし #96 はこの PR の時点で
 * まだ `release/prod` に無い** — 本番は今も「たまたま」側にある。
 *
 * **55 にしたのは、TTL より短い側に置いて余裕を持たせるためであり、厳密な最適値
 * ではない。** 55 という数字自体に根拠は無く、「60 より手前」だけが意味を持つ。
 * 60 分で保存済みの位相の上でこの値だけ変えても `dueFromSeed()` は錨から
 * `錨 + 新しい間隔` を計算し直すだけなので壊れない（次回が最大5分早まるか、
 * 既存の「1回だけ拾う」取りこぼし救済に乗るかのどちらかで、多重発火はしない）。
 *
 * ⚠️⚠️ **この値が意味を持つための必須条件: キャッシュ TTL が1時間であること。**
 * Anthropic の `cache_control: {type: "ephemeral", ttl}` の既定は **5分**で、
 * 1時間にするには `ttl: "1h"` の明示指定が要る（依存の `@anthropic-ai/sdk` の
 * `CacheControlEphemeral.ttl` 型定義に明記）。**もし alteroid の SDK 呼び出しが
 * 1時間を明示していなければ、キャッシュは5分で死んでおり、55分も60分も同じく
 * 完全に冷えていて、この値を変える意味は無い。** 読める JS
 * （`@anthropic-ai/claude-agent-sdk` の `bridge.mjs` / `sdk.mjs`）には
 * `cache_control` の文字列そのものが無く、どちらを明示しているかはコードから
 * 確認できていない。根拠は台帳の実測2件（`layer=clone` の `site=session` と
 * `site=distill` に opus-5 の単価を当てて誤差 0.4% 以内で一致）だけであり、
 * **5分 TTL（書き 1.25 倍）と1時間 TTL（書き 2 倍）は 60% 差なので、この一致は
 * 仮説を識別できるだけの精度を持つ**（内訳と、いま歯にできない理由・どうすれば
 * 検証可能にできるかは PR #101 の本文に書いた）。**TTL が変わればこの値は無意味に
 * なる**ので、次に触る者はまずこの前提が今も成り立つかを確かめること。
 *
 * **実行時にこの値が効くのは、環境変数 `ALTEROID_INITIATIVE_EVERY` が未設定の
 * ときだけ。** `compose.yaml` の `${ALTEROID_INITIATIVE_EVERY:-55}` は必ずこの
 * 定数と揃えること — 別の値で固定すると、compose 経由の起動ではこの定数が一度も
 * 使われない（`readScheduleConfig` の `rawEvery !== undefined` 側に必ず入る）。
 */
export const DEFAULT_INITIATIVE_EVERY_MINUTES = 55;
export const DEFAULT_REPORT_LOOKBACK_DAYS = 3;

const OFF = new Set(['off', 'none', 'false', '0']);

export function readScheduleConfig(env: NodeJS.ProcessEnv = process.env): ScheduleConfig {
  const notes: string[] = [];

  const rawAt = value(env.ALTEROID_DAILY_REPORT_AT);
  let dailyReportAt: TimeOfDay | null = parseTimeOfDay(DEFAULT_DAILY_REPORT_AT);
  if (rawAt !== undefined) {
    if (OFF.has(rawAt.toLowerCase())) {
      dailyReportAt = null;
    } else {
      const parsed = parseTimeOfDay(rawAt);
      if (parsed === null) {
        notes.push(
          `ALTEROID_DAILY_REPORT_AT="${rawAt}" は HH:MM として読めないので既定 ${DEFAULT_DAILY_REPORT_AT} を使う`,
        );
      } else {
        dailyReportAt = parsed;
      }
    }
  }

  const rawEvery = value(env.ALTEROID_INITIATIVE_EVERY);
  let initiativeEveryMinutes: number | null = DEFAULT_INITIATIVE_EVERY_MINUTES;
  if (rawEvery !== undefined) {
    if (OFF.has(rawEvery.toLowerCase())) {
      initiativeEveryMinutes = null;
    } else {
      const parsed = Number(rawEvery);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        notes.push(
          `ALTEROID_INITIATIVE_EVERY="${rawEvery}" は分数として読めないので既定 ${DEFAULT_INITIATIVE_EVERY_MINUTES} を使う`,
        );
      } else {
        initiativeEveryMinutes = parsed;
      }
    }
  }

  const rawLookback = value(env.ALTEROID_REPORT_LOOKBACK_DAYS);
  let reportLookbackDays = DEFAULT_REPORT_LOOKBACK_DAYS;
  if (rawLookback !== undefined) {
    const parsed = Number(rawLookback);
    if (!Number.isFinite(parsed) || parsed < 0) {
      notes.push(
        `ALTEROID_REPORT_LOOKBACK_DAYS="${rawLookback}" は日数として読めないので既定 ${DEFAULT_REPORT_LOOKBACK_DAYS} を使う`,
      );
    } else {
      reportLookbackDays = Math.floor(parsed);
    }
  }

  return { dailyReportAt, initiativeEveryMinutes, reportLookbackDays, notes };
}

export function buildSchedule(config: ScheduleConfig): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  if (config.dailyReportAt !== null) {
    entries.push(dailyReportEntry({ at: config.dailyReportAt }));
  }
  if (config.initiativeEveryMinutes !== null) {
    entries.push(selfInitiativeEntry({ everyMinutes: config.initiativeEveryMinutes }));
  }
  return entries;
}

function value(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}
