import { describe, expect, it } from 'vitest';

import { buildNotificationFeed, verifyNotificationStoreContract } from './notifications.js';
import type { PendingApproval } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * 人間への通知一覧（issue #2515）。元は承認待ちキュー、新しく持つのは既読の位置だけ。
 *
 * 陰性対照（マネージャー→クローンの確認は一覧に出ない）は、本物の委譲の経路を
 * 通すために `manager.test.ts` の「通知一覧（issue #2515）の陰性対照」に置いてある。
 */

function toolsFor(stores: ReturnType<typeof createMemoryStores>) {
  return createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
}

async function call(
  tools: ReturnType<typeof toolsFor>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`道具 ${name} が無い`);
  await found.handler(args as never, {});
}

async function feedOf(stores: ReturnType<typeof createMemoryStores>) {
  return buildNotificationFeed(
    await stores.jobs.listApprovals({ pendingOnly: true }),
    await stores.notifications.readCursor(),
  );
}

describe('通知一覧（issue #2515）', () => {
  it('インメモリの器が NotificationStore の契約を満たす', async () => {
    await verifyNotificationStoreContract(createMemoryStores().notifications);
  });

  it('陽性対照: ask_human で積むと一覧に出て未読が増え、既読にすると減る', async () => {
    const stores = createMemoryStores();
    const tools = toolsFor(stores);

    // 前提: 何も積んでいなければ空で、未読は 0
    const empty = await feedOf(stores);
    expect(empty.notifications).toEqual([]);
    expect(empty.unreadCount).toBe(0);
    expect(empty.latestAt).toBeUndefined();

    await call(tools, 'ask_human', { question: '本番の DB を移してよいか' });
    const one = await feedOf(stores);
    expect(one.unreadCount).toBe(1);
    expect(one.notifications).toHaveLength(1);
    expect(one.notifications[0]).toMatchObject({
      kind: 'approval_pending',
      question: '本番の DB を移してよいか',
      read: false,
    });
    expect(one.latestAt).toBe(one.notifications[0]?.at);

    // 既読にすると減る（一覧からは消えない——片付くのは答えたときである）
    await stores.notifications.advanceReadCursor(one.latestAt as string);
    const read = await feedOf(stores);
    expect(read.unreadCount).toBe(0);
    expect(read.notifications).toHaveLength(1);
    expect(read.notifications[0]?.read).toBe(true);
    expect(read.readThrough).toBe(one.latestAt);
  });

  it('request_permission で積んだものも同じく通知になる（どちらも人間の答えが要る）', async () => {
    const stores = createMemoryStores();
    await call(toolsFor(stores), 'request_permission', {
      rule: 'Bash(git status)',
      allows: ['git status'],
      denies: ['git push'],
      reason: '状態を見るだけ',
    });
    const feed = await feedOf(stores);
    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications[0]?.question).toContain('Bash(git status)');
  });

  it('既読の後に積まれたものは未読になる（既読は「いま」ではなく見た位置まで）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(approval('a1', '2026-10-01T00:00:01.000Z'));
    const first = await feedOf(stores);
    await stores.notifications.advanceReadCursor(first.latestAt as string);

    await stores.jobs.putApproval(approval('a2', '2026-10-01T00:00:02.000Z'));
    const second = await feedOf(stores);
    expect(second.unreadCount).toBe(1);
    expect(second.notifications.map((n) => [n.approvalId, n.read])).toEqual([
      ['a2', false],
      ['a1', true],
    ]);
  });

  it('答えた・取り下げた承認待ちは、既読にしなくても一覧から消える', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(approval('answered', '2026-10-01T00:00:01.000Z'));
    await stores.jobs.putApproval(approval('withdrawn', '2026-10-01T00:00:02.000Z'));
    await stores.jobs.putApproval(approval('open', '2026-10-01T00:00:03.000Z'));
    expect((await feedOf(stores)).unreadCount).toBe(3);

    await stores.jobs.updateApproval('answered', (current) => ({
      ...current,
      answeredAt: '2026-10-01T00:01:00.000Z',
      answer: 'はい',
    }));
    await stores.jobs.updateApproval('withdrawn', (current) => ({
      ...current,
      withdrawnAt: '2026-10-01T00:01:00.000Z',
      withdrawnReason: '不要になった',
    }));

    const feed = await feedOf(stores);
    expect(feed.notifications.map((n) => n.approvalId)).toEqual(['open']);
    expect(feed.unreadCount).toBe(1);
  });

  it('既読の位置が読めないときは、全件を未読として数え、理由を載せる', () => {
    const feed = buildNotificationFeed(
      { entries: [approval('a1', '2026-10-01T00:00:01.000Z')], unreadable: [] },
      { state: 'unreadable', reason: 'JSON として読めない' },
    );
    expect(feed.unreadCount).toBe(1);
    expect(feed.readThrough).toBeNull();
    expect(feed.cursorUnreadable).toBe('JSON として読めない');
  });

  it('読めない承認待ちは件数として載り、0件のときは鍵ごと無い', () => {
    const withUnreadable = buildNotificationFeed(
      { entries: [], unreadable: [{ id: 'broken', reason: 'question' }] },
      { state: 'none' },
    );
    expect(withUnreadable.unreadableApprovals).toBe(1);
    expect(withUnreadable.unreadCount).toBe(0);

    const clean = buildNotificationFeed({ entries: [], unreadable: [] }, { state: 'none' });
    expect('unreadableApprovals' in clean).toBe(false);
    expect('cursorUnreadable' in clean).toBe(false);
  });

  it('同時刻の通知は既読の位置と同じ時刻なら既読に数える（位置は「以前を含む」）', () => {
    const feed = buildNotificationFeed(
      { entries: [approval('a1', '2026-10-01T00:00:01.000Z')], unreadable: [] },
      {
        state: 'ok',
        cursor: { readThrough: '2026-10-01T00:00:01.000Z', updatedAt: '2026-10-01T00:00:05.000Z' },
      },
    );
    expect(feed.unreadCount).toBe(0);
  });
});

function approval(id: string, createdAt: string): PendingApproval {
  return { id, createdAt, question: `確認 ${id}` };
}
