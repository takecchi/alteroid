import { describe, expect, it } from 'vitest';

import { commitmentFor } from './clone.js';
import type { Commitment, InboxEvent } from './schema.js';
import type { CommitmentList } from './store.js';
import { countSupersedingReports, describeSuperseded } from './superseded.js';

const MANAGER = 'mgr-1';

function report(
  id: string,
  at: string,
  managerId: string = MANAGER,
  text = '終わった',
): Commitment {
  return { id, at, origin: 'manager', source: managerId, body: `[report] ${text}` };
}

function question(id: string, at: string, managerId: string = MANAGER): Commitment {
  return { id, at, origin: 'manager', source: managerId, body: '[question] どっちですか' };
}

function permission(id: string, at: string, managerId: string = MANAGER): Commitment {
  return { id, at, origin: 'manager', source: managerId, body: '[permission] 実行してよいか' };
}

function list(
  entries: Commitment[],
  extra?: Partial<Omit<CommitmentList, 'entries'>>,
): CommitmentList {
  return { entries, unreadable: [], trimmedClosed: 0, ...extra };
}

const AFTER_ATS = ['2026-09-09T11:00:00Z'];

describe('countSupersedingReports', () => {
  it('後続の報告が3件在れば superseded で件数と最新の時刻を名乗る', () => {
    const decision = countSupersedingReports({
      list: list([
        report('r1', '2026-09-09T11:00:01Z'),
        report('r2', '2026-09-09T12:00:00Z'),
        report('r3', '2026-09-09T11:30:00Z'),
      ]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision).toEqual({
      kind: 'superseded',
      reports: 3,
      latestAt: '2026-09-09T12:00:00Z',
      uncertain: undefined,
    });
  });

  it('オフセット付きの時刻（+09:00）でも辞書順に惑わされない（同じ瞬間は「後続」に数えない）', () => {
    const decision = countSupersedingReports({
      list: list([report('same-instant', '2026-09-09T19:00:00+09:00')]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('batch 自身の行は「後続」に数えない（excludeIds と基準時刻の両方が効く）', () => {
    const decision = countSupersedingReports({
      list: list([report('batch-own', '2026-09-09T12:00:00Z')]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(['batch-own']),
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('別の委譲（source が違う）の報告を数えない', () => {
    const decision = countSupersedingReports({
      list: list([report('other-manager', '2026-09-09T12:00:00Z', 'mgr-2')]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('question / permission の行を数えない（report だけを見る）', () => {
    const decision = countSupersedingReports({
      list: list([
        question('q1', '2026-09-09T12:00:00Z'),
        permission('p1', '2026-09-09T12:30:00Z'),
      ]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision).toEqual({ kind: 'none' });
  });

  it('0件・障害なし ⟹ none で、describeSuperseded は空文字を返す', () => {
    const decision = countSupersedingReports({
      list: list([]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision).toEqual({ kind: 'none' });
    expect(describeSuperseded(decision, MANAGER)).toBe('');
  });

  it('0件だが unreadable が非0 ⟹ uncountable（黙らない）', () => {
    const decision = countSupersedingReports({
      list: list([], { unreadable: [{ reason: '壊れている行' }] }),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    const message = [
      'この歯が守っているのは「沈黙 ＝ 0 件と数え切れた」という調停である。',
      '`list.unreadable` が非0のとき、読めなかった行の中に後続の報告が' +
        '紛れている可能性を排除できないので、`kind` は `none` ではなく' +
        '`uncountable` でなければならない。',
      '',
      `実測: decision.kind = ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、沈黙が「0 件」を意味しなくなった。断り書きを短くするより先に、' +
        '沈黙の意味を決め直せ。',
    ].join('\n');
    expect(decision.kind, message).toBe('uncountable');
  });

  it('0件だが trimmedClosed が非0 ⟹ uncountable（黙らない）', () => {
    const decision = countSupersedingReports({
      list: list([], { trimmedClosed: 3 }),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    const message = [
      'この歯が守っているのは「沈黙 ＝ 0 件と数え切れた」という調停である。',
      '`list.trimmedClosed` が非0のとき、保持上限を超えて物理削除された' +
        '片付き行の中に後続の報告が在った可能性を排除できないので、`kind` は' +
        '`none` ではなく `uncountable` でなければならない。',
      '',
      `実測: decision.kind = ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、沈黙が「0 件」を意味しなくなった。断り書きを短くするより先に、' +
        '沈黙の意味を決め直せ。',
    ].join('\n');
    expect(decision.kind, message).toBe('uncountable');
  });

  it('0件だが at が壊れている行が在る ⟹ uncountable（黙らない）', () => {
    const decision = countSupersedingReports({
      list: list([report('broken-at', 'not-a-date')]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    const message = [
      'この歯が守っているのは「沈黙 ＝ 0 件と数え切れた」という調停である。',
      '対象の行の `at` が `Date.parse` できないとき、それが `afterMs` より' +
        '後かどうかを判定できないので、`kind` は `none` ではなく' +
        '`uncountable` でなければならない。',
      '',
      `実測: decision.kind = ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、沈黙が「0 件」を意味しなくなった。断り書きを短くするより先に、' +
        '沈黙の意味を決め直せ。',
    ].join('\n');
    expect(decision.kind, message).toBe('uncountable');
  });

  it('1件以上あって障害も在る ⟹ superseded のまま、「これより多い可能性がある」が出る（件数の情報を捨てない）', () => {
    const decision = countSupersedingReports({
      list: list([report('r1', '2026-09-09T12:00:00Z')], {
        unreadable: [{ reason: '壊れている行' }],
      }),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });
    expect(decision.kind).toBe('superseded');
    if (decision.kind !== 'superseded') throw new Error('unreachable');
    expect(decision.reports).toBe(1);
    expect(decision.uncertain).toContain('読めない行が 1 件');

    const text = describeSuperseded(decision, MANAGER);
    expect(text).toContain('これより多い可能性がある');
    expect(text).toContain('報告が 1 件届いている');
  });
  it('基準時刻（いま配っている合図の at）が読めなければ uncountable（全部を「後続」に数えない）', () => {
    const decision = countSupersedingReports({
      list: list([report('c-1', '2026-09-09T12:00:00Z')]),
      managerId: MANAGER,
      afterAts: ['2026-09-09T11:00:00Z', 'まったく時刻ではない'],
      excludeIds: new Set(),
    });
    const message = [
      'この歯が守っているのは「沈黙 ＝ 0 件と数え切れた」という調停の、基準側である。',
      '基準時刻が読めないまま数えると、基準が -Infinity へ倒れて' +
        'この委譲の報告が全部「後続」に見える ⟹ 0 件へ倒すのと同じく嘘になる。',
      '',
      `実測: ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、沈黙が「0 件」を意味しなくなった。断り書きを短くするより先に、' +
        '沈黙の意味を決め直せ。',
    ].join('\n');
    expect(decision.kind, message).toBe('uncountable');
  });

  it('基準時刻が1つも無ければ uncountable（manager_message が batch に無い形）', () => {
    const decision = countSupersedingReports({
      list: list([report('c-1', '2026-09-09T12:00:00Z')]),
      managerId: MANAGER,
      afterAts: [],
      excludeIds: new Set(),
    });
    const message = [
      '基準が空のとき、`afterMs` は -Infinity のままである ⟹ 数えれば全部が' +
        '「後続」になる。数えずに「数えられなかった」と名乗ること。',
      '',
      `実測: ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、沈黙が「0 件」を意味しなくなった。断り書きを短くするより先に、' +
        '沈黙の意味を決め直せ。',
    ].join('\n');
    expect(decision.kind, message).toBe('uncountable');
  });
});

function managerReportEvent(
  id: string,
  at: string,
  managerId: string = MANAGER,
  text = '終わった',
): InboxEvent {
  return { type: 'manager_message', id, at, managerId, kind: 'report', text };
}

describe('commitmentFor と countSupersedingReports の接頭辞の一致（issue #872）', () => {
  it('commitmentFor が組んだ report 行を countSupersedingReports が superseded として数える', () => {
    const commitment = commitmentFor(managerReportEvent('r1', '2026-09-09T12:00:00Z'));
    expect(commitment).not.toBeNull();

    const decision = countSupersedingReports({
      list: list([commitment as Commitment]),
      managerId: MANAGER,
      afterAts: AFTER_ATS,
      excludeIds: new Set(),
    });

    const message = [
      'この歯は commitmentFor（clone.ts）が組む body の接頭辞と、',
      'countSupersedingReports（superseded.ts）が読む接頭辞が一致していることを守っている。',
      '他のテストは全部 [report] 接頭辞を手で書き写したフィクスチャを使っており、',
      'commitmentFor の接頭辞の組み立てが変わってもそちらは赤くならない。',
      '',
      `実測: decision = ${JSON.stringify(decision)}`,
      '',
      'この歯が赤いなら、commitmentFor と countSupersedingReports の接頭辞が食い違った。',
    ].join('\n');
    expect(decision.kind, message).toBe('superseded');
    if (decision.kind !== 'superseded') throw new Error('unreachable');
    expect(decision.reports, message).toBe(1);
    expect(decision.latestAt, message).toBe('2026-09-09T12:00:00Z');
  });
});

describe('describeSuperseded', () => {
  it('superseded の文面には委譲の名前・件数・最新時刻・断りの3点が入る', () => {
    const text = describeSuperseded(
      { kind: 'superseded', reports: 2, latestAt: '2026-09-09T12:00:00Z', uncertain: undefined },
      MANAGER,
    );
    expect(text).toContain(`この委譲（${MANAGER}）`);
    expect(text).toContain('報告が 2 件届いている');
    expect(text).toContain('2026-09-09T12:00:00Z');
    expect(text).toContain('新しい報告が在る');
    expect(text).toContain('要らない');
    expect(text).not.toContain('これより多い可能性がある');
  });

  it('uncountable の文面は「0 件」と「数えられなかった」を区別する', () => {
    const text = describeSuperseded({ kind: 'uncountable', detail: 'テスト用の理由' }, MANAGER);
    expect(text).toContain('数えられなかった');
    expect(text).toContain('テスト用の理由');
    expect(text).toContain('「0 件」ではなく');
  });
});
