import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(stores: Stores): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

function staleTokenPoolEvent(id: string, at: string, payload: unknown): InboxEvent {
  return { type: 'external', id, at, source: DAEMON_TOKEN_POOL_REOPENED_SOURCE, payload };
}

function managerReport(text: string, id: string, at: string): InboxEvent {
  return { type: 'manager_message', id, at, managerId: 'mgr-1', kind: 'report', text };
}

function instrument(base: Stores): {
  stores: Stores;
  removeManyCalls: string[][];
  appendCalls: JournalEntryInput[];
} {
  const removeManyCalls: string[][] = [];
  const appendCalls: JournalEntryInput[] = [];
  const stores: Stores = {
    ...base,
    inbox: {
      ...base.inbox,
      async removeMany(ids: readonly string[]) {
        removeManyCalls.push([...ids]);
        return base.inbox.removeMany(ids);
      },
    },
    journal: {
      ...base.journal,
      async append(entry: JournalEntryInput) {
        appendCalls.push(entry);
        return base.journal.append(entry);
      },
    },
  };
  return { stores, removeManyCalls, appendCalls };
}

function flakyRemoveMany(
  base: Stores,
  failCount: number,
  reason: string,
): { stores: Stores; calls: string[][] } {
  const calls: string[][] = [];
  let remaining = failCount;
  return {
    calls,
    stores: {
      ...base,
      inbox: {
        ...base.inbox,
        async removeMany(ids: readonly string[]) {
          calls.push([...ids]);
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(reason));
          }
          return base.inbox.removeMany(ids);
        },
      },
    },
  };
}

