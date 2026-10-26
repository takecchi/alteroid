import { JOURNAL_FOLD_IDLE_GAP_MS, createMemoryStores, type JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  RUNNER_EVENT_JOURNAL_FOLD_MAX_KEYS,
  RunnerEventJournalFold,
  createRunnerEventJournalWriter,
  type RunnerEventJournalEntry,
} from './runner-event-journal-fold.js';

const T0 = Date.parse('2026-10-27T00:00:00.000Z');
const SEC = 1000;

describe('RunnerEventJournalFold — 同一本文の反復だけを畳む', () => {
  it('1件目は書く。要約は出ない', () => {
    const fold = new RunnerEventJournalFold();
    expect(fold.observe('unknown:m1', 'A', T0)).toEqual({ write: true });
  });

  it('同一本文の反復は書かず数える（write:false）', () => {
    const fold = new RunnerEventJournalFold();
    fold.observe('unknown:m1', 'A', T0);
    expect(fold.observe('unknown:m1', 'A', T0 + SEC)).toEqual({ write: false });
    expect(fold.observe('unknown:m1', 'A', T0 + 2 * SEC)).toEqual({ write: false });
    const [summary] = fold.flushAll();
    expect(summary).toContain('2 回ぶん');
    expect(summary).toContain('畳んだ本文:\nA');
  });

  it('本文が変われば書く。畳んでいた分の要約が先に出る', () => {
    const fold = new RunnerEventJournalFold();
    fold.observe('k', 'A', T0);
    fold.observe('k', 'A', T0 + SEC);
    const verdict = fold.observe('k', 'B', T0 + 2 * SEC);
    expect(verdict.write).toBe(true);
    expect(verdict.summary).toContain('1 回ぶん');
    expect(verdict.summary).toContain('畳んだ本文:\nA');
  });

  it('間が空いた再発は書く（空きの閾値は既定のまま）', () => {
    const fold = new RunnerEventJournalFold();
    fold.observe('k', 'A', T0);
    fold.observe('k', 'A', T0 + SEC);
    const verdict = fold.observe('k', 'A', T0 + SEC + JOURNAL_FOLD_IDLE_GAP_MS);
    expect(verdict.write).toBe(true);
    expect(verdict.summary).toBeDefined();
  });

  it('キーごとに独立している（別のキーの同一本文は、それぞれ1件目を書く）', () => {
    const fold = new RunnerEventJournalFold();
    expect(fold.observe('unknown:m1', 'A', T0).write).toBe(true);
    expect(fold.observe('unknown:m2', 'A', T0).write).toBe(true);
    expect(fold.observe('unknown:m1', 'A', T0 + SEC).write).toBe(false);
    expect(fold.observe('unknown:m2', 'A', T0 + SEC).write).toBe(false);
    expect(fold.flushAll()).toHaveLength(2);
  });

  it('キー数の上限を超えた新しいキーは畳まず、毎回書く（Map を太らせない）', () => {
    const fold = new RunnerEventJournalFold();
    for (let i = 0; i < RUNNER_EVENT_JOURNAL_FOLD_MAX_KEYS; i += 1) {
      fold.observe(`k${i}`, 'A', T0);
    }
    expect(fold.observe('overflow', 'A', T0 + SEC)).toEqual({ write: true });
    expect(fold.observe('overflow', 'A', T0 + 2 * SEC)).toEqual({ write: true });
    // 上限より前に入ったキーは畳み続ける
    expect(fold.observe('k0', 'A', T0 + SEC)).toEqual({ write: false });
  });

  it('flushAll は、残っている要約の本文だけを返す（畳むものが無ければ空）', () => {
    const fold = new RunnerEventJournalFold();
    expect(fold.flushAll()).toEqual([]);
    fold.observe('k', 'A', T0);
    expect(fold.flushAll()).toEqual([]);
    fold.observe('k', 'A', T0 + SEC);
    expect(fold.flushAll()).toHaveLength(1);
  });
});

function runnerEntries(entries: JournalEntry[]): string[] {
  return entries
    .filter((e) => e.type === 'external_event' && e.source === 'runner')
    .map((e) => (e.type === 'external_event' ? e.summary : ''));
}

