import { JOURNAL_ENTRY_TYPES } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  JOURNAL_PAGE,
  JOURNAL_TONE,
  JOURNAL_TYPES,
  journalTypeLabel,
  SEARCH_SCOPE_NOTE,
  SEARCH_SCOPE_NOTE_JA,
} from './journal-display.js';

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
      'tool_use の input・worker_wait・turn_usage・context_usage・inbox_flow・github_observation は探す対象に入っていない（そこにだけ書かれている語は当たらない）。',
    );
  });

  it('頁の大きさは移す前と同じ 100', () => {
    expect(JOURNAL_PAGE).toBe(100);
  });
});

describe('種別の日本語名（issue #2806）', () => {
  it('全種別に名前があり、識別子のままの名前は無い', () => {
    for (const type of JOURNAL_TYPES) {
      const label = journalTypeLabel(type);
      expect(label).not.toBe(type);
      expect(label).not.toMatch(/^[a-z_]+$/);
    }
  });

  it('知らない種別は識別子のまま返す（落とさない）', () => {
    expect(journalTypeLabel('no-such-type')).toBe('no-such-type');
  });

  it('探す対象外の断りは日本語名で言い、識別子を含まない', () => {
    expect(SEARCH_SCOPE_NOTE_JA).toBe(
      '道具の入力・作業者の待機・ターンの消費・文脈の占有・受信箱の流量・GitHub の観測は探す対象に入っていない（そこにだけ書かれている語は当たらない）。',
    );
    expect(SEARCH_SCOPE_NOTE_JA).not.toMatch(/[a-z]+_[a-z]+/);
  });
});
