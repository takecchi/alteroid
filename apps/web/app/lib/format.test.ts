import { describe, expect, it } from 'vitest';

import { formatBytes, formatDateTime, formatRelative } from './format.js';

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
