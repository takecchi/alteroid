import {
  createManagerPool,
  createMemoryStores,
  createProfileService,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const AUTH = { authorization: 'Bearer test-token' };
const HUMAN_VALUE = 'FAKE_SECRET_HUMAN_4592';
const CLONE_VALUE = 'FAKE_SECRET_CLONE_4592';

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function setup() {
  const stores = createMemoryStores();
  const profile = createProfileService({ stores });
  const app = createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    profile,
  });
  return { stores, profile, app };
}

type App = ReturnType<typeof setup>['app'];

async function versionOf(app: App, name: string): Promise<string> {
  const response = await app.request('/profile', { headers: AUTH });
  const body = (await response.json()) as { entries: { name: string; version?: string }[] };
  const version = body.entries.find((entry) => entry.name === name)?.version;
  if (version === undefined) throw new Error('GET /profile は行ごとに版を返すはず');
  return version;
}

function putRow(app: App, name: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/profile/${name}`, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('PUT / DELETE /profile/:name の ifMatch（#4592）', () => {
  it('読んだ後にほかで書き換えられていれば、読んだ版での PUT は 409 で何も変えない（本文は応答に出ない）', async () => {
    const { stores, profile, app } = setup();
    await profile.set('rust', `export R=${HUMAN_VALUE}`);
    const read = await versionOf(app, 'rust');

    // 読んだ後に、クローンが書き換える
    await profile.set('rust', `export R=${CLONE_VALUE}`);

    const response = await putRow(app, 'rust', { script: 'export R=new', ifMatch: read });

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(HUMAN_VALUE);
    expect(text).not.toContain(CLONE_VALUE);
    const body = JSON.parse(text) as { current: { name: string; version?: string } | null };
    expect(body.current?.name).toBe('rust');
    expect(body.current?.version).not.toBe(read);
    expect((await stores.profile.list())[0]?.script).toBe(`export R=${CLONE_VALUE}\n`);
  });

  it('ifMatch: null は「無いときだけ作る」: ほかで作られていれば 409', async () => {
    const { stores, profile, app } = setup();
    await profile.set('rust', `export R=${CLONE_VALUE}`);

    const response = await putRow(app, 'rust', { script: 'export R=new', ifMatch: null });

    expect(response.status).toBe(409);
    expect((await stores.profile.list())[0]?.script).toBe(`export R=${CLONE_VALUE}\n`);
  });

  it('読んだ後にほかで書き換えられていれば、読んだ版での DELETE は 409 で外さない', async () => {
    const { stores, profile, app } = setup();
    await profile.set('rust', `export R=${HUMAN_VALUE}`);
    const read = await versionOf(app, 'rust');
    await profile.set('rust', `export R=${CLONE_VALUE}`);

    const response = await app.request(`/profile/rust?ifMatch=${encodeURIComponent(read)}`, {
      method: 'DELETE',
      headers: AUTH,
    });

    expect(response.status).toBe(409);
    expect(await stores.profile.list()).toHaveLength(1);
  });

  it('版が合えば 200。対照: ifMatch を省けば今までどおり比べない', async () => {
    const { stores, profile, app } = setup();
    await profile.set('rust', 'export R=1');
    const read = await versionOf(app, 'rust');

    expect((await putRow(app, 'rust', { script: 'export R=2', ifMatch: read })).status).toBe(200);
    await profile.set('rust', 'export R=clone');
    expect((await putRow(app, 'rust', { script: 'export R=3' })).status).toBe(200);
    expect((await stores.profile.list())[0]?.script).toBe('export R=3\n');
    const removed = await app.request('/profile/rust', { method: 'DELETE', headers: AUTH });
    expect(removed.status).toBe(200);
    expect(await stores.profile.list()).toEqual([]);
  });

  it('⭐ ifMatch の綴り違い（ifmatch / if_match）や知らない欄は 400 で断り、比べずに上書きしない（#4840）', async () => {
    const { stores, profile, app } = setup();
    await profile.set('rust', `export R=${HUMAN_VALUE}`);
    const read = await versionOf(app, 'rust');
    await profile.set('rust', `export R=${CLONE_VALUE}`);

    for (const body of [
      { script: 'export R=new', ifmatch: read },
      { script: 'export R=new', if_match: read },
      { script: 'export R=new', scpoe: 'runner' },
    ]) {
      const response = await putRow(app, 'rust', body);
      expect(response.status, JSON.stringify(Object.keys(body))).toBe(400);
    }
    expect((await stores.profile.list())[0]?.script).toBe(`export R=${CLONE_VALUE}\n`);
  });
});
