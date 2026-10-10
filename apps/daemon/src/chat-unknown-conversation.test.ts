import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function echoSdk(): typeof import('@anthropic-ai/claude-agent-sdk').query {
  let turns = 0;
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        uuid: 'u-init',
        model: 'claude-fake',
        claude_code_version: '9.9.9',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [],
      } as unknown as SDKMessage;
      const prompt = params.prompt;
      if (typeof prompt === 'string') return;
      for await (const message of prompt as AsyncIterable<unknown>) {
        void message;
        turns += 1;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '了解' }] },
          parent_tool_use_id: null,
          session_id: 's',
          uuid: `u-a-${turns}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '了解',
          session_id: 's',
          uuid: `u-r-${turns}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
}

function setupApp(stores: Stores = createMemoryStores()) {
  const queryFn = echoSdk();
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, stores };
}

type App = ReturnType<typeof createApp>;

const post = async (app: App, body: Record<string, unknown>): Promise<Response> =>
  app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function seedConversation(stores: Stores, conversationId: string): Promise<void> {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: '人間の発言',
    conversationId,
  });
}

async function humanConversationIds(stores: Stores): Promise<(string | undefined)[]> {
  return (await stores.journal.list({ types: ['exchange'], with: ['human'] })).map((entry) =>
    entry.type === 'exchange' ? entry.conversationId : undefined,
  );
}

/** SSE を `open` まで読み、その会話 id を返す（残りは読まずに置く）。 */
async function readOpenConversationId(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`open が来なかった: ${buffered}`);
    buffered += decoder.decode(value, { stream: true });
    const match = /event: open\ndata: (.+)\n/.exec(buffered);
    if (match?.[1] !== undefined) {
      reader.releaseLock();
      return (JSON.parse(match[1]) as { conversationId: string }).conversationId;
    }
  }
}

describe('POST /chat は、無い会話の id で会話を作らない（#4149）', () => {
  it('渡した id の会話が無ければ 404（conversation_not_found）で、日誌に何も積まない', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-1');

    const response = await post(app, { text: 'やあ', conversationId: 'conv-unknown' });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('conversation_not_found');
    expect(body.error).toContain('会話 conv-unknown は無い');
    expect(body.error).toContain('新しい会話を始めるなら conversationId を省くこと');
    expect(await humanConversationIds(stores)).toEqual(['conv-1']);
  });

  it('略記では受けない。前方一致する会話が1つなら、error に完全な id を出す', async () => {
    const { app, stores } = setupApp();
    const full = 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3';
    await seedConversation(stores, full);

    const response = await post(app, { text: '続き', conversationId: 'bf63fd3d' });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain(`bf63fd3d で始まる会話は1つだけ在る: ${full}`);
    expect(await humanConversationIds(stores)).toEqual([full]);
  });

  it('無い会話の id に添付を付けても、添付をその id へ結ばない', async () => {
    const { app, stores } = setupApp();
    const meta = await stores.attachments.put({
      name: 'a.txt',
      mediaType: 'text/plain',
      bytes: new Uint8Array([65]),
    });

    const response = await post(app, {
      text: '添付',
      conversationId: 'conv-unknown',
      attachments: [meta.id],
    });

    expect(response.status).toBe(404);
    expect((await stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();
  });

  it('在る会話へは続けて送れる', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-1');

    const response = await post(app, { text: '続き', conversationId: 'conv-1' });
    await response.text();

    expect(response.status).toBe(200);
  });

  it('id を省いて始めた会話へは、1通目が日誌に載る前でも続けて送れる（open 直後の追送）', async () => {
    const base = createMemoryStores();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 人間の発言の日誌への追記を止めておき、「open は返ったが日誌にはまだ無い」窓を作る
    const stores: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: async (entry) => {
          if (entry.type === 'exchange' && entry.with === 'human' && entry.role === 'inbound') {
            await held;
          }
          return base.journal.append(entry);
        },
      },
    };
    const { app } = setupApp(stores);

    const first = await post(app, { text: '始める' });
    expect(first.status).toBe(200);
    const conversationId = await readOpenConversationId(first);
    expect(await humanConversationIds(base)).toEqual([]);

    const second = await post(app, { text: '追送', conversationId });

    expect(second.status).toBe(200);
    release();
    await second.text();
    await first.body?.cancel();
  });
});
