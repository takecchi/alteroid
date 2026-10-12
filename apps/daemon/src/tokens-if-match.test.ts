import { createTokenPoolService } from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const AUTH = { authorization: 'Bearer test-token' };
const V_A = 'dummy-token-value-A-never-respond';
const V_B = 'dummy-token-value-B-never-respond';

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
    { id: 'tok-a', label: 'a', value: V_A, source: 'stored', order: 0 },
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

type App = Awaited<ReturnType<typeof seed>>['app'];

async function readVersion(app: App): Promise<string> {
  const response = await app.request('/tokens', { headers: AUTH });
  const body = (await response.json()) as { version?: string };
  if (body.version === undefined) throw new Error('GET /tokens は版を返すはず');
  return body.version;
}

function put(app: App, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/tokens', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('PUT /tokens の ifMatch（#4591）', () => {
  it('読んだ後にほかで足された行があれば、読んだ版での全文置換は 409 で、何も変えない（値は応答に出ない）', async () => {
    const { stores, app } = await seed();
    const read = await readVersion(app);

    // 読んだ後に、ほかで b が足される
    const added = await put(app, {
      tokens: [
        { id: 'tok-a', label: 'a' },
        { label: 'b', value: V_B },
      ],
    });
    expect(added.status).toBe(200);

    // 読んだ時点の一覧（a だけ）から a を消すつもりの全文置換
    const response = await put(app, { tokens: [], ifMatch: read });

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(V_A);
    expect(text).not.toContain(V_B);
    const body = JSON.parse(text) as { current?: { tokens: { label: string }[] } };
    expect(body.current?.tokens.map((token) => token.label)).toEqual(['a', 'b']);
    expect((await stores.tokens.list()).map((token) => token.label)).toEqual(['a', 'b']);
  });

  it('版が合っていれば 200 で置き換え、応答に新しい版を載せる', async () => {
    const { app } = await seed();
    const read = await readVersion(app);

    const response = await put(app, { tokens: [{ id: 'tok-a', label: 'renamed' }], ifMatch: read });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { version?: string };
    expect(body.version).toBeDefined();
    expect(body.version).not.toBe(read);
  });

  it('対照: ifMatch を渡さなければ、今までどおり比べずに置き換える', async () => {
    const { stores, app } = await seed();

    const response = await put(app, { tokens: [] });

    expect(response.status).toBe(200);
    expect(await stores.tokens.list()).toEqual([]);
  });
});
