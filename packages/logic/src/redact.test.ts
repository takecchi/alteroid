/**
 * 日誌の要旨の伏せ字（issue #2600）。`summarizeJournalEntry` は Web の一覧・ダッシュボードと
 * TUI が共有する出口なので、ここで掛けて確かめる。
 */
import { describe, expect, it } from 'vitest';

import type { JournalEntry } from './types.js';

import { summarizeJournalEntry } from './journal-summary.js';
import { redactBody, redactError } from './redact.js';

/** 偽のトークン（本物ではない）。 */
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('redactBody / redactError', () => {
  it('本文: トークンは消え、40桁の sha は残る', () => {
    const out = redactBody(`token ${TOKEN} commit ${SHA}`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(SHA);
  });

  it('error の文: トークンが消える', () => {
    expect(redactError(`failed with ${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe('summarizeJournalEntry の伏せ字', () => {
  it('exchange の本文からトークンが消え、sha は残る', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'e-1',
      at: '2026-08-20T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: `token ${TOKEN} commit ${SHA}`,
    } as JournalEntry;
    const out = summarizeJournalEntry(entry);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(SHA);
  });

  it('daily_report の作れなかった理由からトークンが消える', () => {
    const entry: JournalEntry = {
      type: 'daily_report',
      id: 'dr-1',
      at: '2026-08-20T22:00:00.000Z',
      date: '2026-08-20',
      body: '（作れなかった）',
      unavailable: `auth failed ${TOKEN}`,
    };
    expect(summarizeJournalEntry(entry)).not.toContain(TOKEN);
  });
});
