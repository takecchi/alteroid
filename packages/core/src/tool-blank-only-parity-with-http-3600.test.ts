import { describe, expect, it } from 'vitest';

import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { ManagerPool } from './manager.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const emitted: unknown[] = [];
  const tools = createCloneTools({
    stores,
    emit: (event) => {
      emitted.push(event);
    },
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    dropQueuedInboxEvents: async (ids) => ids.length,
    managers: { runningManagerOwning: () => undefined } as unknown as ManagerPool,
  });
  return {
    stores,
    emitted,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const AT = '2026-10-07T00:00:00.000Z';
const BLANK = ['', ' ', '   ', '\t\n', '　', ' \u0000 ', '\u0000'];

async function pendingApprovals(h: ReturnType<typeof harness>) {
  return (await h.stores.jobs.listApprovals({ pendingOnly: true })).entries;
}

describe('approval_withdraw の reason は空白だけを断る', () => {
  it.each(BLANK)('reason %j は断り、取り下げない', async (reason) => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnAt).toBeUndefined();
  });

  it('実のある reason は通る', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason: '不要になった' });
    expect(out).not.toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnReason).toBe('不要になった');
  });
});

describe('inbox_remove_many の reason は空白だけを断る', () => {
  const event = {
    type: 'manager_message',
    id: 'evt-1',
    at: AT,
    managerId: 'mgr-1',
    kind: 'report',
    text: '429',
  } as InboxEvent;

  it.each(BLANK)('reason %j は断り、1件も消さない', async (reason) => {
    const h = harness();
    await h.stores.inbox.put(event, event.at);
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason,
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
    expect(await h.stores.inbox.pending()).toMatchObject({ count: 1 });
  });

  it('実のある reason は通る', async () => {
    const h = harness();
    await h.stores.inbox.put(event, event.at);
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason: '429 の写しなので畳む',
      dryRun: false,
    });
    expect(out).not.toContain('reason は使えない');
    expect(await h.stores.inbox.pending()).toMatchObject({ count: 0 });
  });
});

describe('archive_remove_many の summary は空白だけを断る', () => {
  async function seed(h: ReturnType<typeof harness>) {
    const oldRow = await h.stores.archive.archive('sess-1', 'AAA');
    await h.stores.archive.archive('sess-1', 'AAABBB');
    return oldRow.id;
  }

  it.each(BLANK)('summary %j は断り、1件も消さない', async (summary) => {
    const h = harness();
    const oldId = await seed(h);
    const out = await h.call('archive_remove_many', {
      sessionIds: ['sess-1'],
      summary,
      dryRun: false,
    });
    expect(out).toContain('summary は使えない');
    expect(await h.stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('実のある summary は通る', async () => {
    const h = harness();
    const oldId = await seed(h);
    const out = await h.call('archive_remove_many', {
      sessionIds: ['sess-1'],
      summary: 'もう要らないので消した',
      dryRun: false,
    });
    expect(out).not.toContain('summary は使えない');
    expect(await h.stores.archive.read(oldId)).toMatchObject({ kind: 'removed' });
  });
});

describe('request_permission の reason は空白だけを断る', () => {
  const valid = { rule: 'Bash(ls:*)', allows: ['ls -la'], denies: ['rm -rf /'] };

  it.each(BLANK)('reason %j は断り、キューに積まない', async (reason) => {
    const h = harness();
    const out = await h.call('request_permission', { ...valid, reason });
    expect(out).toContain('reason は使えない');
    expect(await pendingApprovals(h)).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
    expect(await h.stores.journal.list({})).toHaveLength(0);
  });

  it('実のある reason は通る', async () => {
    const h = harness();
    const out = await h.call('request_permission', { ...valid, reason: '毎回聞かれて止まる' });
    expect(out).not.toContain('reason は使えない');
    expect(await pendingApprovals(h)).toHaveLength(1);
  });
});

describe('ask_human の question は空白だけを断る', () => {
  it.each(BLANK)('question %j は断り、キューに積まない', async (question) => {
    const h = harness();
    const out = await h.call('ask_human', { question });
    expect(out).toContain('question は使えない');
    expect(await pendingApprovals(h)).toHaveLength(0);
    expect(h.emitted).toHaveLength(0);
    expect(await h.stores.journal.list({})).toHaveLength(0);
  });

  it('実のある question は通る', async () => {
    const h = harness();
    const out = await h.call('ask_human', { question: 'デプロイ先はどこか' });
    expect(out).not.toContain('question は使えない');
    expect(await pendingApprovals(h)).toHaveLength(1);
  });

  it('context を省略しても通る（optional は従来どおり）', async () => {
    const h = harness();
    await h.call('ask_human', { question: '質問' });
    expect(await pendingApprovals(h)).toHaveLength(1);
  });
});
