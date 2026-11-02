import { describe, expect, it } from 'vitest';

import { LEASE_MARGIN_MS } from './lease.js';
import type { RunnerEntry } from './runner-protocol.js';
import {
  judgeClaimAgainst,
  lastSeenAtOf,
  movedAwayOf,
  registeredRunnerIdsOf,
  runnerSessionsOf,
  runnerSwappedSince,
  shouldRelocateFromRoster,
  sightingOf,
  silentRunnersOf,
  swapNoteOf,
} from './runner-roster.js';

function entry(over: Partial<RunnerEntry> = {}): RunnerEntry {
  return {
    label: 'l',
    state: 'connected',
    since: '2026-01-01T00:00:00.000Z',
    revision: { status: 'unheard' },
    ...over,
  };
}

describe('silentRunnersOf', () => {
  it.each([
    ['空の名簿', [], []],
    ['lost だけを採る', [entry({ runnerId: 'a', state: 'lost', since: 'T1' })], [['a', 'T1']]],
    [
      'lost 以外は採らない',
      (['connecting', 'connected', 'unreachable', 'unusable', 'vacating'] as const).map((state) =>
        entry({ runnerId: 'a', state }),
      ),
      [],
    ],
    ['runnerId の無い lost は採らない', [entry({ state: 'lost' })], []],
  ] as const)('%s', (_name, entries, expected) => {
    expect([...silentRunnersOf(entries)]).toEqual(expected);
  });
});

describe('registeredRunnerIdsOf', () => {
  it('空の名簿は空集合（null ではない）', () => {
    expect(registeredRunnerIdsOf([])).toEqual(new Set());
  });
  it('state を問わず runnerId を集める', () => {
    const ids = registeredRunnerIdsOf([
      entry({ runnerId: 'a', state: 'lost' }),
      entry({ runnerId: 'b' }),
    ]);
    expect(ids).toEqual(new Set(['a', 'b']));
  });
  it('名乗っていない行が1本でも在れば null', () => {
    expect(registeredRunnerIdsOf([entry({ runnerId: 'a' }), entry()])).toBeNull();
  });
});

describe('runnerSessionsOf', () => {
  it('sessions と観測時刻が揃った行だけを数える', () => {
    const seen = runnerSessionsOf([
      entry({ runnerId: 'a', sessions: ['x'] }),
      entry({ runnerId: 'b', sessionsObservedAt: 'T' }),
      entry({ sessions: ['z'], sessionsObservedAt: 'T' }),
      entry({ runnerId: 'c', sessions: [], sessionsObservedAt: 'T3' }),
    ]);
    expect([...seen.keys()]).toEqual(['c']);
    expect(seen.get('c')).toEqual({ ids: new Set(), observedAt: 'T3' });
  });
  it('同じ runnerId の行は和を採り、新しい観測時刻を残す', () => {
    const seen = runnerSessionsOf([
      entry({ runnerId: 'a', sessions: ['x'], sessionsObservedAt: '2026-01-02' }),
      entry({ runnerId: 'a', sessions: ['y'], sessionsObservedAt: '2026-01-03' }),
      entry({ runnerId: 'a', sessions: [], sessionsObservedAt: '2026-01-01' }),
    ]);
    expect(seen.get('a')).toEqual({ ids: new Set(['x', 'y']), observedAt: '2026-01-03' });
  });
  it('観測時刻が同じなら動かさない', () => {
    const seen = runnerSessionsOf([
      entry({ runnerId: 'a', sessions: ['x'], sessionsObservedAt: 'T' }),
      entry({ runnerId: 'a', sessions: ['y'], sessionsObservedAt: 'T' }),
    ]);
    expect(seen.get('a')?.observedAt).toBe('T');
  });
});

describe('sightingOf', () => {
  it('名簿に居なければ runnerId だけ', () => {
    expect(sightingOf([entry({ runnerId: 'other' })], 'a')).toEqual({ runnerId: 'a' });
  });
  it('2台以上なら instanceId を採らず台数を返す', () => {
    expect(
      sightingOf(
        [entry({ runnerId: 'a', instanceId: 'i1' }), entry({ runnerId: 'a', instanceId: 'i2' })],
        'a',
      ),
    ).toEqual({ runnerId: 'a', duplicates: 2 });
  });
  it('1台なら instanceId と instanceSince（ms）を返す', () => {
    expect(
      sightingOf(
        [entry({ runnerId: 'a', instanceId: 'i', instanceSince: '2026-01-01T00:00:01.000Z' })],
        'a',
      ),
    ).toEqual({
      runnerId: 'a',
      instanceId: 'i',
      instanceSince: Date.parse('2026-01-01T00:00:01.000Z'),
    });
  });
  it('読めない instanceSince と無い instanceId は載せない', () => {
    expect(sightingOf([entry({ runnerId: 'a', instanceSince: 'not-a-date' })], 'a')).toEqual({
      runnerId: 'a',
    });
  });
});

