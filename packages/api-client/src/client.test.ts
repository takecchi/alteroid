import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import type { ChatStreamEvent, CloneHost, ManagerPool, Stores } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { createApp, createJournalBus } from '@alteroid/daemon';
import createClient from 'openapi-fetch';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createAlteroidClient, type AlteroidClient, type paths } from './index.js';

function fakeClone(stores: Stores) {
  const listeners = new Map<string, Set<(event: ChatStreamEvent) => void>>();
  const answered: { id: string; answer: string }[] = [];
  const inProgress = new Map<string, ChatStreamEvent[]>();
  const emit = (conversationId: string, event: ChatStreamEvent) => {
    for (const listener of listeners.get(conversationId) ?? []) listener(event);
  };

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
    denials() {
      return [];
    },
    runnerBacklog() {
      return [];
    },
    async runnerIdOf() {
      return undefined;
    },
    async runners() {
      return { runners: [], unassigned: [], daemonRevision: { status: 'unknown' } };
    },
    pushHealthOf() {
      return undefined;
    },
    async transcript() {
      return { kind: 'missing' as const };
    },
    async unpushedWork() {
      return { kind: 'unavailable' as const, reason: '(この検証では未使用)' };
    },
    runningManagerOwning() {
      return undefined;
    },
    async restore() {
      return [];
    },
    async resumeStoppedByUsage() {
      return [];
    },
    async reattachRunner() {},
    relocateFrom() {},
    async vacate() {
      return {};
    },
    async probeTurnEnds() {},
    async flushWithheldReports() {},
    async settleStalledUsageWakes() {
      return [];
    },
    async renotifyStalledDenials() {},
    async stop() {},
  };

  const clone: CloneHost = {
    async postPersisted() {
      return 'persisted';
    },
    managers,
    recycleSessionForToken() {},
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async dropQueuedInboxEvents() {
      return 0;
    },
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
    attach(conversationId, listener) {
      const snapshot = inProgress.get(conversationId);
      const set = listeners.get(conversationId) ?? new Set();
      set.add(listener);
      listeners.set(conversationId, set);
      return {
        inProgress: snapshot === undefined ? null : [...snapshot],
        unsubscribe: () => set.delete(listener),
      };
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

  return { clone, answered, inProgress, emit, listeners };
}

let server: ServerType;
let client: AlteroidClient;
let stores: Stores;
let fake: ReturnType<typeof fakeClone>;

beforeEach(async () => {
  const base = createMemoryStores();
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

  const pending = await client.api.GET('/approvals', { params: { query: { pending: 'true' } } });
  expect(pending.response.status).toBe(200);
  expect(pending.data?.approvals.map((entry) => entry.id)).toEqual(['approval-1']);
  expect(pending.data?.approvals[0]?.question).toBe('本番に出してよいか');

  const answer = await client.api.POST('/approvals/{id}/answer', {
    params: { path: { id: 'approval-1' } },
    body: { answer: '出してよい' },
  });
  expect(answer.response.status).toBe(200);
  expect(fake.answered).toEqual([{ id: 'approval-1', answer: '出してよい' }]);

  const again = await client.api.POST('/approvals/{id}/answer', {
    params: { path: { id: 'approval-1' } },
    body: { answer: 'もう一度' },
  });
  expect(again.response.status).toBe(409);

  const journal = await client.api.GET('/journal', { params: { query: { limit: 50 } } });
  expect(journal.response.status).toBe(200);
  expect(journal.data?.entries.some((entry) => entry.type === 'exchange')).toBe(true);

  const conversation = await client.api.GET('/conversations/{id}', {
    params: { path: { id: conversationId as string }, query: {} },
  });
  expect(conversation.response.status).toBe(200);
  expect(conversation.data?.messages[0]?.text).toBe('本番に出したい');
});

it('chatStream — 進行中のターンの途中経過に戻り、続きを受け取る（発言は投函しない）', async () => {
  fake.inProgress.set('conv-a', [{ type: 'thinking' }, { type: 'text', text: '途中まで' }]);

  const seen: { event: string; data: unknown }[] = [];
  const reading = (async () => {
    for await (const message of client.chatStream('conv-a')) {
      seen.push({ event: message.event, data: message.data });
      if (message.event === 'open') {
        fake.emit('conv-a', { type: 'text', text: '続き' });
        fake.emit('conv-a', { type: 'done' });
      }
    }
  })();
  await reading;

  expect(seen).toEqual([
    { event: 'open', data: { conversationId: 'conv-a', inProgress: true } },
    { event: 'thinking', data: { type: 'thinking' } },
    { event: 'text', data: { type: 'text', text: '途中まで' } },
    { event: 'text', data: { type: 'text', text: '続き' } },
    { event: 'done', data: { type: 'done' } },
  ]);
  const journal = await client.api.GET('/journal', { params: { query: { limit: 50 } } });
  expect(journal.data?.entries.some((entry) => entry.type === 'exchange')).toBe(false);
  expect(fake.listeners.get('conv-a')?.size ?? 0).toBe(0);
});

it('chatStream — 進行中でなければ open だけで閉じる', async () => {
  const seen: { event: string; data: unknown }[] = [];
  for await (const message of client.chatStream('conv-none')) {
    seen.push({ event: message.event, data: message.data });
  }
  expect(seen).toEqual([
    { event: 'open', data: { conversationId: 'conv-none', inProgress: false } },
  ]);
  expect(fake.listeners.get('conv-none')?.size ?? 0).toBe(0);
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
    body: {},
  });
  expect(ended.response.status).toBe(200);
});

