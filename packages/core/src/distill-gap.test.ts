import { describe, expect, it } from 'vitest';

import {
  BOOT_DEFERRED_INDEXES_EVENT_SOURCE,
  BOOT_FOOTPRINT_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
  countsAsUndistilledActivity,
  deriveDistillGapFromJournal,
  describeDistillGap,
  distillSucceededEntry,
} from './distill-gap.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { JournalEntry, JournalEntryInput } from './schema.js';
import { EXCHANGE_WITH_VALUES } from './store.js';
import type { JournalPage, JournalQuery, JournalStore } from './store.js';
import { createMemoryStores } from './testing.js';

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

  it('デーモンが起動時に書く、日誌の索引を作った結果の記録（external_event）は数えない', () => {
    const entry: JournalEntry = {
      type: 'external_event',
      id: 'j-7',
      at: '2026-10-24T00:00:00.000Z',
      source: BOOT_DEFERRED_INDEXES_EVENT_SOURCE,
      summary: '起動の後に作る日誌の索引: journal_human_exchange_seq_idx=有効（既に在った）',
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

describe('印の後ろは数える種別だけを読む（types 無しで本文ごと運ばない）', () => {
  const usage = (site: 'session' | 'distill'): JournalEntryInput => ({
    type: 'turn_usage',
    layer: 'clone',
    site,
    managerId: 'clone',
    models: {
      'claude-fable-5': {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUsd: 0.1,
      },
    },
  });

  it('⭐ 数えない行（tool_use・self の往復・decision・起動の記録・蒸留の turn_usage）を大量に混ぜても、数える行の数と区間は全件を読む形と同じで、types 無しの呼びも self の行の運搬も無い', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '印より前（数えない）',
    });
    const marker = await stores.journal.append(distillSucceededEntry('shutdown'));

    const rounds = 150;
    for (let i = 0; i < rounds; i++) {
      await stores.journal.append({ type: 'tool_use', actor: 'clone', tool: 'Bash', input: {} });
      await stores.journal.append({ type: 'exchange', with: 'self', role: 'outbound', text: 's' });
      await stores.journal.append({ type: 'decision', decision: `noise-${i}`, grounds: 'g' });
      await stores.journal.append({
        type: 'external_event',
        source: BOOT_FOOTPRINT_EVENT_SOURCE,
        summary: '起動',
      });
      await stores.journal.append(usage('distill'));
      await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'h' });
      await stores.journal.append({
        type: 'exchange',
        with: 'manager',
        role: 'outbound',
        text: 'm',
      });
      await stores.journal.append(usage('session'));
      await stores.journal.append({ type: 'external_event', source: 'github', summary: 'PR' });
    }

    const until = new Date(Date.now() + 1_000).toISOString();
    const everything = await stores.journal.list({
      order: 'asc',
      after: { id: marker.id, at: marker.at },
      until,
    });
    const counted = everything.filter(countsAsUndistilledActivity);
    expect(counted).toHaveLength(rounds * 4);

    const calls: JournalQuery[] = [];
    const carried: JournalEntry[] = [];
    const spy = {
      list: stores.journal.list.bind(stores.journal),
      listPage: async (query?: JournalQuery) => {
        if (query !== undefined) calls.push(query);
        const page = await stores.journal.listPage(query);
        carried.push(...page.entries);
        return page;
      },
    };

    const gap = await deriveDistillGapFromJournal(spy, { until });

    expect(gap?.activityCount).toBe(counted.length);
    expect(gap?.firstActivityAt).toBe(counted[0]?.at);
    expect(gap?.lastActivityAt).toBe(counted.at(-1)?.at);
    expect(gap?.lastDistilledAt).toBe(marker.at);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.types !== undefined)).toBe(true);
    const scanAfterMarker = calls.filter((call) => call.after !== undefined);
    expect(scanAfterMarker.length).toBeGreaterThan(0);
    for (const call of scanAfterMarker) {
      expect(call.with?.includes('self')).not.toBe(true);
    }
    expect(carried.some((entry) => entry.type === 'exchange' && entry.with === 'self')).toBe(false);
    expect(carried.filter((entry) => entry.type === 'tool_use')).toEqual([]);
    expect(carried.filter((entry) => entry.type === 'exchange').length).toBe(rounds * 2);
  });

  it('走査 A の with は、ExchangeWith の全値から self を除いたものである（値が増えれば自動で入る）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append(distillSucceededEntry('shutdown'));
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'h' });
    const calls: JournalQuery[] = [];

    await deriveDistillGapFromJournal(
      {
        list: stores.journal.list.bind(stores.journal),
        listPage: async (query) => {
          if (query !== undefined) calls.push(query);
          return stores.journal.listPage(query);
        },
      },
      { until: new Date(Date.now() + 1_000).toISOString() },
    );

    const exchangeScan = calls.find((call) => call.types?.includes('exchange') === true);
    expect(exchangeScan?.with).toEqual(EXCHANGE_WITH_VALUES.filter((value) => value !== 'self'));
    expect(exchangeScan?.with?.length).toBeGreaterThan(0);
  });

  it('seq の順と at の順が入れ替わっていても、数えた行の at の最小と最大を区間にする（印より後に積まれて at が少し前の行も数える）', async () => {
    const baseMs = Date.parse('2026-10-08T15:00:00.000Z');
    const at = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();
    const rows: JournalEntry[] = [
      { type: 'exchange', id: 'r0', at: at(0), with: 'human', role: 'inbound', text: '前' },
      { ...distillSucceededEntry('shutdown'), id: 'r1', at: at(10) } as JournalEntry,
      // 並行の追記で `at` が印より前になった行（seq は印より後）
      { ...usage('session'), id: 'r2', at: at(7) } as JournalEntry,
      { type: 'exchange', id: 'r3', at: at(50), with: 'manager', role: 'outbound', text: 'm' },
      { type: 'external_event', id: 'r4', at: at(30), source: 'github', summary: 'PR' },
    ];
    const store = createFakeSeqJournal(rows);

    const gap = await deriveDistillGapFromJournal(store, { until: at(1_000) });

    expect(gap?.activityCount).toBe(3);
    expect(gap?.firstActivityAt).toBe(at(7));
    expect(gap?.lastActivityAt).toBe(at(50));
    expect(gap && describeDistillGap(gap)).toContain('区間の始まりが蒸留の時刻と同じに見える');
  });
});

// `at` を自由に置ける最小の偽ストア: 実ストアは `at` を追記の瞬間に決めるので、`seq` と `at` の入れ替わりを作れない
function createFakeSeqJournal(
  rows: readonly JournalEntry[],
): Pick<JournalStore, 'list' | 'listPage'> {
  const listPage = async (query: JournalQuery = {}): Promise<JournalPage> => {
    const anchor = query.after === undefined ? -1 : rows.findIndex((r) => r.id === query.after?.id);
    const matched = rows
      .slice(anchor + 1)
      .filter(
        (row) =>
          (query.since === undefined || row.at >= query.since) &&
          (query.until === undefined || row.at <= query.until) &&
          (query.types === undefined || query.types.includes(row.type)) &&
          (query.with === undefined || (row.type === 'exchange' && query.with.includes(row.with))),
      );
    const limit = query.limit ?? matched.length;
    const entries = matched.slice(0, limit);
    const last = entries.at(-1);
    return {
      entries,
      next: matched.length > limit && last !== undefined ? { id: last.id, at: last.at } : null,
    };
  };
  return { list: async (query) => (await listPage(query)).entries, listPage };
}

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
