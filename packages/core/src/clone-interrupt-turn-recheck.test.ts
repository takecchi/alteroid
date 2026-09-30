import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';

/**
 * `interruptTurn` の「日誌を書いている間にターンが入れ替わる」窓と、
 * `q.interrupt()` が投げる窓（#2488）。
 *
 * ターンごとに握る偽 SDK を使う。`interrupt` は呼び出しを数え、指示があれば投げる。
 */
function gatedSdk(interrupt: () => Promise<void>) {
  const calls: { inputs: string[] }[] = [];
  const gates: (() => void)[] = [];
  const interrupts = { count: 0 };
  const state = { open: false };
  const openAll = () => {
    state.open = true;
    gates.forEach((g) => g());
  };

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const call = { inputs: [] as string[] };
    const isSideQuery = typeof params.prompt === 'string';
    if (!isSideQuery) calls.push(call);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (isSideQuery) {
        // 蒸留などのサイドクエリ（prompt が文字列）は握らず、すぐ終える。
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-side',
          uuid: 'uuid-side',
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        call.inputs.push(String(message.message.content));
        // 終わりの合図（`stop()` の蒸留など）は `openAll()` の後に届くので素通りさせる。
        if (!state.open) await new Promise<void>((resolve) => gates.push(resolve));
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
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => {
        interrupts.count += 1;
        await interrupt();
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls, gates, interrupts, openAll };
}

function build(interrupt: () => Promise<void> = async () => undefined) {
  const stores = createMemoryStores();
  const sdk = gatedSdk(interrupt);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: sdk.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { stores, clone, ...sdk };
}

async function exchangeTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.map((row) => (row as unknown as { text: string }).text);
}

const STOPPED = '人間の求めで、走っているターンを止めた';

describe('クローン — interruptTurn は日誌を書いた後にもう一度ターンを確かめる（#2488）', () => {
  it('(c) 通常の順では interrupt を呼び、interrupted を返す', async () => {
    const t = build();
    t.clone.post(humanMessage('長いターン'));
    await waitFor(() => t.calls.some((c) => c.inputs.length === 1), 'ターンが始まる');

    await expect(t.clone.interruptTurn!()).resolves.toBe('interrupted');
    expect(t.interrupts.count).toBe(1);
    const texts = await exchangeTexts(t.stores);
    expect(texts.filter((x) => x.includes(STOPPED))).toHaveLength(1);
    expect(texts.some((x) => x.includes('止めなかった'))).toBe(false);

    t.openAll();
    await t.clone.stop();
  });

  it('(a) 日誌を書いている間にターンが入れ替わったら、interrupt を呼ばず打ち消しの行を残す', async () => {
    const t = build();
    const journal = t.stores.journal as unknown as {
      append: (entry: unknown) => Promise<unknown>;
    };
    const original = journal.append.bind(journal);
    let swapped = false;
    journal.append = async (entry) => {
      const text = (entry as { text?: string }).text ?? '';
      if (!swapped && text.includes(STOPPED)) {
        swapped = true;
        // 1本目のターンを終わらせ、次のターンを始めてから日誌へ書く。
        t.gates[0]!();
        t.clone.post(humanMessage('次のターン'));
        await waitFor(() => t.calls.some((c) => c.inputs.length === 2), '次のターンが始まる');
      }
      return original(entry);
    };

    t.clone.post(humanMessage('長いターン'));
    await waitFor(() => t.calls.some((c) => c.inputs.length === 1), 'ターンが始まる');

    await expect(t.clone.interruptTurn!()).resolves.toBe('idle');
    expect(t.interrupts.count).toBe(0);
    const texts = await exchangeTexts(t.stores);
    expect(
      texts.filter((x) => x.includes('止めようとしたターンは既に終わっていたので、止めなかった')),
    ).toHaveLength(1);

    t.openAll();
    await t.clone.stop();
  });

  it('(b) interrupt が投げたら、打ち消しの行を残し、例外が上へ伝わる', async () => {
    const t = build(async () => {
      throw new Error('boom-2488');
    });
    t.clone.post(humanMessage('長いターン'));
    await waitFor(() => t.calls.some((c) => c.inputs.length === 1), 'ターンが始まる');

    await expect(t.clone.interruptTurn!()).rejects.toThrow('boom-2488');
    const texts = await exchangeTexts(t.stores);
    const cancel = texts.filter((x) => x.includes('止められなかった'));
    expect(cancel).toHaveLength(1);
    expect(cancel[0]).toContain('boom-2488');

    t.openAll();
    await t.clone.stop();
  });
});
