import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// 同じ入力の中で同じ意味を2回言っている再掲を外す（意味は落とさない）。
// 1. 待ち行列の断りの末尾「全文は `task_list`。並べ替えは `task_move`。」は、直前の括弧の案内（先頭が先にやるもの。並べ替えは task_move、…全部は task_list）と同趣旨
// 2. 定期の依頼の tick の入力は、「待ち行列: 開いている N 件」の行を断り書き（先頭）と要約（末尾）の両方に持っていた。先に出る断り書きの側だけに残す

const TIMER_KIND = 'issue-round';
const TAIL = '全文は `task_list`。並べ替えは `task_move`。';
const HEAD_GUIDE =
  '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）';
const COUNT_LINE = '待ち行列: 開いている 4 件（queued 4 / waiting 0 / needs_decision 0）';
const SITUATION_MARK = '[system] いまの全体（';

interface Boot {
  clone: CloneHost;
  stores: Stores;
  inputs: string[];
}

function boot(): Boot {
  const stores = createMemoryStores();
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
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: `uuid-result-${String(inputs.length)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
      getContextUsage: async () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, stores, inputs };
}

async function seed(stores: Stores): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const at = new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString();
    await stores.tasks.add({
      id: `task-${i}`,
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'self',
      title: `待ち行列の仕事 ${i}`,
      body: `待ち行列の本文 ${i}`,
    });
  }
  await stores.schedules.put({
    kind: TIMER_KIND,
    spec: { type: 'daily', at: '09:00' },
    request: '起票されている仕事を見て、着手できるものから進める。',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  });
}

type Post = Parameters<CloneHost['post']>[0];

async function turnOf(s: Boot, event: Post): Promise<string> {
  const before = s.inputs.length;
  s.clone.post(event);
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  return s.inputs[before] ?? '';
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('同じ入力の中の再掲を外す', () => {
  it('⭐ 待ち行列の断りの末尾に「全文は task_list…」が出ない（括弧の案内は残る）', async () => {
    const s = boot();
    await seed(s.stores);
    const input = await turnOf(s, humanMessage('やってほしいこと'));

    expect(count(input, HEAD_GUIDE)).toBe(1);
    expect(input).not.toContain(TAIL);
    expect(input).not.toContain('全文は `task_list`');
    await s.clone.stop();
  });

  it('⭐ 定期の依頼の tick: 「待ち行列: 開いている N 件」の行は1回だけ、先に出る断り書きの側に残る', async () => {
    const s = boot();
    await seed(s.stores);
    const input = await turnOf(s, {
      type: 'timer',
      id: 'evt-timer-once',
      at: new Date().toISOString(),
      kind: TIMER_KIND,
      cause: 'manual',
    });

    expect(count(input, COUNT_LINE)).toBe(1);
    expect(input.indexOf(COUNT_LINE)).toBeLessThan(input.indexOf(SITUATION_MARK));
    // 先頭の案内は断り書きに残り、末尾の再掲は出ない
    expect(count(input, HEAD_GUIDE)).toBe(1);
    expect(input).not.toContain(TAIL);
    // 読めない行の断りなど、件数の行以外の要約の中身は変わらない
    expect(input).toContain('回答待ち 0');
    await s.clone.stop();
  });
});
