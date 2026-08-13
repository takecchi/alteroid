/**
 * 生成クライアントが**実際にデーモンへ繋がること**を見る。
 *
 * `app.request()` ではなく本物の TCP を開けて叩くのは、ここで確かめたいのが
 * 「外部アプリから HTTP API 経由でクローンに指示を送り、進捗・日誌・保留を
 * 取得できる」（PRD 利用シナリオ8）という**外からの経路**だからである。
 * 同一プロセスで呼べても、それは spec が正しいことの証拠にならない。
 */

import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import type { ChatStreamEvent, CloneHost, ManagerPool, Stores } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { createApp, createJournalBus } from '@alteroid/daemon';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createAlteroidClient, type AlteroidClient } from './index.js';

/**
 * クローンの代わり。話しかけられたら承認待ちを1件立てて `ask_human` を流す
 * （＝外から「保留を取得して答える」までを通せる状態を作る）。
 */
function fakeClone(stores: Stores) {
  const listeners = new Map<string, Set<(event: ChatStreamEvent) => void>>();
  const answered: { id: string; answer: string }[] = [];

  const managers: ManagerPool = {
    async start() {
      throw new Error('この偽クローンからはマネージャーを起こさない');
    },
    async send() {
      return { outcome: 'unknown' as const, detail: '居ない' };
    },
    async abort() {
      return { outcome: 'unknown' as const, detail: '居ない' };
    },
    async list() {
      return [];
    },
    async transcript() {
      return null;
    },
    async restore() {
      return [];
    },
    async rebalance() {
      return [];
    },
    async move(managerId: string) {
      return { moved: null, detail: `${managerId} は居ない` };
    },
    async stop() {},
  };

  const clone: CloneHost = {
    managers,
    post(event) {
      if (event.type !== 'human_message') return;
      const conversationId = event.conversationId;
      void (async () => {
        await stores.journal.append({
          type: 'exchange',
          with: 'human',
          role: 'inbound',
          text: event.text,
          conversationId,
        });
        await stores.jobs.putApproval({
          id: 'approval-1',
          createdAt: new Date().toISOString(),
          question: '本番に出してよいか',
        });
        for (const item of [
          { type: 'text', text: 'わかった' },
          { type: 'ask_human', approvalId: 'approval-1', question: '本番に出してよいか' },
          { type: 'done' },
        ] satisfies ChatStreamEvent[]) {
          for (const listener of listeners.get(conversationId) ?? []) listener(item);
        }
      })();
    },
    subscribe(conversationId, listener) {
      const set = listeners.get(conversationId) ?? new Set();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => set.delete(listener);
    },
    async endConversation() {},
    async answerApproval(id, answer) {
      answered.push({ id, answer });
      const approval = await stores.jobs.getApproval(id);
      if (approval !== null) {
        await stores.jobs.putApproval({
          ...approval,
          answeredAt: new Date().toISOString(),
          answer,
        });
      }
    },
    async stop() {},
  };

  return { clone, answered };
}

let server: ServerType;
let client: AlteroidClient;
let stores: Stores;
let fake: ReturnType<typeof fakeClone>;

beforeEach(async () => {
  const base = createMemoryStores();
  // 日誌の SSE はバスが配線されていないと 503 を返す（黙って隠さない作りになっている）
  const journalBus = createJournalBus(base.journal);
  stores = { ...base, journal: journalBus.journal };
  fake = fakeClone(stores);
  const app = createApp({
    clone: fake.clone,
    stores,
    token: 'test-token',
    shutdown: () => {},
    journalEvents: journalBus,
  });

  server = await new Promise<ServerType>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve(created),
    );
  });
  const address = server.address() as AddressInfo;
  client = createAlteroidClient({ baseUrl: `http://127.0.0.1:${address.port}` });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('外部アプリが chat → 保留の取得 → 回答 → 日誌の取得まで通せる', async () => {
  // 1. 指示を送る（SSE で返答が流れてくる）
  const events: string[] = [];
  let conversationId: string | undefined;
  let approvalId: string | undefined;

  for await (const message of client.chat({ text: '本番に出したい' })) {
    events.push(message.event);
    if (message.event === 'open') conversationId = message.data.conversationId;
    if (message.data !== undefined && 'type' in message.data) {
      if (message.data.type === 'ask_human') approvalId = message.data.approvalId;
      if (message.data.type === 'done') break;
    }
  }

  expect(events).toEqual(['open', 'text', 'ask_human', 'done']);
  expect(conversationId).toBeTypeOf('string');
  expect(approvalId).toBe('approval-1');

  // 2. 承認待ちを取得する
  const pending = await client.api.GET('/approvals', { params: { query: { pending: 'true' } } });
  expect(pending.response.status).toBe(200);
  expect(pending.data?.approvals.map((entry) => entry.id)).toEqual(['approval-1']);
  expect(pending.data?.approvals[0]?.question).toBe('本番に出してよいか');

  // 3. 答える（人間の不在で止まっていた仕事がここで再開する）
  const answer = await client.api.POST('/approvals/{id}/answer', {
    params: { path: { id: 'approval-1' } },
    body: { answer: '出してよい' },
  });
  expect(answer.response.status).toBe(200);
  expect(fake.answered).toEqual([{ id: 'approval-1', answer: '出してよい' }]);

  // 二度答えれば 409（spec に載っているエラーが実際に返ること）
  const again = await client.api.POST('/approvals/{id}/answer', {
    params: { path: { id: 'approval-1' } },
    body: { answer: 'もう一度' },
  });
  expect(again.response.status).toBe(409);

  // 4. 日誌を読む
  const journal = await client.api.GET('/journal', { params: { query: { limit: 50 } } });
  expect(journal.response.status).toBe(200);
  expect(journal.data?.entries.some((entry) => entry.type === 'exchange')).toBe(true);

  // 5. 会話も外から読み直せる（器を替えても続きから話せること自体が要件）
  const conversation = await client.api.GET('/conversations/{id}', {
    params: { path: { id: conversationId as string }, query: {} },
  });
  expect(conversation.response.status).toBe(200);
  expect(conversation.data?.messages[0]?.text).toBe('本番に出したい');
});

it('日誌の SSE を外から購読できる（承認待ちが出たことに気づける）', async () => {
  const seen: string[] = [];
  const controller = new AbortController();

  const reading = (async () => {
    for await (const message of client.journalStream({ signal: controller.signal })) {
      seen.push(message.event);
      if (message.event === 'memory_update') break;
    }
  })();

  // 購読が張られてから追記する（open を受け取るまで待つ）
  await vi.waitFor(() => expect(seen).toContain('open'));
  await stores.journal.append({
    type: 'memory_update',
    slug: 'test',
    cause: 'human',
    summary: '外から見えるか',
  });

  await reading;
  controller.abort();
  expect(seen).toEqual(['open', 'memory_update']);
});

it('本文の無い POST にも content-type が付く（deliberateClient を素通りできる）', async () => {
  const ended = await client.api.POST('/chat/{conversationId}/end', {
    params: { path: { conversationId: 'なんでもよい' } },
  });
  expect(ended.response.status).toBe(200);
});
