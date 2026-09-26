import { describe, expect, it } from 'vitest';

import { isRunningJobStatus, type JobStatusLike } from './job-status-running.js';
import { jobStatusSchema } from './schema.js';

describe('isRunningJobStatus（9回目の横断レビュー指摘の唯一の正本）', () => {
  it('running だけを実行中として数える', () => {
    expect(isRunningJobStatus('running')).toBe(true);
  });

  /**
   * **`waiting_human` を含む、既知の終端/非実行値はすべて false。**
   * `jobStatusSchema.options` から動的に取る——値を手で書き写すと、
   * `schema.ts` 側に選択肢が増えたときにこのテストだけが古びて
   * 「網羅した気になる」ことを防ぐ（増えた値は次の `it.each` の対象にも
   * 自動的に入る）。
   */
  it.each(jobStatusSchema.options.filter((status) => status !== 'running'))(
    '%s は実行中として数えない',
    (status) => {
      expect(isRunningJobStatus(status)).toBe(false);
    },
  );

  /**
   * **`jobStatusSchema` の全選択肢を、漏れなく `isRunningJobStatus` へ通す。**
   * 上の2つの `it` と合わせて `jobStatusSchema.options` の**すべて**が
   * どちらか一方の期待値で覆われることを保証する——`schema.ts` に新しい値が
   * 足されても、この `it.each` の対象には自動的に入る（`running` を含む
   * 6値すべてが `running` の1件か、直上の `it.each` の対象になる）。
   */
  it('jobStatusSchema の全選択肢がちょうど1つの分類に入る（running 1 + 非 running 5）', () => {
    const running = jobStatusSchema.options.filter((s) => isRunningJobStatus(s));
    const notRunning = jobStatusSchema.options.filter((s) => !isRunningJobStatus(s));
    expect(running).toEqual(['running']);
    expect(notRunning).toEqual(['waiting_human', 'done', 'failed', 'lost', 'stopped']);
    expect(running.length + notRunning.length).toBe(jobStatusSchema.options.length);
  });

  /**
   * ## 実行時の倒れ先（型では防げない、Web/デーモンの版のずれ）
   *
   * `jobStatusSchema` に無い値が来ても（デーモンが先に新しい値を返し、この
   * 関数を読み込んでいる側の型定義がまだ古い、という順序）、**安全側＝
   * 「実行中として数える」へ倒れる**——逆だと、この関数を作った理由そのもの
   * （新しい値が件数から静かに漏れる）が型のずれという別の経路で再現する。
   *
   * `as unknown as JobStatusLike` は意図的なキャスト——型が守っている境界の
   * 外から来た値を模している。
   */
  it('知らない値は安全側（実行中として数える）へ倒れる', () => {
    const unknownStatus = 'not-yet-invented-status' as unknown as JobStatusLike;
    expect(isRunningJobStatus(unknownStatus)).toBe(true);
  });
});
