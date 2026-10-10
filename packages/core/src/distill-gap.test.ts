import { describe, expect, it } from 'vitest';

import {
  BOOT_FOOTPRINT_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
  countsAsUndistilledActivity,
  deriveDistillGapFromJournal,
  distillSucceededEntry,
} from './distill-gap.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { JournalEntry } from './schema.js';

describe('countsAsUndistilledActivity（allowlist の外は false）', () => {
  it('subagent_stall は「まだ記憶へ移っていない活動」に数えない（器の記帳）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-1',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
      text: '起こし直した（1回目 / 上限 2）。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('subagent_stall（limit_reached）も同様に false（outcome で分岐しない）', () => {
    const entry: JournalEntry = {
      type: 'subagent_stall',
      id: 'j-2',
      at: '2026-09-06T00:00:00.000Z',
      agentId: 'agent-1',
      ownedTaskCount: 1,
      sessionTaskCount: 1,
      wakeupCount: 2,
      outcome: 'limit_reached',
      text: '起こし直さなかった。',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('（対照）exchange with!==self は数える', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'j-3',
      at: '2026-09-06T00:00:00.000Z',
      with: 'human',
      role: 'inbound',
      text: '人間からの発言',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(true);
  });

  it('デーモンが起動時に書く器の実寸の記録（external_event）は数えない', () => {
    const entry: JournalEntry = {
      type: 'external_event',
      id: 'j-4',
      at: '2026-09-06T00:00:00.000Z',
      source: BOOT_FOOTPRINT_EVENT_SOURCE,
      summary: '起動時の器の実寸とヒープ',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('デーモンが起動時に書く ToolSearch の見込みの記録（external_event）は数えない', () => {
    const entry: JournalEntry = {
      type: 'external_event',
      id: 'j-6',
      at: '2026-09-06T00:00:00.000Z',
      source: BOOT_TOOL_SEARCH_EVENT_SOURCE,
      summary: 'ToolSearch: クローンの子の env には止める条件が置かれていない',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(false);
  });

  it('（対照）それ以外の external_event は数える', () => {
    const entry: JournalEntry = {
      type: 'external_event',
      id: 'j-5',
      at: '2026-09-06T00:00:00.000Z',
      source: 'github',
      summary: 'PR が更新された',
    };

    expect(countsAsUndistilledActivity(entry)).toBe(true);
  });
});

describe('起動のたびに積まれる実寸の記録だけでは「移りきっていない」と断らない（#4269）', () => {
  const bootFootprint = {
    type: 'external_event',
    source: BOOT_FOOTPRINT_EVENT_SOURCE,
    summary: '起動時の器の実寸とヒープ',
  } as const;

  it('記憶が空の初回起動（日誌は起動時の記録1行だけ）では断らない', async () => {
    const baseTimeMs = Date.parse('2026-10-08T15:00:00.000Z');
    const fake = createSyntheticJournalStore({
      total: 1,
      baseTimeMs,
      entryAt: () => bootFootprint,
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap).toBeNull();
  });

  it('蒸留が成功で終わった後の再起動（印の後ろは起動時の記録だけ）では断らない', async () => {
    const baseTimeMs = Date.parse('2026-10-08T15:00:00.000Z');
    const fake = createSyntheticJournalStore({
      total: 3,
      baseTimeMs,
      entryAt: (index) =>
        index === 0
          ? bootFootprint
          : index === 1
            ? distillSucceededEntry('shutdown')
            : { type: 'exchange', with: 'human', role: 'inbound', text: '前の会話' },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap).toBeNull();
  });

  it('（対照）起動時の記録と並んで本物の活動が在れば、その活動だけを数えて断る', async () => {
    const baseTimeMs = Date.parse('2026-10-08T15:00:00.000Z');
    const fake = createSyntheticJournalStore({
      total: 2,
      baseTimeMs,
      entryAt: (index) =>
        index === 0
          ? bootFootprint
          : { type: 'exchange', with: 'human', role: 'inbound', text: '移っていない発言' },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap?.activityCount).toBe(1);
    expect(gap?.firstActivityAt).toBe(fake.entryOf(1).at);
    expect(gap?.lastActivityAt).toBe(fake.entryOf(1).at);
  });
});

describe('OOM の本体を直す（issue #1283）— distill-gap の走査をページ単位に有界化する', () => {
  it('⭐ 活動が大量に在っても activityCount は正確なまま、偽ストアへ渡る limit は常に有限で、渡った総件数は活動の件数に比例した量で頭打ちになる（打ち切りは導入しない）', async () => {
    const activityCount = JOURNAL_SCAN_PAGE_SIZE * 6 + 37;
    const total = activityCount + 1;
    const baseTimeMs = Date.now();
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs,
      entryAt: (index) =>
        index === activityCount
          ? distillSucceededEntry('shutdown')
          : { type: 'exchange', with: 'manager', role: 'outbound', text: `activity-${index}` },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap).not.toBeNull();
    expect(gap!.window).toBe('since_last_distill');
    expect(gap!.activityCount).toBe(activityCount);
    expect(gap!.lastDistilledAt).toBe(fake.entryOf(activityCount).at);
    expect(gap!.lastActivityAt).toBe(fake.entryOf(0).at);
    expect(gap!.firstActivityAt).toBe(fake.entryOf(activityCount - 1).at);

    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(Number.isFinite(call.limit)).toBe(true);
      expect(call.limit).toBeGreaterThan(0);
      expect(call.limit).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    }

    expect(fake.totalReturned).toBe(activityCount + 1);
  });

  it('印を探す枝は、最初に当たった行で止まる（後ろに大量のノイズが在っても読み切らない）', async () => {
    const noiseCount = JOURNAL_SCAN_PAGE_SIZE * 4;
    const total = noiseCount + 1;
    const baseTimeMs = Date.now();
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs,
      entryAt: (index) =>
        index === 0
          ? distillSucceededEntry('shutdown')
          : { type: 'decision', decision: `noise-${index}`, grounds: 'g' },
    });

    const gap = await deriveDistillGapFromJournal(fake.store, {
      until: new Date(baseTimeMs + 1_000).toISOString(),
    });

    expect(gap).toBeNull();

    expect(fake.totalReturned).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    expect(fake.totalReturned).toBeLessThan(total);
  });
});
