import { describe, expect, it } from 'vitest';

import {
  archiveIdBranch,
  compareArchiveEntriesNewestFirst,
  matchArchiveIdStamp,
} from './archive-id.js';

describe('archiveIdBranch（#908）', () => {
  it('枝番が無い id（1本目）は1', () => {
    expect(archiveIdBranch('session-a-2026-09-23T13-27-27-123Z.jsonl')).toBe(1);
  });

  it('枝番付きの id はその数値を返す', () => {
    expect(archiveIdBranch('session-a-2026-09-23T13-27-27-123Z-2.jsonl')).toBe(2);
  });

  it('2桁の枝番は数値として比較できる（-10 は -9 より大きい。字面比較ではない）', () => {
    const branch9 = archiveIdBranch('session-a-2026-09-23T13-27-27-123Z-9.jsonl');
    const branch10 = archiveIdBranch('session-a-2026-09-23T13-27-27-123Z-10.jsonl');
    expect(branch9).toBe(9);
    expect(branch10).toBe(10);
    expect(branch10).toBeGreaterThan(branch9);
    // 字面（文字列）比較だと '-10.jsonl' < '-9.jsonl' になる（'1' < '9'）。
    // 数値として比較しなければこの逆転が起きることを、ここでも確認しておく。
    expect(
      'session-a-2026-09-23T13-27-27-123Z-10.jsonl' < 'session-a-2026-09-23T13-27-27-123Z-9.jsonl',
    ).toBe(true);
  });

  it('sessionId 自体に数字やハイフンが含まれていても、末尾のスタンプ+枝番だけを見る', () => {
    expect(archiveIdBranch('session-42-2026-09-23T13-27-27-123Z.jsonl')).toBe(1);
    expect(archiveIdBranch('session-42-2026-09-23T13-27-27-123Z-3.jsonl')).toBe(3);
  });

  it('パターンに一致しない id は1（想定外の名前をいちばん古い側へ寄せる）', () => {
    expect(archiveIdBranch('not-a-real-archive-id')).toBe(1);
    expect(archiveIdBranch('session-fingerprintless-12345')).toBe(1);
  });
});

describe('matchArchiveIdStamp（#908）', () => {
  it('枝番の無いidはbranch=1・stamp/suffixを返す', () => {
    const result = matchArchiveIdStamp('session-a-2026-09-23T13-27-27-123Z.jsonl');
    expect(result).toEqual({
      suffix: '-2026-09-23T13-27-27-123Z.jsonl',
      stamp: '2026-09-23T13-27-27-123Z',
      branch: 1,
    });
  });

  it('枝番付きidはsuffixに枝番を含み、branchはその数値', () => {
    const result = matchArchiveIdStamp('session-a-2026-09-23T13-27-27-123Z-3.jsonl');
    expect(result).toEqual({
      suffix: '-2026-09-23T13-27-27-123Z-3.jsonl',
      stamp: '2026-09-23T13-27-27-123Z',
      branch: 3,
    });
  });

  it('一致しないidはundefined', () => {
    expect(matchArchiveIdStamp('not-a-real-archive-id')).toBeUndefined();
  });

  it('suffixの長さでsessionId部分を切り出せる(fallbackMetaと同じ使い方)', () => {
    const id = 'my-session-id-2026-09-23T13-27-27-123Z-2.jsonl';
    const result = matchArchiveIdStamp(id);
    expect(result).toBeDefined();
    const sessionId = id.slice(0, id.length - (result?.suffix.length ?? 0));
    expect(sessionId).toBe('my-session-id');
  });
});

describe('compareArchiveEntriesNewestFirst（#908）', () => {
  const entry = (sessionId: string, at: string, id: string) => ({ sessionId, at, id });

  it('at が違えば、新しい方（at が大きい方）が先', () => {
    const older = entry('s', '2026-09-23T00:00:00.000Z', 's-2026-09-23T00-00-00-000Z.jsonl');
    const newer = entry('s', '2026-09-23T00:00:01.000Z', 's-2026-09-23T00-00-01-000Z.jsonl');
    expect(compareArchiveEntriesNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareArchiveEntriesNewestFirst(older, newer)).toBeGreaterThan(0);
  });

  it('同じ at・同じ sessionId なら、枝番が大きい方（後から積んだ方）が先', () => {
    const stamp = '2026-09-23T00-00-00-000Z';
    const branch1 = entry('s', '2026-09-23T00:00:00.000Z', `s-${stamp}.jsonl`);
    const branch3 = entry('s', '2026-09-23T00:00:00.000Z', `s-${stamp}-3.jsonl`);
    expect(compareArchiveEntriesNewestFirst(branch3, branch1)).toBeLessThan(0);
    expect(compareArchiveEntriesNewestFirst(branch1, branch3)).toBeGreaterThan(0);
  });

  it('3本以上を降順ソートすると、積んだ順の逆（新しい枝番が先）になる（#908 の核心）', () => {
    const stamp = '2026-09-23T00-00-00-000Z';
    const w1 = entry('s', '2026-09-23T00:00:00.000Z', `s-${stamp}.jsonl`);
    const w2 = entry('s', '2026-09-23T00:00:00.000Z', `s-${stamp}-2.jsonl`);
    const w3 = entry('s', '2026-09-23T00:00:00.000Z', `s-${stamp}-3.jsonl`);
    const sorted = [w1, w3, w2].sort(compareArchiveEntriesNewestFirst);
    expect(sorted.map((e) => e.id)).toEqual([w3.id, w2.id, w1.id]);
  });

  it('at・sessionId とも同値なら sessionId 以外では決まらないので id の文字コード比較へ落ちる（決定的だが順序に意味はない）', () => {
    const a = entry('s', '2026-09-23T00:00:00.000Z', 'a-id');
    const b = entry('s', '2026-09-23T00:00:00.000Z', 'b-id');
    expect(compareArchiveEntriesNewestFirst(a, b)).toBeLessThan(0);
    expect(compareArchiveEntriesNewestFirst(b, a)).toBeGreaterThan(0);
    expect(compareArchiveEntriesNewestFirst(a, a)).toBe(0);
  });

  it('sessionId が違えば、at・枝番が同値でも sessionId で決まる（枝番の比較を跨がない）', () => {
    const at = '2026-09-23T00:00:00.000Z';
    const stamp = '2026-09-23T00-00-00-000Z';
    const highBranchOtherSession = entry('zzz', at, `zzz-${stamp}-9.jsonl`);
    const lowBranchThisSession = entry('aaa', at, `aaa-${stamp}.jsonl`);
    expect(
      compareArchiveEntriesNewestFirst(lowBranchThisSession, highBranchOtherSession),
    ).toBeLessThan(0);
  });
});
