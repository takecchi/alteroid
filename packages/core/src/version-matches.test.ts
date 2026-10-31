import { describe, expect, it, vi } from 'vitest';

import {
  memoryVersion,
  memoryVersionMatches,
  practiceVersion,
  practiceVersionMatches,
  scheduleVersionMatches,
  versionMatches,
} from './store.js';

describe('versionMatches（前提の版 ifMatch の照合）', () => {
  it('省略は常に合い、版の計算もしない', () => {
    const versionOf = vi.fn(() => 'v');
    expect(versionMatches(null, undefined, versionOf)).toBe(true);
    expect(versionMatches({}, undefined, versionOf)).toBe(true);
    expect(versionOf).not.toHaveBeenCalled();
  });

  it('null は「無いこと」が前提', () => {
    expect(versionMatches(null, null, () => 'v')).toBe(true);
    expect(versionMatches({}, null, () => 'v')).toBe(false);
  });

  it('文字列は、在って版が一致するときだけ合う', () => {
    expect(versionMatches({}, 'v', () => 'v')).toBe(true);
    expect(versionMatches({}, 'x', () => 'v')).toBe(false);
    expect(versionMatches(null, 'v', () => 'v')).toBe(false);
  });
});

describe('memoryVersionMatches / practiceVersionMatches / scheduleVersionMatches', () => {
  it('記憶: 版は本文の sha256', () => {
    const doc = { content: '本文\n' };
    expect(memoryVersionMatches(doc, memoryVersion('本文\n'))).toBe(true);
    expect(memoryVersionMatches(doc, 'stale')).toBe(false);
    expect(memoryVersionMatches(doc, null)).toBe(false);
    expect(memoryVersionMatches(doc, undefined)).toBe(true);
    expect(memoryVersionMatches(null, null)).toBe(true);
    expect(memoryVersionMatches(null, 'stale')).toBe(false);
    expect(memoryVersionMatches(null, undefined)).toBe(true);
  });

  it('やり方: 版は kind・title・content のハッシュ', () => {
    const practice = { kind: '実装', title: '題', content: '本文' };
    expect(practiceVersionMatches(practice, practiceVersion(practice))).toBe(true);
    expect(practiceVersionMatches(practice, 'stale')).toBe(false);
    expect(practiceVersionMatches(practice, null)).toBe(false);
    expect(practiceVersionMatches(practice, undefined)).toBe(true);
    expect(practiceVersionMatches(null, null)).toBe(true);
    expect(practiceVersionMatches(null, 'stale')).toBe(false);
  });

  it('予定: 版は updatedAt', () => {
    const entry = { updatedAt: '2026-01-01T00:00:00.000Z' };
    expect(scheduleVersionMatches(entry, entry.updatedAt)).toBe(true);
    expect(scheduleVersionMatches(entry, 'stale')).toBe(false);
    expect(scheduleVersionMatches(entry, null)).toBe(false);
    expect(scheduleVersionMatches(entry, undefined)).toBe(true);
    expect(scheduleVersionMatches(null, null)).toBe(true);
    expect(scheduleVersionMatches(null, 'stale')).toBe(false);
  });
});