// 型で固定する: 実行時の test は `body: {}` を書けば `required: false` でも 415 にならず素通りするため。
type BodyIsRequired<T> = undefined extends T ? never : true;

function assertBodyRequired<T>(bodyIsRequired: BodyIsRequired<T>): BodyIsRequired<T> {
  return bodyIsRequired;
}

assertBodyRequired<paths['/chat/{conversationId}/end']['post']['requestBody']>(true);
assertBodyRequired<paths['/events/{source}']['post']['requestBody']>(true);
assertBodyRequired<paths['/schedule/{kind}']['delete']['requestBody']>(true);
assertBodyRequired<paths['/schedule/{kind}/run']['post']['requestBody']>(true);
assertBodyRequired<paths['/access/{accountId}/grant']['post']['requestBody']>(true);
assertBodyRequired<paths['/access/{accountId}/revoke']['post']['requestBody']>(true);
assertBodyRequired<paths['/shutdown']['post']['requestBody']>(true);
assertBodyRequired<paths['/auth/logout']['post']['requestBody']>(true);

// `createClient<paths>` を既定ヘッダ無しで直に組む: `createAlteroidClient` が手で足す `content-type` は、spec が正しいことの証拠にならないため。
it('既定ヘッダを注入しない素の生成クライアントでも 415 にならない', async () => {
  const address = server.address() as AddressInfo;
  const bare = createClient<paths>({ baseUrl: `http://127.0.0.1:${address.port}` });

  const calls: { name: string; status: () => Promise<number> }[] = [
    {
      name: 'POST /chat/{conversationId}/end',
      status: async () =>
        (
          await bare.POST('/chat/{conversationId}/end', {
            params: { path: { conversationId: 'なんでもよい' } },
            body: {},
          })
        ).response.status,
    },
    {
      name: 'POST /events/{source}',
      status: async () =>
        (await bare.POST('/events/{source}', { params: { path: { source: 'ci' } }, body: {} }))
          .response.status,
    },
    {
      name: 'POST /schedule/{kind}/run',
      status: async () =>
        (
          await bare.POST('/schedule/{kind}/run', {
            params: { path: { kind: 'daily_report' } },
            body: {},
          })
        ).response.status,
    },
    {
      name: 'DELETE /schedule/{kind}',
      status: async () =>
        (await bare.DELETE('/schedule/{kind}', { params: { path: { kind: 'ci' } }, body: {} }))
          .response.status,
    },
    {
      name: 'POST /access/{accountId}/grant',
      status: async () =>
        (
          await bare.POST('/access/{accountId}/grant', {
            params: { path: { accountId: 'なんでもよい' } },
            body: {},
          })
        ).response.status,
    },
    {
      name: 'POST /access/{accountId}/revoke',
      status: async () =>
        (
          await bare.POST('/access/{accountId}/revoke', {
            params: { path: { accountId: 'なんでもよい' } },
            body: {},
          })
        ).response.status,
    },
    {
      name: 'POST /shutdown',
      status: async () => (await bare.POST('/shutdown', { body: {} })).response.status,
    },
    {
      name: 'POST /auth/logout',
      status: async () => (await bare.POST('/auth/logout', { body: {} })).response.status,
    },
  ];

  const statuses: Record<string, number> = {};
  for (const call of calls) statuses[call.name] = await call.status();

  for (const [name, status] of Object.entries(statuses)) {
    expect(status, `${name} が門番に弾かれた`).not.toBe(415);
  }
});
