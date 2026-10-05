import { createMemoryStores, type Clone, type Stores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

/**
 * 会話の既読（`GET /conversations` の `unreadCount`・`GET /conversations/:id` の
 * `readThrough` / `unreadCount`・`POST /conversations/:id/read`）。
 *
 * 時刻は `Date` だけを偽の時計にして進める（実時間を待たない）。日誌の `at` もデーモンの
 * 「いま」（基準時刻）も同じ時計から出る。
 */
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const tick = (seconds: number) => vi.setSystemTime(T0 + seconds * 1000);

let stores: Stores;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  tick(0);
  stores = createMemoryStores();
  app = createApp({
    clone: {} as unknown as Clone,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function say(
  conversationId: string,
  role: 'inbound' | 'outbound',
  text: string,
  withWhom: 'human' | 'manager' = 'human',
) {
  return stores.journal.append({ type: 'exchange', with: withWhom, role, text, conversationId });
}

interface ListBody {
  conversations: { conversationId: string; unreadCount: number; readThrough: string | null }[];
}
const list = async () => (await (await app.request('/conversations')).json()) as ListBody;
const unreadOf = (body: ListBody, id: string) =>
  body.conversations.find((c) => c.conversationId === id)?.unreadCount;

describe('会話の既読', () => {
  it('導入前の会話は未読にならず、導入後にクローンが始めた会話・足した発言は未読になる', async () => {
    await say('old', 'inbound', '前の質問');
    await say('old', 'outbound', '前の返答');
    tick(10);
    // 最初の読み出しで基準時刻が決まる（以後は変わらない）
    expect(unreadOf(await list(), 'old')).toBe(0);

    tick(20);
    await say('new', 'outbound', 'クローンが始めた会話（conversation_post）');
    tick(30);
    await say('old', 'outbound', '基準時刻のあとの返答');
    tick(40);

    const body = await list();
    expect(unreadOf(body, 'new')).toBe(1);
    expect(unreadOf(body, 'old')).toBe(1);
    expect(body.conversations.find((c) => c.conversationId === 'old')?.readThrough).toBe(at(10));
  });

  it('人間自身の発言と、マネージャーとの往復は未読に数えない', async () => {
    tick(1);
    await list();
    tick(2);
    await say('c', 'inbound', '人間の発言');
    await say('c', 'outbound', '返答', 'manager');
    tick(3);
    expect(unreadOf(await list(), 'c')).toBe(0); // 人間の発言もマネージャーとの往復も数えない
    await say('c', 'outbound', '返答');
    expect(unreadOf(await list(), 'c')).toBe(1);
  });

  it('詳細に実効位置と未読数が載る（記録が無ければ基準時刻）', async () => {
    tick(1);
    await list();
    tick(2);
    await say('c', 'inbound', '質問');
    tick(3);
    await say('c', 'outbound', '返答');
    const detail = (await (await app.request('/conversations/c')).json()) as {
      readThrough: string | null;
      unreadCount: number;
    };
    expect(detail).toMatchObject({ readThrough: at(1), unreadCount: 1 });
  });

  it('POST read は発言の時刻まで進め、未読数と位置を返す。戻らない', async () => {
    tick(1);
    await list();
    tick(2);
    const first = await say('c', 'outbound', '1つめ');
    tick(3);
    const second = await say('c', 'outbound', '2つめ');
    tick(4);

    const res1 = await app.request('/conversations/c/read', post({ through: first.id }));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ conversationId: 'c', readThrough: at(2), unreadCount: 1 });

    const res2 = await app.request('/conversations/c/read', post({ through: second.id }));
    expect(await res2.json()).toEqual({ conversationId: 'c', readThrough: at(3), unreadCount: 0 });

    // 古い発言を指しても戻らない（200 でいまの位置）
    const back = await app.request('/conversations/c/read', post({ through: first.id }));
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ conversationId: 'c', readThrough: at(3), unreadCount: 0 });
    expect(unreadOf(await list(), 'c')).toBe(0);
  });

  it('時刻をクライアントから受け取らない。他の会話の発言・無い発言・人間との往復でない発言は拒む', async () => {
    tick(1);
    await list();
    tick(2);
    const mine = await say('c', 'outbound', 'この会話');
    const other = await say('d', 'outbound', '別の会話');
    const manager = await say('c', 'outbound', 'マネージャーとの往復', 'manager');

    expect((await app.request('/conversations/c/read', post({ through: other.id }))).status).toBe(
      400,
    );
    expect((await app.request('/conversations/c/read', post({ through: 'nope' }))).status).toBe(
      404,
    );
    expect((await app.request('/conversations/c/read', post({ through: manager.id }))).status).toBe(
      404,
    );
    // 時刻を渡す形は受けない（発言の id として引けない）
    expect((await app.request('/conversations/c/read', post({ through: at(999) }))).status).toBe(
      404,
    );
    expect((await app.request('/conversations/c/read', post({}))).status).toBe(400);

    // 拒んだ間、位置は動いていない
    expect(unreadOf(await list(), 'c')).toBe(1);
    expect(unreadOf(await list(), 'd')).toBe(1);
    expect((await app.request('/conversations/c/read', post({ through: mine.id }))).status).toBe(
      200,
    );
    expect(unreadOf(await list(), 'c')).toBe(0);
    expect(unreadOf(await list(), 'd')).toBe(1);
  });
});