describe('shouldRelocateFromRoster', () => {
  it.each([
    ['行が0本', [], false],
    ['lost', [entry({ runnerId: 'a', state: 'lost' })], true],
    ['vacating', [entry({ runnerId: 'a', state: 'vacating' })], true],
    ['connected', [entry({ runnerId: 'a' })], false],
    [
      'lost と connected が並ぶ',
      [entry({ runnerId: 'a', state: 'lost' }), entry({ runnerId: 'a' })],
      false,
    ],
    [
      'lost と vacating が並ぶ',
      [entry({ runnerId: 'a', state: 'lost' }), entry({ runnerId: 'a', state: 'vacating' })],
      true,
    ],
    ['別の runnerId の lost は見ない', [entry({ runnerId: 'b', state: 'lost' })], false],
  ] as const)('%s', (_name, entries, expected) => {
    expect(shouldRelocateFromRoster(entries, 'a')).toBe(expected);
  });
});

describe('lastSeenAtOf', () => {
  it('行が無い・時刻が無い・読めないときは undefined', () => {
    expect(lastSeenAtOf([], 'a')).toBeUndefined();
    expect(lastSeenAtOf([entry({ runnerId: 'a' })], 'a')).toBeUndefined();
    expect(lastSeenAtOf([entry({ runnerId: 'a', lastSeenAt: 'x' })], 'a')).toBeUndefined();
  });
  it('複数行は遅い方を採り、別の runnerId は見ない', () => {
    const late = '2026-01-03T00:00:00.000Z';
    expect(
      lastSeenAtOf(
        [
          entry({ runnerId: 'a', lastSeenAt: '2026-01-02T00:00:00.000Z' }),
          entry({ runnerId: 'a', lastSeenAt: late }),
          entry({ runnerId: 'b', lastSeenAt: '2026-02-01T00:00:00.000Z' }),
        ],
        'a',
      ),
    ).toBe(Date.parse(late));
  });
});

describe('judgeClaimAgainst', () => {
  const grantedAt = '2026-01-01T00:00:00.000Z';
  const lease = {
    runnerId: 'holder',
    fence: 1,
    grantedAt,
    seenAt: grantedAt,
    ttlMs: 1000,
  };
  const deadline = Date.parse(grantedAt) + 1000 + LEASE_MARGIN_MS;

  it('貸し出しが無ければ unheld', () => {
    expect(judgeClaimAgainst([], undefined, 'me', 0).kind).toBe('unheld');
  });
  it('別の持ち主で期限の前は held、期限ちょうどで expired', () => {
    expect(judgeClaimAgainst([], lease, 'me', deadline - 1)).toMatchObject({
      kind: 'held',
      claimableAt: deadline,
    });
    expect(judgeClaimAgainst([], lease, 'me', deadline).kind).toBe('expired');
  });
  it('持ち主の最後の名乗りが期限を先送りする', () => {
    const seen = '2026-01-01T00:10:00.000Z';
    const later = Date.parse(seen) + 1000 + LEASE_MARGIN_MS;
    const entries = [entry({ runnerId: 'holder', lastSeenAt: seen })];
    expect(judgeClaimAgainst(entries, lease, 'me', deadline)).toMatchObject({
      kind: 'held',
      claimableAt: later,
    });
  });
  it('宛先が併存していれば ambiguous', () => {
    const entries = [entry({ runnerId: 'me' }), entry({ runnerId: 'me' })];
    expect(judgeClaimAgainst(entries, lease, 'me', 0)).toMatchObject({
      kind: 'ambiguous',
      runnerId: 'me',
      duplicates: 2,
    });
  });
});

describe('runnerSwappedSince', () => {
  it.each([
    ['sessionInstanceId と同じ', { sessionInstanceId: 'i' }, 'i', false],
    ['sessionInstanceId と違う', { sessionInstanceId: 'i' }, 'j', true],
    ['記録が無ければ判定できない', {}, 'j', false],
    ['応えている側が名乗らない', { sessionInstanceId: 'i' }, undefined, false],
    ['sessionInstanceId が無い古い行は貸し出しへ落ちる', { lease: { instanceId: 'l' } }, 'm', true],
    [
      'sessionInstanceId が在れば貸し出しは見ない',
      { sessionInstanceId: 'i', lease: { instanceId: 'l' } },
      'i',
      false,
    ],
  ] as const)('%s', (_name, job, answering, expected) => {
    expect(runnerSwappedSince(job as never, answering)).toBe(expected);
  });
});

describe('swapNoteOf', () => {
  it('どちらかが無ければ判定できないと言う', () => {
    const note = 'runner の器の入れ替えの前後かは判定できない（instanceId を名乗っていない）';
    expect(swapNoteOf(undefined, 'b')).toBe(note);
    expect(swapNoteOf('a', undefined)).toBe(note);
  });
  it('同じなら入れ替わっていない', () => {
    expect(swapNoteOf('a', 'a')).toBe('runner の器は入れ替わっていない（instanceId=a）');
  });
  it('違えば前後の id を添える', () => {
    expect(swapNoteOf('after', 'before')).toBe(
      'runner の器が入れ替わっていた（参照を受けた時の instanceId=before、取りに行った時=after）。預けたプロセスは既に居ない',
    );
  });
});

describe('movedAwayOf', () => {
  const registered = new Set(['a', 'b']);
  it.each([
    ['宛先が未記録', undefined, 'a', registered, false],
    ['同じ宛先', 'a', 'a', registered, false],
    ['名簿が判定不能', 'b', 'a', null, false],
    ['名簿に居ない宛先', 'z', 'a', registered, false],
    ['別の宛先が名簿に居る', 'b', 'a', registered, true],
  ] as const)('%s', (_name, jobRunnerId, from, ids, expected) => {
    expect(movedAwayOf(jobRunnerId, from, ids)).toBe(expected);
  });
});