describe('stale な配り直しの一括消し込み（issue #903）', () => {
  it('stale N 件を一括で消す: removeMany の呼び出し回数が N より少ない（ストアを偽実装で包んで実際に数える）', async () => {
    const base = createMemoryStores();
    const { stores, removeManyCalls } = instrument(base);
    const N = 5;
    const ids = Array.from({ length: N }, (_, i) => `evt-stale-few-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-01T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件が受信箱から消える',
    );

    expect(removeManyCalls.length).toBeLessThan(N);
    expect(removeManyCalls.length).toBe(1);
    expect(removeManyCalls.flat().sort()).toEqual([...ids].sort());

    await clone.stop();
  });

  it('塊の上限（RESTORE_STALE_REMOVE_CHUNK_MAX_IDS = 65,535）+1 件を仕込むと removeMany が2回以上に割れる', async () => {
    const base = createMemoryStores();
    const { stores, removeManyCalls } = instrument(base);
    const CHUNK_MAX = 65_535;
    const N = CHUNK_MAX + 1;
    for (let i = 0; i < N; i += 1) {
      const id = `evt-chunk-${i}`;
      const at = new Date(2026, 0, 1, 0, 0, 0, i % 1000).toISOString();
      await stores.inbox.put(staleTokenPoolEvent(id, at, i), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件（65,536件）が受信箱から消える',
    );

    expect(removeManyCalls.length).toBeGreaterThanOrEqual(2);
    const totalRemoved = removeManyCalls.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalRemoved).toBe(N);
    for (const chunk of removeManyCalls) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX);
    }

    await clone.stop();
  }, 90_000);

  it('stale 1件あたりの journal.append 回数が3回から2回に減った（同じく数える）', async () => {
    const baseline = createMemoryStores();
    const { stores: baselineStores, appendCalls: baselineAppends } = instrument(baseline);
    const { clone: baselineClone } = bootClone(baselineStores);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await baselineClone.stop();
    const baselineCount = baselineAppends.length;

    const stores0 = createMemoryStores();
    const { stores, appendCalls } = instrument(stores0);
    const N = 4;
    const ids = Array.from({ length: N }, (_, i) => `evt-stale-count-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-02T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `COUNT-PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件が受信箱から消える',
    );

    expect(appendCalls.length - baselineCount).toBe(2 * N + 2);

    await clone.stop();
  });

  it('減った1行の情報が失われていない — 残った見出しの行に deliveries の回数が載っている（逐語で撃つ）', async () => {
    const stores = createMemoryStores();
    const event = staleTokenPoolEvent(
      'evt-deliveries-stale',
      '2026-08-03T00:00:00.000Z',
      'DELIVERIES-PAYLOAD',
    );
    await stores.inbox.put(event, event.at);

    const { clone } = bootClone(stores);
    await waitFor(async () => (await stores.inbox.peekPending()).entries.length === 0, '消える');

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const folded = exchanges.find(
      (entry) =>
        entry.type === 'exchange' &&
        entry.text.includes('ターンを起こさずに消した') &&
        entry.text.includes(event.at),
    );
    const text = folded && folded.type === 'exchange' ? folded.text : '';

    expect(text).toContain('1回目の配達');
    expect(text).toContain('未読のまま残っていた合図を配り直した');
    expect(text).toContain('ターンを起こさずに消した');

    await clone.stop();
  });

  it('拾い直しても消せなければ跡を残して次の起動へ委ねる——一括経路でも FORGET_RETRY_ATTEMPTS の再試行を落とさない', async () => {
    const base = createMemoryStores();
    const { stores, calls } = flakyRemoveMany(base, 10, '恒久的な障害（テスト用）');
    const event = staleTokenPoolEvent(
      'evt-stale-retry-exhausted',
      '2026-08-04T00:00:00.000Z',
      'RETRY-PAYLOAD',
    );
    await stores.inbox.put(event, event.at);

    const lines = await captureStderr(async () => {
      const { clone } = bootClone(stores);
      await waitFor(async () => {
        const exchanges = (await stores.inbox.peekPending()).entries;
        return exchanges.length === 1;
      }, '（消えていないことの確認のための一呼吸）');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await clone.stop();
    });

    expect(calls.length).toBe(3);
    expect(lines.some((line) => line.includes('未読の消し込み'))).toBe(true);
    const pending = await base.inbox.claimPending();
    expect(pending.some((p) => p.event.id === event.id)).toBe(true);
  }, 10_000);

  it('本文追記（external_event）は1件ずつ N 件出る（畳まれていない）', async () => {
    const stores = createMemoryStores();
    const N = 3;
    const ids = Array.from({ length: N }, (_, i) => `evt-body-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-05T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `BODY-PAYLOAD-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件が消える',
    );

    const externalEvents = await stores.journal.list({ types: ['external_event'] });
    for (let i = 0; i < N; i += 1) {
      const found = externalEvents.some(
        (entry) => entry.type === 'external_event' && entry.summary.includes(`BODY-PAYLOAD-${i}`),
      );
      expect(found).toBe(true);
    }
    const matching = externalEvents.filter(
      (entry) => entry.type === 'external_event' && entry.summary.includes('BODY-PAYLOAD-'),
    );
    expect(matching.length).toBe(N);

    await clone.stop();
  });

  it('live の経路は1文字も変わっていない — manager_message の配り直しで「配り直した」の行がいまも単独で出る', async () => {
    const stores = createMemoryStores();
    const event = managerReport(
      '未読のまま残っていた報告',
      'evt-live-unchanged',
      new Date(0).toISOString(),
    );
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores);
    await waitFor(() => inputs.length > 0, '配り直された報告がターンに渡る');

    const prompt = inputs[0] ?? '';
    expect(prompt).toContain('配り直し');
    expect(prompt).toContain('1 回目の配達');

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const redelivered = exchanges.find(
      (entry) =>
        entry.type === 'exchange' && entry.text.includes('未読のまま残っていた合図を配り直した'),
    );
    const text = redelivered && redelivered.type === 'exchange' ? redelivered.text : '';
    expect(text).toContain('未読のまま残っていた合図を配り直した');
    expect(text).not.toContain('ターンを起こさずに消した');

    await clone.stop();
  });

  it('後始末（settled と pendingCollapse）が一括経路でも起きている', async () => {
    const stores = createMemoryStores();
    const sharedPayload = 'SHARED-COLLAPSE-PAYLOAD';
    const first = staleTokenPoolEvent('evt-collapse-a', '2026-08-06T00:00:00.000Z', sharedPayload);
    const second = staleTokenPoolEvent('evt-collapse-b', '2026-08-06T00:00:01.000Z', sharedPayload);
    await stores.inbox.put(first, first.at);
    await stores.inbox.put(second, second.at);

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '両方消える',
    );

    clone.post({
      type: 'human_message',
      id: 'evt-trigger-turn',
      at: new Date().toISOString(),
      text: 'inbox_flow を書かせるための1ターン',
      conversationId: 'conv-settled',
    });
    await waitFor(async () => {
      const entries = await stores.journal.list({ types: ['inbox_flow'] });
      return entries.some(
        (entry) =>
          entry.type === 'inbox_flow' &&
          entry.settled.byType.some((row) => row.type === 'external' && row.count >= 2),
      );
    }, 'inbox_flow が settled=2件以上の external を報告する');

    const before = await stores.journal.list({ types: ['exchange'] });
    const beforeFoldedCount = before.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('受信箱の行は増やさずに畳んだ'),
    ).length;

    clone.post(staleTokenPoolEvent('evt-collapse-fresh', new Date().toISOString(), sharedPayload));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterFolded = await stores.journal.list({ types: ['exchange'] });
    const afterFoldedCount = afterFolded.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('受信箱の行は増やさずに畳んだ'),
    ).length;
    expect(afterFoldedCount).toBe(beforeFoldedCount);

    await clone.stop();
  });

  it('拾い直しの途中で器が畳まれても、消えた分だけが消えた一貫した状態で止まる（#stopped / #inbox.closed を毎周見る性質を壊していない）', async () => {
    const base = createMemoryStores();
    const N = 3000;
    // epoch ミリ秒へ i を足す: Date の ms フィールドは999を超えると繰り上がり、同じ at の行ができるため
    const baseEpochMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const atForIndex = (i: number): string => new Date(baseEpochMs + i).toISOString();
    const ids = Array.from({ length: N }, (_, i) => `evt-crash-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = atForIndex(i);
      await base.inbox.put(staleTokenPoolEvent(id, at, i), at);
    }

    const cloneRef: { current: CloneHost | undefined } = { current: undefined };
    let stopPromise: Promise<void> | undefined;
    let droppedSoFar = 0;
    const STOP_AFTER = 500;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        async append(entry) {
          const result = await base.journal.append(entry);
          if (
            stopPromise === undefined &&
            entry.type === 'exchange' &&
            entry.text.includes('ターンを起こさずに消した')
          ) {
            droppedSoFar += 1;
            if (droppedSoFar >= STOP_AFTER && cloneRef.current !== undefined) {
              stopPromise = cloneRef.current.stop();
            }
          }
          return result;
        },
      },
    };

    const booted = bootClone(stores);
    cloneRef.current = booted.clone;

    await waitFor(() => stopPromise !== undefined, 'stop() が割り込みで起こされる');
    await stopPromise;

    const remaining = (await base.inbox.peekPending()).entries;
    const remainingIds = new Set(remaining.map((r) => r.event.id));
    const removedIds = ids.filter((id) => !remainingIds.has(id));

    expect(removedIds.length).toBeGreaterThan(0);
    expect(remainingIds.size).toBeGreaterThan(0);

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const droppedTexts = exchanges
      .filter(
        (entry) => entry.type === 'exchange' && entry.text.includes('ターンを起こさずに消した'),
      )
      .map((entry) => (entry.type === 'exchange' ? entry.text : ''));

    const atOf = (id: string): string => atForIndex(ids.indexOf(id));

    for (const id of removedIds) {
      const at = atOf(id);
      expect(droppedTexts.some((text) => text.includes(at))).toBe(true);
    }
    for (const id of remainingIds) {
      const at = atOf(id);
      expect(droppedTexts.some((text) => text.includes(at))).toBe(false);
    }
  }, 30_000);
});

