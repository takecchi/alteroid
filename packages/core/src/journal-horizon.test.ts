import { describe, expect, it } from 'vitest';

import { journalWindowCrossesHorizon } from './journal-horizon.js';

/**
 * `journalWindowCrossesHorizon` — 日誌の窓が地平（`JournalStore.oldestAt()`）
 * より前にかかるかの判定（issue #1510 の積み残し）。
 *
 * **この判定は `journal_read`（`packages/core/src/tools.test.ts` の
 * 「journal_read が日誌の地平を伝える」）と `GET /journal`
 * （`apps/daemon/src/app.test.ts` の「GET /journal の日誌の地平」）の両方で
 * 間接的に測っているが、ここでは条件そのものを直接・単体で固定する** ——
 * 2箇所の統合テストが同じ答えを返すのは、どちらも同じこの関数を呼んでいる
 * からであって、条件を独立に2回実装しているからではないことの検算でもある。
 */
describe('journalWindowCrossesHorizon（issue #1510 の積み残し）', () => {
  it('oldestAt が null（日誌が空）なら、since に関わらず常に偽', () => {
    expect(journalWindowCrossesHorizon(null, undefined)).toBe(false);
    expect(journalWindowCrossesHorizon(null, '2020-01-01T00:00:00.000Z')).toBe(false);
  });

  it('since が未指定（窓の始点 -∞）なら、地平が在る限り常に真', () => {
    expect(journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', undefined)).toBe(true);
  });

  it('since が地平以降なら偽（窓はまるごと地平より後ろ）', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-16T00:00:00.000Z'),
    ).toBe(false);
  });

  it('since がちょうど地平と同じ瞬間なら偽（start >= oldestAt の境界）', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
    ).toBe(false);
  });

  it('since が地平より前なら真', () => {
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
    ).toBe(true);
  });

  it('since は時刻として比べる——秒省略・オフセット付きでも地平より前なら真', () => {
    // 地平の1分前の分の頭を、秒を省いた形で書く。辞書順だと
    // `'…:MMZ' > '…:MM:SS.sssZ'` になり、地平より後ろと取り違える。
    expect(journalWindowCrossesHorizon('2026-08-15T00:05:30.000Z', '2026-08-15T00:04Z')).toBe(true);
    // 地平（UTC 2026-08-15T00:00:00.000Z）の1時間前（UTC 2026-08-14T23:00:00Z）
    // を +09:00（JST）で書く。辞書順だと日付の桁（14 と 15）が食い違い、
    // 地平より後ろと取り違える。
    expect(
      journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', '2026-08-15T08:00:00+09:00'),
    ).toBe(true);
  });

  it('since が読めない文字列なら、判定できない側（真）へ倒す', () => {
    expect(journalWindowCrossesHorizon('2026-08-15T00:00:00.000Z', 'not-a-datetime')).toBe(true);
  });
});
