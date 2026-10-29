import { afterEach, describe, expect, it } from 'vitest';

import { clearRecentTracesForTesting, recentDroppedTraces } from './dropped-record.js';
import {
  clearTokenSavingNotesForTesting,
  resolveTokenSavingCompaction,
  resolveTokenSavingExcerpt,
  resolveTokenSavingFoldFixedText,
  resolveTokenSavingSwitches,
  TOKEN_SAVING_COMPACTION_ENV,
  TOKEN_SAVING_EXCERPT_ENV,
  TOKEN_SAVING_FOLD_FIXED_TEXT_ENV,
} from './token-saving-switches.js';

afterEach(() => {
  clearRecentTracesForTesting();
  clearTokenSavingNotesForTesting();
});

describe('トークン節約スイッチの既定', () => {
  it('⭐ 環境が空なら、畳み・compaction は無効、抜粋は有効', () => {
    expect(resolveTokenSavingSwitches({})).toEqual({
      foldFixedText: false,
      compaction: false,
      excerpt: true,
    });
  });

  it('変数名は仕様どおり', () => {
    expect(TOKEN_SAVING_FOLD_FIXED_TEXT_ENV).toBe('ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT');
    expect(TOKEN_SAVING_COMPACTION_ENV).toBe('ALTEROID_TOKEN_SAVING_COMPACTION');
    expect(TOKEN_SAVING_EXCERPT_ENV).toBe('ALTEROID_TOKEN_SAVING_EXCERPT');
  });
});

describe.each([
  ['畳み', TOKEN_SAVING_FOLD_FIXED_TEXT_ENV, resolveTokenSavingFoldFixedText, false],
  ['compaction', TOKEN_SAVING_COMPACTION_ENV, resolveTokenSavingCompaction, false],
  ['抜粋', TOKEN_SAVING_EXCERPT_ENV, resolveTokenSavingExcerpt, true],
] as const)('%s の綴り', (_label, name, resolve, defaultEnabled) => {
  it.each(['on', '1', 'true', 'ON', ' True ', '\t1\n'])('有効の綴り %j', (raw) => {
    expect(resolve({ [name]: raw })).toBe(true);
  });

  it.each(['off', '0', 'false', 'OFF', ' False ', '\t0\n'])('無効の綴り %j', (raw) => {
    expect(resolve({ [name]: raw })).toBe(false);
  });

  it.each([undefined, '', '   '])('未設定・空 %j は既定', (raw) => {
    expect(resolve({ [name]: raw })).toBe(defaultEnabled);
    expect(recentDroppedTraces()).toHaveLength(0);
  });

  it('読めない綴りは既定へ倒し、残す（落とさない）', () => {
    expect(resolve({ [name]: 'yes' })).toBe(defaultEnabled);
    const traces = recentDroppedTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toContain(name);
  });

  it('⭐ 同じ読めない値を何度読んでも、痕跡は1回だけ（セッションを組むたびに増えない）', () => {
    for (let i = 0; i < 5; i += 1) expect(resolve({ [name]: 'yes' })).toBe(defaultEnabled);
    expect(recentDroppedTraces()).toHaveLength(1);
    // 別の綴りは別に残す
    resolve({ [name]: 'maybe' });
    expect(recentDroppedTraces()).toHaveLength(2);
  });
});