describe('計器: #restoreUnreadPass の始まりと終わりに1行だけ書く（issue #903 続き）', () => {
  it('総数と処理した数が正しい。始まり・終わりの行がちょうど1本ずつ出る', async () => {
    const stores = createMemoryStores();
    const N = 5;
    const ids = Array.from({ length: N }, (_, i) => `evt-gauge-basic-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-10T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `GAUGE-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件が消える',
    );

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const gaugeLines = exchanges.filter(
      (entry) => entry.type === 'exchange' && entry.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX),
    );
    const starts = gaugeLines.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('未読の拾い直しを始める'),
    );
    const ends = gaugeLines.filter(
      (entry) => entry.type === 'exchange' && entry.text.includes('未読の拾い直しが終わった'),
    );

    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);

    const startText = starts[0]?.type === 'exchange' ? starts[0].text : '';
    const endText = ends[0]?.type === 'exchange' ? ends[0].text : '';
    expect(startText).toContain(`総数 ${N} 件`);
    expect(endText).toContain(`総数 ${N} 件のうち ${N} 件を処理した`);
    expect(endText).not.toContain('中断した');

    await clone.stop();
  });

  it('やりすぎの対照: 件数が複数（7件）でも、1件ごとに [計器] 行を出していない（ちょうど2本）', async () => {
    const stores = createMemoryStores();
    const N = 7;
    const ids = Array.from({ length: N }, (_, i) => `evt-gauge-many-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = `2026-08-11T00:00:0${i}.000Z`;
      await stores.inbox.put(staleTokenPoolEvent(id, at, `GAUGE-MANY-${i}`), at);
    }

    const { clone } = bootClone(stores);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '全件が消える',
    );

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const gaugeLines = exchanges.filter(
      (entry) => entry.type === 'exchange' && entry.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX),
    );
    expect(gaugeLines.length).toBe(2);

    await clone.stop();
  });

  it('中断（#stopped / #inbox.closed）したとき、終わりの行が中断の事実と正しい残り件数を報告する', async () => {
    const base = createMemoryStores();
    const N = 200;
    const baseEpochMs = Date.UTC(2026, 0, 2, 0, 0, 0, 0);
    const atForIndex = (i: number): string => new Date(baseEpochMs + i).toISOString();
    const ids = Array.from({ length: N }, (_, i) => `evt-gauge-crash-${i}`);
    for (const [i, id] of ids.entries()) {
      const at = atForIndex(i);
      await base.inbox.put(staleTokenPoolEvent(id, at, i), at);
    }

    const cloneRef: { current: CloneHost | undefined } = { current: undefined };
    let stopPromise: Promise<void> | undefined;
    let droppedSoFar = 0;
    const STOP_AFTER = 50;
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        async append(entry) {
          const result = await base.journal.append(entry);
          if (
            stopPromise === undefined &&
            entry.type === 'exchange' &&
            entry.text.includes('ターンを起こさずに消した')
          ) {
            droppedSoFar += 1;
            if (droppedSoFar >= STOP_AFTER && cloneRef.current !== undefined) {
              stopPromise = cloneRef.current.stop();
            }
          }
          return result;
        },
      },
    };

    const booted = bootClone(stores);
    cloneRef.current = booted.clone;

    await waitFor(() => stopPromise !== undefined, 'stop() が割り込みで起こされる');
    await stopPromise;

    const exchanges = await stores.journal.list({ types: ['exchange'] });
    const ends = exchanges.filter(
      (entry) =>
        entry.type === 'exchange' &&
        entry.text.startsWith(EXCHANGE_KIND_GAUGE_PREFIX) &&
        entry.text.includes('未読の拾い直しを中断した'),
    );
    expect(ends.length).toBe(1);
    const endText = ends[0]?.type === 'exchange' ? ends[0].text : '';

    const totalProcessedMatch = endText.match(/総数 (\d+) 件のうち (\d+) 件を処理した/);
    expect(totalProcessedMatch).not.toBeNull();
    const total = Number(totalProcessedMatch?.[1]);
    const processed = Number(totalProcessedMatch?.[2]);
    expect(total).toBe(N);
    expect(processed).toBeGreaterThan(0);
    expect(processed).toBeLessThan(N);

    const remainingMatch = endText.match(/残り (\d+) 件は次の起動で拾い直す/);
    expect(remainingMatch).not.toBeNull();
    const reportedRemaining = Number(remainingMatch?.[1]);
    expect(reportedRemaining).toBe(total - processed);

    const actualRemaining = (await base.inbox.peekPending()).entries.length;
    expect(actualRemaining).toBe(reportedRemaining);
  }, 30_000);
});
