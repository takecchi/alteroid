import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const SECRET = 'sk-ant-秘密の鍵-0123456789';

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

function setupApp() {
  const stores = createMemoryStores();
  const queryFn = echoSdk();
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, stores };
}

type App = ReturnType<typeof createApp>;

const auth = { authorization: 'Bearer test-token' };

const request = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function seedConversation(
  stores: Stores,
  conversationId: string,
  text: string,
  attachments?: { id: string; name: string; mediaType: string; size: number; sha256: string }[],
) {
  return stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    conversationId,
    ...(attachments === undefined ? {} : { attachments }),
  });
}

interface DeleteBody {
  conversationId: string;
  tombstoneId: string;
  hiddenCount: number;
  attachmentsRemoved: number;
  tasksRemoved: number;
  queuedDropped: number;
  approvalsLinked: number;
  incomplete: string[];
  remainsIn: string[];
}

describe('DELETE /conversations/:id（#4218）', () => {
  it('消した会話の発言は、会話の一覧・中身・日誌（一覧・検索・id）から外れ、ほかの会話は残る', async () => {
    const { app, stores } = setupApp();
    const secretEntry = await seedConversation(stores, 'conv-secret', `鍵は ${SECRET}`);
    await seedConversation(stores, 'conv-keep', '残す会話');

    const response = await request(app, 'DELETE', '/conversations/conv-secret');
    expect(response.status).toBe(200);
    const body = (await response.json()) as DeleteBody;
    expect(body.conversationId).toBe('conv-secret');
    expect(body.hiddenCount).toBe(1);
    expect(body.incomplete).toEqual([]);

    expect((await request(app, 'GET', '/conversations/conv-secret')).status).toBe(404);
    const list = (await (await request(app, 'GET', '/conversations')).json()) as {
      conversations: { conversationId: string }[];
    };
    expect(list.conversations.map((entry) => entry.conversationId)).toEqual(['conv-keep']);

    const journalText = await (await request(app, 'GET', '/journal')).text();
    expect(journalText).not.toContain(SECRET);
    const searched = await (
      await request(app, 'GET', `/journal?q=${encodeURIComponent('秘密の鍵')}`)
    ).text();
    expect(searched).not.toContain(SECRET);
    expect(await stores.journal.get(secretEntry.id)).toBeNull();
  });

  it('監査の墓標を1行残す（誰が・どの会話を・何件）。本文は写さない', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-secret', SECRET);
    await seedConversation(stores, 'conv-secret', 'もう1通');

    const body = (await (
      await request(app, 'DELETE', '/conversations/conv-secret')
    ).json()) as DeleteBody;

    const tombstones = await stores.journal.list({ types: ['conversation_deleted'] });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      id: body.tombstoneId,
      type: 'conversation_deleted',
      deletedConversationId: 'conv-secret',
      deletedBy: 'operator',
      hiddenCount: 2,
    });
    expect(JSON.stringify(tombstones[0])).not.toContain(SECRET);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('無い会話・消し済みの会話・略記は 404 で、何も積まない', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3', '本物');

    const short = await request(app, 'DELETE', '/conversations/bf63fd3d');
    expect(short.status).toBe(404);
    expect(((await short.json()) as { code: string }).code).toBe('conversation_not_found');
    expect(await stores.journal.list({ types: ['conversation_deleted'] })).toEqual([]);

    expect(
      (await request(app, 'DELETE', '/conversations/bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3')).status,
    ).toBe(200);
    expect(
      (await request(app, 'DELETE', '/conversations/bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3')).status,
    ).toBe(404);
    expect(await stores.journal.list({ types: ['conversation_deleted'] })).toHaveLength(1);
  });

  it('その会話の発言に付いた添付を物理的に消す（id で引いても 404）。ほかの会話の添付は残る', async () => {
    const { app, stores } = setupApp();
    const gone = await stores.attachments.put({
      name: 'key.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(SECRET),
    });
    const kept = await stores.attachments.put({
      name: 'keep.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('残す'),
    });
    await stores.attachments.bind([gone.id], 'conv-secret');
    await stores.attachments.bind([kept.id], 'conv-keep');
    const ref = (meta: typeof gone) => ({
      id: meta.id,
      name: meta.name,
      mediaType: meta.mediaType,
      size: meta.size,
      sha256: meta.sha256,
    });
    await seedConversation(stores, 'conv-secret', '添付', [ref(gone)]);
    await seedConversation(stores, 'conv-keep', '添付', [ref(kept)]);

    const body = (await (
      await request(app, 'DELETE', '/conversations/conv-secret')
    ).json()) as DeleteBody;

    expect(body.attachmentsRemoved).toBe(1);
    expect(await stores.attachments.get(gone.id)).toBeUndefined();
    expect((await request(app, 'GET', `/attachments/${gone.id}`)).status).toBe(404);
    expect(await stores.attachments.get(kept.id)).toBeDefined();
  });

  it('その会話から開いた Task（人間の発言の全文を本文に持つ）を物理的に消し、tasksRemoved で件数を返す。ほかの会話の Task は残る（#5899）', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-secret', SECRET);
    await seedConversation(stores, 'conv-keep', '残す');
    const at = '2026-10-08T10:00:00.000Z';
    await stores.tasks.add({
      id: 'task-secret',
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'human',
      source: 'conv-secret',
      originConversationId: 'conv-secret',
      title: 'secret',
      body: SECRET,
    });
    await stores.tasks.add({
      id: 'task-keep',
      createdAt: at,
      updatedAt: at,
      status: 'queued',
      origin: 'human',
      source: 'conv-keep',
      originConversationId: 'conv-keep',
      title: 'keep',
      body: '残す',
    });

    const body = (await (
      await request(app, 'DELETE', '/conversations/conv-secret')
    ).json()) as DeleteBody;

    expect(body.tasksRemoved).toBe(1);
    expect(await stores.tasks.get('task-secret')).toBeNull();
    expect(await stores.tasks.get('task-keep')).not.toBeNull();
  });

  it('消した会話へは送れず（POST /chat は 404）、途中経過の SSE も 404', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-secret', SECRET);
    await request(app, 'DELETE', '/conversations/conv-secret');

    expect(
      (await request(app, 'POST', '/chat', { text: '続き', conversationId: 'conv-secret' })).status,
    ).toBe(404);
    const stream = await request(app, 'GET', '/chat/conv-secret/stream');
    expect(stream.status).toBe(404);
    expect(((await stream.json()) as { code: string }).code).toBe('conversation_deleted');
  });

  it('消せないもの（生ログ・セッションの開き直し・記憶・承認の本文）を remainsIn で言う', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-secret', SECRET);

    const body = (await (
      await request(app, 'DELETE', '/conversations/conv-secret')
    ).json()) as DeleteBody;

    const joined = body.remainsIn.join('\n');
    expect(joined).toContain('生ログ');
    // 開き直す先は設定の節の名前で言う: 画面にそのまま出る文なので、Issue 番号では辿れないため
    expect(joined).toContain('設定の「クローンのセッションを開き直す」');
    expect(joined).toContain('記憶');
    expect(joined).toContain('承認');
    expect(joined).toContain(
      '旧台帳（廃止した。どの読む口からも読めないが、データベースにはテーブルが残っている）のこの会話の行は消していない',
    );
  });

  it('remainsIn は画面にそのまま出るので、内部の名前（表名・道具名・SDK・Issue 番号）を言わない（#5905）', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-words', '消す会話');

    const body = (await (
      await request(app, 'DELETE', '/conversations/conv-words')
    ).json()) as DeleteBody;

    const joined = body.remainsIn.join('\n');
    for (const word of ['session_entries', 'archive', 'ask_human', 'request_permission', 'SDK']) {
      expect(joined).not.toContain(word);
    }
    expect(joined).not.toMatch(/#\d+/);
    expect(joined).not.toMatch(/会話 id/);
  });

  it('その会話を起点とする Task（閉じた行も）の本文を写した日誌の行は、どの読む口からも出ない。別の会話の Task の行は残る（#4355 の Task 版）', async () => {
    const { app, stores } = setupApp();
    await seedConversation(stores, 'conv-x', `鍵は ${SECRET}`);
    await seedConversation(stores, 'conv-keep', '残る会話');
    const at = '2026-10-08T10:00:00.000Z';
    const task = (id: string, conversationId: string, body: string) => ({
      id,
      createdAt: at,
      updatedAt: at,
      status: 'queued' as const,
      origin: 'human' as const,
      source: conversationId,
      originConversationId: conversationId,
      title: id,
      body,
    });
    await stores.tasks.add(task('human-1', 'conv-x', `鍵 ${SECRET} を確認`));
    await stores.tasks.add(task('closed-1', 'conv-x', `鍵 ${SECRET} を閉じた`));
    await stores.tasks.setStatus('closed-1', 'done', { reason: '済んだ', by: 'human', at });
    await stores.tasks.add(task('human-keep', 'conv-keep', '残る仕事'));
    // 台帳から移した行は起点の欄を持たず、会話は source にだけ残る
    await stores.tasks.add({
      ...task('migrated-1', 'conv-x', `鍵 ${SECRET} を忘れずに`),
      origin: 'self' as const,
      originConversationId: undefined,
    });

    const copy = await stores.journal.append({
      type: 'decision',
      decision: `人間が task を積んだ（human-1）: 鍵 ${SECRET} を確認`,
      grounds: '人間が直接 API から積んだ',
    });
    const closedCopy = await stores.journal.append({
      type: 'decision',
      decision: `task を done にした（closed-1）: 鍵 ${SECRET} を閉じた`,
      grounds: '閉じた行も隠す',
    });
    const migratedCopy = await stores.journal.append({
      type: 'decision',
      decision: `引き受けた仕事として台帳に載せた（migrated-1）: 鍵 ${SECRET} を忘れずに`,
      grounds: '台帳から移した行の古い写し',
    });
    await stores.journal.append({
      type: 'decision',
      decision: '人間が task を積んだ（human-keep）: 残る仕事',
      grounds: '別の会話',
    });
    // 一括の行（id の並び）は拾わない
    await stores.journal.append({
      type: 'decision',
      decision: '閉じた id: human-1 human-keep',
      grounds: '一括',
    });

    expect((await request(app, 'DELETE', '/conversations/conv-x')).status).toBe(200);

    const journal = await (await request(app, 'GET', '/journal?limit=500')).text();
    expect(journal).not.toContain(SECRET);
    expect(journal).toContain('残る仕事');
    expect(journal).toContain('閉じた id: human-1 human-keep');
    for (const entry of [copy, closedCopy, migratedCopy]) {
      expect((await request(app, 'GET', `/journal/${entry.id}`)).status).toBe(404);
    }
    const searched = await (
      await request(app, 'GET', `/journal?q=${encodeURIComponent('秘密の鍵')}&limit=50`)
    ).text();
    expect(searched).not.toContain(SECRET);
  });
});
