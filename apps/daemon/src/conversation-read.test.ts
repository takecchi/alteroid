import { createMemoryStores, type CloneHost, type Stores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

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
    clone: {} as unknown as CloneHost,
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
    expect(unreadOf(await list(), 'c')).toBe(0);
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

    const back = await app.request('/conversations/c/read', post({ through: first.id }));
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ conversationId: 'c', readThrough: at(3), unreadCount: 0 });
    expect(unreadOf(await list(), 'c')).toBe(0);
  });

  it('基準時刻より前の会話で古い発言を read しても、未読数は 0 のまま（後戻りしない）', async () => {
    const first = await say('old', 'inbound', '前の質問');
    tick(1);
    await say('old', 'outbound', '前の返答');
    tick(10);
    expect(unreadOf(await list(), 'old')).toBe(0);
    const res = await app.request('/conversations/old/read', post({ through: first.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversationId: 'old',
      readThrough: at(10),
      unreadCount: 0,
    });
    expect(unreadOf(await list(), 'old')).toBe(0);
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
    expect((await app.request('/conversations/c/read', post({ through: at(999) }))).status).toBe(
      404,
    );
    expect((await app.request('/conversations/c/read', post({}))).status).toBe(400);

    expect(unreadOf(await list(), 'c')).toBe(1);
    expect(unreadOf(await list(), 'd')).toBe(1);
    expect((await app.request('/conversations/c/read', post({ through: mine.id }))).status).toBe(
      200,
    );
    expect(unreadOf(await list(), 'c')).toBe(0);
    expect(unreadOf(await list(), 'd')).toBe(1);
  });

  describe('GET /conversations/unread-count', () => {
    const count = async () =>
      (await (await app.request('/conversations/unread-count')).json()) as {
        count: number;
        capped: boolean;
      };

    it('全会話で数える（一覧の既定の件数を超えても）。:id に食われない', async () => {
      tick(1);
      await count();
      tick(2);
      for (let i = 0; i < 35; i += 1) await say(`c${i}`, 'outbound', '返答');
      tick(3);
      const res = await app.request('/conversations/unread-count');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 35, capped: false });
      expect((await list()).conversations).toHaveLength(20);
    });

    it('基準時刻以前は数えず、導入後の返答は数え、既読で減る', async () => {
      await say('old', 'outbound', '前の返答');
      tick(10);
      expect(await count()).toEqual({ count: 0, capped: false });
      tick(11);
      const fresh = await say('old', 'outbound', '後の返答');
      await say('new', 'outbound', '新しい会話');
      tick(12);
      expect(await count()).toEqual({ count: 2, capped: false });
      await app.request('/conversations/old/read', post({ through: fresh.id }));
      expect(await count()).toEqual({ count: 1, capped: false });
    });

    it('人間自身の発言だけの会話は数えない', async () => {
      tick(1);
      await count();
      tick(2);
      await say('mine', 'inbound', '私の発言');
      tick(3);
      expect(await count()).toEqual({ count: 0, capped: false });
    });

    it('2回目以降は前回の続きだけを日誌から読む（遡りが広がらない）', async () => {
      tick(1);
      await count();
      tick(200);
      await say('a', 'outbound', '返答');
      await count();
      const sinces: (string | undefined)[] = [];
      const list = stores.journal.list.bind(stores.journal);
      stores.journal.list = (query) => {
        sinces.push(query?.since);
        return list(query);
      };
      tick(300);
      await count();
      expect(sinces).toHaveLength(1);
      expect(Date.parse(sinces[0] ?? '')).toBeGreaterThanOrEqual(T0 + 100 * 1000);
    });

    it('上限（99）を超えたら capped で、count は上限', async () => {
      tick(1);
      await count();
      tick(2);
      for (let i = 0; i < 100; i += 1) await say(`c${i}`, 'outbound', '返答');
      tick(3);
      expect(await count()).toEqual({ count: 99, capped: true });
    });
  });
});
