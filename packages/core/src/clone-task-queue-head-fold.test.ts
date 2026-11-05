import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { waitFor } from './clone-test-harness.js';
import { parseFoldState, serializeFoldState } from './fold-state.js';
import type { FoldState } from './fold-state.js';
import type { CloneHost } from './host.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { InboxEvent, Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 断り書きの待ち行列の先頭は、毎回見出しを含む全文で出す（畳まない）。

const AT = '2026-10-29T00:00:00.000Z';
const HEAD = '[system] 待ち行列（';
const FOLDED = '[system] 待ち行列: ';

interface Boot {
  clone: CloneHost;
  inputs: string[];
  stores: Stores;
}

function boot(options: { stores?: Stores } = {}): Boot {
  const stores = options.stores ?? createMemoryStores();
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
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fn, env: {} }),
    ]),
  });
  return { clone, inputs, stores };
}

function human(id: string, conversationId = 'conv-1'): InboxEvent {
  return { type: 'human_message', id, at: new Date().toISOString(), text: id, conversationId };
}

function seededTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: AT,
    updatedAt: AT,
    status: 'queued',
    origin: 'self',
    title: `題-${id}`,
    body: `body-${id}`,
    ...overrides,
  };
}

let seq = 0;

/**
 * 発言を1つ投げて入力を返す。その発言の task は閉じてから返す: 閉じないと次の回の待ち行列に残り、「同じ待ち行列」が作れないため。
 */
async function turn(s: Boot, conversationId = 'conv-1'): Promise<{ input: string; id: string }> {
  const before = s.inputs.length;
  const timings = await timingCount(s);
  seq += 1;
  const id = `fold-evt-${String(seq)}`;
  s.clone.post(human(id, conversationId));
  await waitFor(() => s.inputs.length > before, `入力 ${String(before + 1)} 本目`);
  await settle(s, timings + 1);
  await s.stores.tasks.setStatus(id, 'done', { reason: 'test', by: 'human', at: AT });
  return { input: s.inputs[before] ?? '', id };
}

async function timingCount(s: Boot): Promise<number> {
  return (await s.stores.journal.list({ types: ['turn_timing'] })).length;
}

/** 次の回を投げて良い状態まで待つ: 結果が返って `turn_timing` が日誌に載ったら前のターンは終わっている。 */
async function settle(s: Boot, count: number): Promise<void> {
  await waitFor(
    async () => (await timingCount(s)) >= count,
    `ターン終わり（${String(count)} 本目）`,
  );
}

describe('断り書きの待ち行列の先頭は、同じ待ち行列でも毎回全文', () => {
  it('節約が無効（既定）なら毎回全文', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 12; i += 1) await stores.tasks.add(seededTask(`old-${String(i)}`));
    const s = boot({ stores });
    for (let i = 0; i < 4; i += 1) {
      const result = await turn(s);
      expect(result.input).not.toContain(FOLDED);
      expect(result.input).toContain(HEAD);
    }
    await s.clone.stop();
  });
});

describe('預けた控え（fold-state）の互換: 鍵が増えても読める。鍵が無い古い控えは全文になる', () => {
  const base = (situation: [string, string][]): FoldState => ({
    v: 1,
    sessionId: 'sess-1',
    situation,
    turnsSinceFull: 3,
    digest: { sections: null, fixed: [], requests: [], paragraphs: [], reports: [] },
    usage: null,
    growthTokens: 0,
  });

  it('新しい鍵（taskQueueHead）入りの控えは、そのまま預けて読み戻せる', () => {
    const raw = serializeFoldState(base([['taskQueueHead', '- 待ち行列: 開いている 1 件']]));
    expect(raw).not.toBeNull();
    expect(parseFoldState(raw!)?.situation).toEqual([
      ['taskQueueHead', '- 待ち行列: 開いている 1 件'],
    ]);
  });

  it('鍵が無い古い控えも読める（読み戻した後 `get` が undefined なので全文になる）', () => {
    const raw = serializeFoldState(base([['materials', 'm']]));
    const parsed = parseFoldState(raw!);
    expect(parsed).not.toBeNull();
    expect(new Map(parsed!.situation).get('taskQueueHead')).toBeUndefined();
  });
});
