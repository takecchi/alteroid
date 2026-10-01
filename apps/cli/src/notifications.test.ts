import type { NotificationFeed } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * `alteroid notifications`（issue #2515）。`GET /notifications` /
 * `POST /notifications/read` を叩く薄いクライアントなので、ここで固定するのは
 * サーバとの契約の写し方（既読に渡す位置・失敗の終了コード）である。数え方は
 * `packages/core/src/notifications.test.ts` と `apps/daemon/src/notifications.test.ts` が持つ。
 */
const target = vi.hoisted(() => ({ note: null as string | null }));

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'http://127.0.0.1:4517',
      headers: {},
      note: target.note,
      remote: false,
    }),
}));

const { notificationsListCommand, notificationsReadCommand, renderNotificationFeed } =
  await import('./notifications.js');

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

let sent: Sent[] = [];
let replies: { status: number; body: unknown }[] = [];
let originalFetch: typeof fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = typeof input === 'string' ? input : (request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? 'GET';
    const rawBody =
      typeof init?.body === 'string' ? init.body : request ? await request.clone().text() : '';
    sent.push({ url, method, body: rawBody === '' ? undefined : JSON.parse(rawBody) });
    const reply = replies.shift() ?? { status: 200, body: EMPTY };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const EMPTY: NotificationFeed = { notifications: [], unreadCount: 0, readThrough: null };

const ONE_UNREAD: NotificationFeed = {
  notifications: [
    {
      kind: 'approval_pending',
      approvalId: 'ap-1',
      at: '2026-10-01T00:00:01.000Z',
      question: '本番の DB を移してよいか',
      read: false,
    },
  ],
  unreadCount: 1,
  readThrough: null,
  latestAt: '2026-10-01T00:00:01.000Z',
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sent = [];
  replies = [];
  target.note = null;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('alteroid notifications list', () => {
  it('未読数と承認待ちを出す', async () => {
    replies = [{ status: 200, body: ONE_UNREAD }];
    const out = captureStdout();
    await notificationsListCommand();
    expect(sent.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ['GET', '/notifications'],
    ]);
    expect(out()).toContain('未読 1 件');
    expect(out()).toContain('● 2026-10-01T00:00:01.000Z  承認待ち ap-1');
    expect(out()).toContain('本番の DB を移してよいか');
  });

  it('HTTP の失敗は stdout に書いて正常に戻る（読み取り系の作法）', async () => {
    replies = [{ status: 500, body: { error: '壊れた' } }];
    const out = captureStdout();
    await notificationsListCommand();
    expect(out()).toContain('通知を読めませんでした（500）');
  });
});

describe('alteroid notifications read', () => {
  it('一覧の latestAt を through に渡す（「いま」で既読にしない）', async () => {
    replies = [
      { status: 200, body: ONE_UNREAD },
      { status: 200, body: { ...ONE_UNREAD, unreadCount: 0, readThrough: ONE_UNREAD.latestAt } },
    ];
    const out = captureStdout();
    await notificationsReadCommand();
    expect(sent.map((s) => [s.method, new URL(s.url).pathname])).toEqual([
      ['GET', '/notifications'],
      ['POST', '/notifications/read'],
    ]);
    expect(sent[1]?.body).toEqual({ through: '2026-10-01T00:00:01.000Z' });
    expect(out()).toContain('未読 1 件 → 0 件');
  });

  it('通知が無ければ POST しない', async () => {
    replies = [{ status: 200, body: EMPTY }];
    const out = captureStdout();
    await notificationsReadCommand();
    expect(sent).toHaveLength(1);
    expect(out()).toContain('既読にする通知は無い');
  });

  it('既読にできなければ例外で終える（終了コードが 0 にならない）', async () => {
    replies = [
      { status: 200, body: ONE_UNREAD },
      { status: 400, body: { error: 'through が不正' } },
    ];
    captureStdout();
    await expect(notificationsReadCommand()).rejects.toThrow('通知を既読にできませんでした（400）');
  });

  it('未ログインなら HTTP に出ずに例外で終える（書き込み系の作法。#2456）', async () => {
    target.note = 'https://runner.example.com にログインしていません（alteroid login）';
    const out = captureStdout();
    await expect(notificationsReadCommand()).rejects.toThrow(target.note);
    expect(sent).toHaveLength(0);
    expect(out()).toBe('');
  });
});

describe('renderNotificationFeed', () => {
  it('既読の位置が読めない・読めない承認待ちが在る、を0件と混ぜずに出す', () => {
    const text = renderNotificationFeed({
      ...EMPTY,
      cursorUnreadable: 'JSON として読めない',
      unreadableApprovals: 2,
    });
    expect(text).toContain('既読の位置が読めない');
    expect(text).toContain('読めない承認待ちが 2 件');
    expect(text).toContain('通知は無い');
  });
});
