import { createTokenPoolService, UnreadableActiveTokenError } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const AUTH = { authorization: 'Bearer test-token' };
const DUMMY_VALUE = 'dummy-token-value-never-respond';
const REASON = 'generation が数値でない（テスト用）';

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function seed() {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.tokens.replace([
    { id: 'tok-a', label: 'a', value: DUMMY_VALUE, source: 'stored', order: 0 },
    { id: 'tok-b', label: 'b', value: DUMMY_VALUE, source: 'stored', order: 1 },
  ]);
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    tokens: createTokenPoolService({ stores }),
  });
  return { stores, app };
}

async function getTokens(app: Awaited<ReturnType<typeof seed>>['app']) {
  const response = await app.request('/tokens', { headers: AUTH });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown> & { tokens: { id: string }[] };
}

describe('GET /tokens の現役の指名（#5457）', () => {
  it('現役が在る回は active（tokenId・generation・rotatedAt）だけを返す', async () => {
    const { stores, app } = await seed();
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 3,
      rotatedAt: '2026-10-29T00:00:00.000Z',
    });

    const body = await getTokens(app);

    expect(body.active).toEqual({
      tokenId: 'tok-b',
      generation: 3,
      rotatedAt: '2026-10-29T00:00:00.000Z',
    });
    expect('activeNever' in body).toBe(false);
    expect('activeUnreadable' in body).toBe(false);
    expect(body.tokens.map((token) => token.id)).toEqual(['tok-a', 'tok-b']);
    expect(JSON.stringify(body)).not.toContain(DUMMY_VALUE);
  });

  it('まだ一度も無い回は activeNever: true を返し、active を作らない（0 や空で偽らない）', async () => {
    const { app } = await seed();

    const body = await getTokens(app);

    expect(body.activeNever).toBe(true);
    expect('active' in body).toBe(false);
    expect('activeUnreadable' in body).toBe(false);
  });

  it('読めない回は activeUnreadable を返し、activeNever へ倒さず、一覧は落とさない', async () => {
    const { stores, app } = await seed();
    stores.tokens.readActive = () => {
      throw new UnreadableActiveTokenError(REASON);
    };

    const body = await getTokens(app);

    expect(body.activeUnreadable).toEqual({ reason: expect.stringContaining(REASON) });
    expect('active' in body).toBe(false);
    expect('activeNever' in body).toBe(false);
    expect(body.tokens.map((token) => token.id)).toEqual(['tok-a', 'tok-b']);
  });

  it('UnreadableActiveTokenError 以外の失敗は握り潰さない（500）', async () => {
    const { stores, app } = await seed();
    stores.tokens.readActive = () => Promise.reject(new Error('読み取り失敗（テスト用）'));

    const response = await app.request('/tokens', { headers: AUTH });

    expect(response.status).toBe(500);
  });

  it('PUT /tokens の応答には現役の欄を足さない（読み直しの値と書いた直後の値を混ぜない）', async () => {
    const { stores, app } = await seed();
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-10-29T00:00:00.000Z',
    });

    const response = await app.request('/tokens', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: [{ id: 'tok-a', label: 'a' }] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect('active' in body).toBe(false);
    expect('activeNever' in body).toBe(false);
    expect('activeUnreadable' in body).toBe(false);
  });
});
