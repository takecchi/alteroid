/**
 * 日誌の表示の定数（#2558）。**期待値は、移す前に Web（`journal.tsx` の `TONE`）・TUI
 * （`journal-format.ts`）・swr に在った値をそのまま書き写してある** — 定数側から導いた値で
 * 照らすと、定数を変えたときにテストも一緒に変わって何も測れない。
 */
import { JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { JOURNAL_PAGE, JOURNAL_TONE, JOURNAL_TYPES, SEARCH_SCOPE_NOTE } from './journal-display.js';

const OLD_TONE_IN_ORDER = [
  ['exchange', 'neutral'],
  ['decision', 'accent'],
  ['escalation', 'warn'],
  ['tool_use', 'neutral'],
  ['memory_update', 'ok'],
  ['daily_report', 'accent'],
  ['external_event', 'warn'],
  ['worker_wait', 'neutral'],
  ['turn_usage', 'neutral'],
  ['context_usage', 'neutral'],
  ['token_rotation', 'warn'],
  ['subagent_stall', 'warn'],
  ['inbox_flow', 'neutral'],
  ['github_observation', 'neutral'],
] as const;

describe('日誌の表示の定数', () => {
  it('種別の色は移す前と同じ', () => {
    expect(JOURNAL_TONE).toEqual(Object.fromEntries(OLD_TONE_IN_ORDER));
  });

  it('種別の並びは移す前（チップの表示順）と同じ', () => {
    expect([...JOURNAL_TYPES]).toEqual(OLD_TONE_IN_ORDER.map(([type]) => type));
  });

  it('種別の集合は core の JOURNAL_ENTRY_TYPES と同じ（並びは違ってよい）', () => {
    expect([...JOURNAL_TYPES].sort()).toEqual([...JOURNAL_ENTRY_TYPES].sort());
  });

  it('検索の断りは移す前と同じ文言', () => {
    expect(SEARCH_SCOPE_NOTE).toBe(
      'tool_use の input・worker_wait・turn_usage・github_observation は探す対象に入っていない（そこにだけ書かれている語は当たらない）。',
    );
  });

  it('頁の大きさは移す前と同じ 100', () => {
    expect(JOURNAL_PAGE).toBe(100);
  });
});
