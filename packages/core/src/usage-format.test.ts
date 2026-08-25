import { describe, expect, it } from 'vitest';

import {
  describeUnrecordedManagers,
  findUnrecordedManagers,
  type UnrecordedManagerCandidate,
} from './usage-format.js';

/**
 * 「台帳が取りこぼした委譲」（Issue #98）の突き合わせと整形。
 *
 * **判定は「台帳に1行も無いか」の1つだけ。** `status` では絞らない——途中まで
 * 記録が在る委譲は取りこぼしではない、という Issue の制約をここで固定する。
 */

function manager(over: Partial<UnrecordedManagerCandidate> & { managerId: string }) {
  return {
    status: 'running' as const,
    startedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

describe('findUnrecordedManagers', () => {
  it('台帳に行が在る managerId を除く', () => {
    const managers = [manager({ managerId: 'mgr-a' }), manager({ managerId: 'mgr-b' })];
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-b']);
  });

  /**
   * **`status` は絞り込みには使わない。** `running` / `done` / `lost` のどれでも、
   * 台帳に行が無ければ同じく取りこぼしとして数える——途中まで記録が在る委譲だけが
   * 「取りこぼしではない」側であって、それは `recordedManagerIds` に載っている
   * ことで表現される（`status` では表せない・表さない）。
   */
  it('status では絞らない（running / done / lost のどれでも、行が無ければ数える）', () => {
    const managers = [
      manager({ managerId: 'mgr-running', status: 'running' }),
      manager({ managerId: 'mgr-done', status: 'done' }),
      manager({ managerId: 'mgr-lost', status: 'lost' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-done', 'mgr-lost', 'mgr-running']);
  });

  /**
   * **`since` より前に立った委譲は数えない。** あれは「記録が無い」ではなく
   * 「台帳が無かった」で、その但し書きは `beforeLedger` が持つ（Issue #98）。
   */
  it('since より前に createdAt を持つ委譲は数えない', () => {
    const managers = [
      manager({ managerId: 'mgr-before-ledger', startedAt: '2026-07-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-after-ledger', startedAt: '2026-08-15T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-after-ledger']);
  });

  /**
   * `since` ちょうどの委譲は「台帳が始まった後」として数える（`>=`）。
   */
  it('startedAt が since と同じ瞬間なら数える（境界は含む）', () => {
    const managers = [manager({ managerId: 'mgr-on-boundary', startedAt: '2026-08-01T00:00:00.000Z' })];
    const result = findUnrecordedManagers(managers, new Set(), '2026-08-01T00:00:00.000Z');

    expect(result.map((m) => m.managerId)).toEqual(['mgr-on-boundary']);
  });

  /**
   * `since` が `null`（台帳がまだ1件も記録していない）なら、比べる相手が無いので
   * 誰も除外しない——渡された委譲全員がそのまま対象になる。
   */
  it('since が null なら誰も除外しない', () => {
    const managers = [
      manager({ managerId: 'mgr-a', startedAt: '2020-01-01T00:00:00.000Z' }),
      manager({ managerId: 'mgr-b', startedAt: '2026-08-20T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId).sort()).toEqual(['mgr-a', 'mgr-b']);
  });

  /**
   * ⚠️ この歯が測っているのは「関数に全期間の集合を渡せば正しく答える」ことまでで
   * ある。呼び出し側（`app.ts` / `tools.ts`）が実際に `UsageStore.
   * recordedManagerIds()`（引数を持たない・全期間）を渡しているかどうかは、
   * この歯では測れない——そちらは `apps/daemon/src/app.test.ts` の
   * 「期間で絞っても取りこぼしの数が変わらない」歯が持つ。
   *
   * ここで確かめるのは、**関数自身が `recordedManagerIds` を絞り込みの材料として
   * 受け取っていない**（引数はそのまま素通しで使う）ことだけである——`since` 以外の
   * 期間の概念をこの関数は一切持たない。
   */
  it('recordedManagerIds に載っていれば、startedAt が最近でも除外する', () => {
    const managers = [manager({ managerId: 'mgr-a', startedAt: '2026-08-25T00:00:00.000Z' })];
    // 「照会範囲の外で記録された」ことを模す——この managerId は全期間の集合には
    // 載っているが、いま照会している期間の rows には出てこないかもしれない。
    // それでもここでは除外されるべきである（別の期間の record で載った集合を
    // そのまま渡している、という契約）。
    const result = findUnrecordedManagers(managers, new Set(['mgr-a']), '2026-08-01T00:00:00.000Z');

    expect(result).toEqual([]);
  });

  it('startedAt の昇順で返す', () => {
    const managers = [
      manager({ managerId: 'mgr-later', startedAt: '2026-08-20T00:00:00.000Z' }),
      manager({ managerId: 'mgr-earlier', startedAt: '2026-08-10T00:00:00.000Z' }),
    ];
    const result = findUnrecordedManagers(managers, new Set(), null);

    expect(result.map((m) => m.managerId)).toEqual(['mgr-earlier', 'mgr-later']);
  });
});

describe('describeUnrecordedManagers', () => {
  /**
   * **0件のときも黙らない。** 空配列は「取りこぼしが無い」であって「調べていない」
   * ではない（AGENTS.md の地雷表）——そう読める形で、0件でも必ず1行返す。
   */
  it('0件のときは「0件」と明示する（黙らない）', () => {
    const lines = describeUnrecordedManagers([]);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('0件');
  });

  it('1件以上のときは managerId と status と起こした時刻を出す', () => {
    const lines = describeUnrecordedManagers([
      { managerId: 'mgr-x', status: 'running', startedAt: '2026-08-25T13:20:00.000Z' },
    ]);
    const text = lines.join('\n');

    expect(text).toContain('mgr-x');
    expect(text).toContain('running');
    expect(text).toContain('2026-08-25T13:20:00.000Z');
    expect(text).toContain('1件');
  });
});
