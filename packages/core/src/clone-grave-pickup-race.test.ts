import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

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

function bootClone(stores: Stores, fake: Fake): CloneHost {
  return createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
}

function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

async function waitForJournal(stores: Stores, needle: string): Promise<void> {
  await waitFor(async () => {
    const entries = await stores.journal.list();
    return entries.some((entry) => JSON.stringify(entry).includes(needle));
  }, `日誌に「${needle}」が出る`);
}

describe('拾い上げが新しい印を消す（#1157 段2）', () => {
  it('⭐ 退避が見つからない分岐: 拾っている間に立った新しい印まで消える', async () => {
    const base = createMemoryStores();
    await base.sessions.setTranscriptGrave({ archiveId: 'arc-old' });

    const stores: Stores = {
      ...base,
      archive: {
        ...base.archive,
        readTail: async (id: string, maxChars: number) => {
          const result = await base.archive.readTail(id, maxChars);
          if (id === 'arc-old') {
            await base.sessions.setTranscriptGrave({ archiveId: 'arc-new' });
          }
          return result;
        },
      },
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await clone.stop();

    expect(await base.sessions.getTranscriptGrave()).toEqual({ archiveId: 'arc-new' });
  });

  it('⭐ 生ログが1件も無い分岐: 同じ形で新しい印が消える', async () => {
    const base = createMemoryStores();
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });

    const tail = {
      readTail: async () => {
        await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-new' });
        return null;
      },
    };
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: tail as unknown as Stores['sessionTranscriptTail'],
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    expect(await base.sessions.getLostSessionGrave()).toEqual({
      projectKey: 'proj',
      sessionId: 'sess-new',
    });
  });

  it('⛔ 陰性対照: 新しい印が立たなければ、退避が無い印はちゃんと下ろされる', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setTranscriptGrave({ archiveId: 'arc-old' });

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await clone.stop();

    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
  });

  it('⛔ 陰性対照: 新しい印が立たなければ、生ログが無い印もちゃんと下ろされる', async () => {
    const base = createMemoryStores();
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: {
        readTail: () => Promise.resolve(null),
      } as unknown as Stores['sessionTranscriptTail'],
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    expect(await base.sessions.getLostSessionGrave()).toBeNull();
  });

  it('⭐ 拾い上げは印を素の set(null) では下ろさない（判定と書き込みが1操作である）', async () => {
    const base = createMemoryStores();
    await base.sessions.setTranscriptGrave({ archiveId: 'arc-old' });
    await base.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-old' });

    const nullWrites: string[] = [];
    const stores: Stores = {
      ...base,
      sessionTranscriptTail: {
        readTail: () => Promise.resolve(null),
      } as unknown as Stores['sessionTranscriptTail'],
      sessions: {
        ...base.sessions,
        setTranscriptGrave: async (g) => {
          if (g === null) nullWrites.push('transcript');
          return base.sessions.setTranscriptGrave(g);
        },
        setLostSessionGrave: async (g) => {
          if (g === null) nullWrites.push('lost');
          return base.sessions.setLostSessionGrave(g);
        },
      },
    };

    const fake = fakeSdk();
    const clone = bootClone(stores, fake);
    clone.post(report('起動する'));
    await waitForJournal(stores, '記憶へ移せていない区間の退避');
    await waitForJournal(stores, '捨てたセッションの生ログが1件も無');
    await clone.stop();

    expect(await base.sessions.getTranscriptGrave()).toBeNull();
    expect(await base.sessions.getLostSessionGrave()).toBeNull();
    expect(nullWrites).toEqual([]);
  });
});
