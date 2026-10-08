import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { readWithdrawnClientMessageIds } from './conversation.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';

function gatedSdk() {
  const inputs: string[] = [];
  const gates: (() => void)[] = [];
  const interrupts = { count: 0 };
  const state = { open: false };
  const openAll = () => {
    state.open = true;
    gates.forEach((g) => g());
  };

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const isSideQuery = typeof params.prompt === 'string';
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (isSideQuery) {
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
        inputs.push(String(message.message.content));
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
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs, gates, interrupts, openAll };
}

function build() {
  const stores = createMemoryStores();
  const sdk = gatedSdk();
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

function said(text: string, conversationId: string, clientMessageId: string): InboxEvent {
  return { ...humanMessage(text, conversationId), clientMessageId } as InboxEvent;
}

async function pendingIds(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  return (await stores.inbox.peekPending()).entries.map((row) => row.event.id);
}

const A = { conversationId: 'conv-a', clientMessageId: 'cm-a' };
const B = { conversationId: 'conv-b', clientMessageId: 'cm-b' };

async function exchangeTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.map((row) => (row as unknown as { text: string }).text);
}

describe('クローン — interruptTurn の対象指定（#3956）', () => {
  it('対象の発言のターンが走っていれば止める', async () => {
    const t = build();
    t.clone.post(said('先客', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1, 'ターンが始まる');

    await expect(t.clone.interruptTurn!(A)).resolves.toBe('interrupted');
    expect(t.interrupts.count).toBe(1);

    t.openAll();
    await t.clone.stop();
  });

  it('順番待ちの発言は取り下げる: 器から消え、配られず、先客のターンは止まらず、日誌に跡が残る', async () => {
    const t = build();
    t.clone.post(said('先客', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1, '先客のターンが始まる');
    t.clone.post(said('自分の発言', B.conversationId, B.clientMessageId));
    await waitFor(async () => (await pendingIds(t.stores)).length === 2, '2件が器に載る');

    await expect(t.clone.interruptTurn!(B)).resolves.toBe('withdrawn');

    expect(t.interrupts.count).toBe(0);
    expect(await pendingIds(t.stores)).toEqual(['evt-先客']);
    const texts = await exchangeTexts(t.stores);
    expect(
      texts.filter((x) => x.includes('順番待ちだった発言') && x.includes('取り下げた')),
    ).toHaveLength(1);
    // 発言そのものの行は消さない
    expect(texts.some((x) => x.includes('自分の発言'))).toBe(true);
    // 履歴の読み直しが「取り下げた」と言う根拠: 文面ではなく、発言の clientMessageId を持つ印（#3990）
    const marks = (await t.stores.journal.list({ types: ['exchange'], with: ['self'] })).filter(
      (row) => row.type === 'exchange' && row.withdrawnClientMessageId !== undefined,
    );
    expect(marks.map((row) => row.type === 'exchange' && row.withdrawnClientMessageId)).toEqual([
      B.clientMessageId,
    ]);
    expect(marks[0]).toMatchObject({ conversationId: B.conversationId });
    await expect(
      readWithdrawnClientMessageIds(t.stores.journal, B.conversationId, '1970-01-01T00:00:00.000Z'),
    ).resolves.toEqual(new Set([B.clientMessageId]));

    t.openAll();
    await waitFor(() => t.clone.activeTurn!() === null, '先客のターンが終わる');
    expect(t.inputs).toHaveLength(1);
    await t.clone.stop();
  });

  it('別の起点のターンが走っていて、対象がどこにも居なければ止めない（not_target）', async () => {
    const t = build();
    t.clone.post(said('先客', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1, 'ターンが始まる');

    await expect(t.clone.interruptTurn!(B)).resolves.toBe('not_target');
    expect(t.interrupts.count).toBe(0);

    t.openAll();
    await t.clone.stop();
  });

  it('何も走っていなければ idle', async () => {
    const t = build();
    await expect(t.clone.interruptTurn!(A)).resolves.toBe('idle');
    await t.clone.stop();
  });

  it('対象が答え終わっていれば idle（後続のターンを止めない）', async () => {
    const t = build();
    t.openAll();
    t.clone.post(said('終わる', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1 && t.clone.activeTurn!() === null, '答え終わる');
    t.clone.post(said('次', B.conversationId, B.clientMessageId));
    await waitFor(() => t.inputs.length === 2, '次のターンが始まる');
    await waitFor(() => t.clone.activeTurn!() === null, '次のターンも終わる');

    await expect(t.clone.interruptTurn!(A)).resolves.toBe('idle');
    expect(t.interrupts.count).toBe(0);
    await t.clone.stop();
  });

  it('対象を省けば、これまでどおり走っているターンを種類を問わず止める', async () => {
    const t = build();
    t.clone.post(said('先客', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1, 'ターンが始まる');

    await expect(t.clone.interruptTurn!()).resolves.toBe('interrupted');
    expect(t.interrupts.count).toBe(1);

    t.openAll();
    await t.clone.stop();
  });

  it('取り下げの器の書き込み中に順番が来たら、取り下げたと偽らず、そのターンを止める', async () => {
    const t = build();
    t.clone.post(said('先客', A.conversationId, A.clientMessageId));
    await waitFor(() => t.inputs.length === 1, '先客のターンが始まる');
    t.clone.post(said('自分の発言', B.conversationId, B.clientMessageId));
    await waitFor(async () => (await pendingIds(t.stores)).length === 2, '2件が器に載る');

    // 器の消し込みの await の間に、先客が終わって対象のターンが始まる。
    const inbox = t.stores.inbox;
    const original = inbox.removeMany.bind(inbox);
    inbox.removeMany = async (ids) => {
      t.gates[0]!();
      await waitFor(() => t.inputs.length === 2, '対象のターンが始まる');
      return original(ids);
    };

    await expect(t.clone.interruptTurn!(B)).resolves.toBe('interrupted');
    expect(t.interrupts.count).toBe(1);

    t.openAll();
    await t.clone.stop();
  });
});
