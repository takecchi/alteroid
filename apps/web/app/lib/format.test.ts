import { describe, expect, it } from 'vitest';

import {
  describeMemoryDescriptionDrift,
  formatBytes,
  formatDateTime,
  formatRelative,
} from './format.js';

const NOW = Date.parse('2026-08-13T12:00:00Z');

describe('formatRelative', () => {
  it('直近は「たった今」', () => {
    expect(formatRelative('2026-08-13T11:59:40Z', NOW)).toBe('たった今');
  });

  it('分・時間・日で丸める', () => {
    expect(formatRelative('2026-08-13T11:50:00Z', NOW)).toBe('10分前');
    expect(formatRelative('2026-08-13T09:00:00Z', NOW)).toBe('3時間前');
    expect(formatRelative('2026-08-11T12:00:00Z', NOW)).toBe('2日前');
  });

  it('未来（次の発火時刻）も表せる', () => {
    // スケジュール画面は「次はいつ」を出す。ここが前提だけを見ていると 0分前 になる。
    expect(formatRelative('2026-08-13T13:00:00Z', NOW)).toBe('1時間後');
  });

  it('解釈できない値はそのまま返す（握り潰して Invalid Date を出さない）', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('not-a-date');
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatBytes', () => {
  it('単位を切り替える', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

/**
 * #821 残課題: `MemoryDescriptionDrift`（3状態）の Web 側表示。
 * `packages/core/src/memory.test.ts` の同名の歯と同じ観点をここでも撃つ
 * ——`at-least` は `measured`（% つき）とも `unrecorded` とも別の言葉で出す。
 */
describe('describeMemoryDescriptionDrift', () => {
  it('measured は %つきで出す', () => {
    expect(
      describeMemoryDescriptionDrift({
        kind: 'measured',
        describedBytes: 1000,
        currentBytes: 1200,
        deltaBytes: 200,
      }),
    ).toBe('本文は+200バイト（+20%）変わった');
  });

  it('at-least は %を出さず、baselineAt も刷らない。measured / unrecorded とは別の言葉になる（#821 残課題）', () => {
    const atLeast = describeMemoryDescriptionDrift({
      kind: 'at-least',
      baselineBytes: 1000,
      baselineAt: '2026-08-20T12:00:00Z',
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const measured = describeMemoryDescriptionDrift({
      kind: 'measured',
      describedBytes: 1000,
      currentBytes: 1200,
      deltaBytes: 200,
    });
    const unrecorded = describeMemoryDescriptionDrift({ kind: 'unrecorded' });

    expect(atLeast).toBe('+200バイト以上変わった');
    expect(atLeast).not.toContain('%');
    expect(atLeast).not.toContain('2026-08-20T12:00:00Z');
    expect(atLeast).not.toBe(measured);
    expect(atLeast).not.toBe(unrecorded);
  });

  it('unrecorded は「記録されていない」と言う（0バイトと混ぜない）', () => {
    expect(describeMemoryDescriptionDrift({ kind: 'unrecorded' })).toBe(
      '本文の変化量は記録されていない',
    );
  });
});
