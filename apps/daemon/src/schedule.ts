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
 * **60 ではない理由。** 導入時（PR #4, 1b6d67c）から 60 分だったが、60 を選んだ根拠は
 * コミットメッセージ・PR 本文・レビューコメント・docs のどこにも見つからなかった
 * （「既定値（22:00・60分）が妥当か」は当時から人間の確認待ちのまま残っていた。#96
 * 「既定の定期ジョブの位相が器の入れ替えで失われる」も 60 を既知の値として引用するだけで、
 * 由来には触れていない）。それとは別に、60 のままだと不利になる形が分かっている —
 * クローンが暇なときに目を覚ますのはちょうど tick の瞬間で、プロンプトキャッシュの TTL も
 * 60 分だと、目覚める瞬間とキャッシュが失効する瞬間が重なる。そのターンは文脈を全部
 * 書き直す最も高い1回になる。**しかもこの重なりは #96（`packages/core/src/schedule.ts`
 * の `#seedBase` / `dueFromSeed`）が位相を器の入れ替えを越えて永続化したことで、いま
 * 初めて本当に周期的になった。** #96 以前は再デプロイのたびに位相が `now + 周期` へ
 * 捨て直されていたので、この重なりは「起きたり起きなかったり」で、直す動機自体が弱かった
 * （#96 の本文にある実測: 器の入れ替えで発意が丸1時間先へずれた）。
 *
 * **55 にしたのは、TTL より短い側に置いて余裕を持たせるためであり、厳密な最適値ではない。**
 * 55 という数字自体に根拠はなく、「60 より手前」であることだけが意味を持つ。
 *
 * **#96 が永続化した位相との噛み合わせ。** 60 分で保存された位相
 * （`lastScheduledRunAt`）の上でこの値だけ 55 に変えても、`dueFromSeed()` は
 * 保存済みの錨から `錨 + 新しい間隔` を計算し直すだけなので壊れない — 次回が
 * 5分早まるか、その5分がすでに過ぎていれば「1回だけ拾う」既存の取りこぼし救済に
 * 乗るかのどちらかで、多重発火は起きない。
 *
 * ⚠️ **この値は「キャッシュ TTL が 60 分である」という、コードでは固定できない外部の
 * 事実に乗っている。** SDK は実体がコンパイル済みバイナリで、読める JS
 * （`@anthropic-ai/claude-agent-sdk` の `bridge.mjs` / `sdk.mjs`）には `cache_control`
 * の文字列が1件も無い（`ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` という
 * 使用量の集計フィールドはあるが、どちらの TTL で要求しているかはここからは分からない。
 * 依存の `@anthropic-ai/sdk` 側の型定義では `CacheControlEphemeral.ttl` の既定は `5m` で、
 * `1h` は明示指定が要るとある）。「TTL が60分」の根拠は台帳の実測2件（誤差0.4%以内）だけで、
 * このファイルのテストでは検証できていない。**TTL が変われば 55 という値に意味は無くなる**
 * ので、次に触る者はまずその前提が今も成り立つかを確かめること。
 *
 * **実行時にこの値が効くのは、環境変数 `ALTEROID_INITIATIVE_EVERY` が未設定のときだけ。**
 * `compose.yaml` の `${ALTEROID_INITIATIVE_EVERY:-55}` は必ずこの定数と揃えること —
 * 別の値で固定すると、compose 経由の起動ではこの定数が一度も使われない（`readScheduleConfig`
 * の `rawEvery !== undefined` 側に必ず入る）。
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