describe('createRunnerEventJournalWriter — 守る側の行は畳みの影響を受けない（#1311）', () => {
  it('⭐ 畳み中に挟んだ人間・クローン・承認・記憶・tool_use・context_usage の行は1行も欠けず、全文そのまま、順序どおりに残る', async () => {
    const { journal } = createMemoryStores();
    const fold = new RunnerEventJournalFold();
    let clock = T0;
    const writer = createRunnerEventJournalWriter({
      journal,
      fold,
      now: () => clock,
      onDropped: (dropped) => {
        throw new Error(`日誌へ書けなかった: ${String(dropped.error)}`);
      },
    });

    const protectedInputs = [
      {
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: '同じ文面を何度送っても1行ずつ残る',
        conversationId: 'c1',
      },
      { type: 'decision', decision: '同じ判断', grounds: '同じ根拠' },
      { type: 'escalation', question: '承認してよいか', approvalId: 'ap-1' },
      {
        type: 'escalation',
        question: '承認してよいか',
        approvalId: 'ap-1',
        answeredAt: '2026-10-27T00:00:20.000Z',
        answer: 'はい',
        answeredVia: { kind: 'operator', auth: 'disabled' },
      },
      { type: 'memory_update', slug: 'notes', cause: 'clone', summary: '同じ更新' },
      { type: 'tool_use', actor: 'clone', tool: 'Bash', input: { command: 'ls' } },
      {
        type: 'context_usage',
        layer: 'manager',
        site: 'session',
        managerId: 'mgr-1',
        turnSucceeded: true,
        contextUsage: { durationMs: 1, percentage: 42, totalTokens: 1000 },
      },
    ] as const;

    const expectedProtected: JournalEntry[] = [];
    const expiredBody = 'runner の応答期限切れ: RPC list (mgr-1)';
    const round = 40;
    for (let i = 0; i < round; i += 1) {
      clock += SEC;
      await writer.write('unknown:mgr-1', expiredBody);
      // 畳み中に、同じ本文を毎周書く（畳まれたら欠ける）
      for (const input of protectedInputs) {
        expectedProtected.push(await journal.append(input));
      }
    }
    await writer.flushAll();

    const all = [...(await journal.list({ order: 'asc' }))];
    const protectedRows = all.filter(
      (e) => !(e.type === 'external_event' && e.source === 'runner'),
    );
    expect(protectedRows).toEqual(expectedProtected);
    expect(protectedRows).toHaveLength(round * protectedInputs.length);

    // 畳まれたのは runner の反復だけ: 1件目 + 要約1本（39回ぶん）
    const runner = runnerEntries(all);
    expect(runner).toHaveLength(2);
    expect(runner[0]).toBe(expiredBody);
    expect(runner[1]).toContain(`2回目以降を ${round - 1} 回ぶん`);
  });

  it('要約を先に書いてから1件目を書く（順序）', async () => {
    const { journal } = createMemoryStores();
    const fold = new RunnerEventJournalFold();
    let clock = T0;
    const writer = createRunnerEventJournalWriter({
      journal,
      fold,
      now: () => clock,
      onDropped: () => undefined,
    });
    await writer.write('k', 'A');
    clock += SEC;
    await writer.write('k', 'A');
    clock += SEC;
    await writer.write('k', 'B');
    const bodies = runnerEntries(await journal.list({ order: 'asc' }));
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe('A');
    expect(bodies[1]).toContain('畳んだ本文:\nA');
    expect(bodies[2]).toBe('B');
  });

  it('追記が失敗しても投げず、onDropped へ回す', async () => {
    const dropped: string[] = [];
    const writer = createRunnerEventJournalWriter({
      journal: {
        append: () => Promise.reject(new Error('disk full')),
      },
      fold: new RunnerEventJournalFold(),
      now: () => T0,
      onDropped: (d) => dropped.push(`${d.kind}:${d.summary}`),
    });
    await expect(writer.write('k', 'A')).resolves.toBeUndefined();
    expect(dropped).toEqual(['entry:A']);
  });

  it('書く型は external_event / source=runner の1つだけである（型の歯）', async () => {
    const writer = createRunnerEventJournalWriter({
      journal: { append: () => Promise.resolve(undefined) },
      fold: new RunnerEventJournalFold(),
      now: () => T0,
      onDropped: () => undefined,
    });
    // @ts-expect-error 要約の文字列しか受け取らない。人間・クローンの行の形は渡せない
    await writer.write('k', { type: 'decision', decision: 'x', grounds: 'y' });

    // @ts-expect-error writer の日誌の口は external_event / runner しか表現しない
    const bad: RunnerEventJournalEntry = { type: 'decision', decision: 'x', grounds: 'y' };
    void bad;

    const good: RunnerEventJournalEntry = {
      type: 'external_event',
      source: 'runner',
      summary: 's',
    };
    expect(good.type).toBe('external_event');
  });
});
