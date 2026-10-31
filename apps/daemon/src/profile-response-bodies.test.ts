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
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };

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

function putRow(app: App, name: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/profile/${name}`, {
      method: 'PUT',
      headers: JSON_AUTH,
      body: JSON.stringify(body),
    }),
  );
}

const ROW_KEYS = ['name', 'scope', 'updatedAt', 'sha256', 'bytes', 'version'];

describe('プロファイルの応答の形（整理前の形を固定する）', () => {
  it('入力が不正（ProfileInputError）なら 400 と同じ error 文・detail は error.message', async () => {
    const { profile, app } = setup();
    await profile.set('Rust', 'export R=1');

    const response = await putRow(app, 'rust', { script: 'export R=2' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'プロファイルの入力が不正（保存していない）',
      detail: '大文字小文字だけが違う行 Rust が既にある（別の行としては置けない）',
    });
  });

  it('NUL 入りの本文（NulNotAllowedError）も 400 と同じ error 文で、detail に値を載せない', async () => {
    const { stores, app } = setup();

    const response = await putRow(app, 'rust', { script: 'export R=FAKE\u0000X' });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; detail: string };
    expect(Object.keys(body)).toEqual(['error', 'detail']);
    expect(body.error).toBe('プロファイルの入力が不正（保存していない）');
    expect(body.detail).not.toContain('FAKE');
    expect(await stores.profile.list()).toEqual([]);
  });

  it('409 の current・200 の entries・GET の entries は、同じ欄を同じ順で返す', async () => {
    const { profile, app } = setup();
    await profile.set('rust', 'export R=1', 'runner');
    const got = (await (await app.request('/profile', { headers: AUTH })).json()) as {
      entries: Record<string, unknown>[];
    };
    const row = got.entries[0];
    if (row === undefined) throw new Error('行が在るはず');
    expect(Object.keys(row)).toEqual(expect.arrayContaining([...ROW_KEYS, 'script']));
    expect(row['bytes']).toBe(Buffer.byteLength('export R=1\n'));
    expect(row['scope']).toBe('runner');

    await profile.set('rust', 'export R=22', 'runner');
    const conflict = await putRow(app, 'rust', {
      script: 'export R=3',
      ifMatch: row['version'],
    });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { current: Record<string, unknown> };
    expect(Object.keys(conflictBody.current)).toEqual(ROW_KEYS);
    expect(conflictBody.current['name']).toBe('rust');
    expect(conflictBody.current['scope']).toBe('runner');
    expect(conflictBody.current['bytes']).toBe(Buffer.byteLength('export R=22\n'));
    expect(conflictBody.current['sha256']).not.toBe(row['sha256']);

    const ok = await putRow(app, 'rust', { script: 'export R=22' });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { entries: Record<string, unknown>[] };
    expect(okBody.entries).toHaveLength(1);
    const first = okBody.entries[0] ?? {};
    expect(Object.keys(first)).toEqual(ROW_KEYS);
    for (const key of ['name', 'scope', 'sha256', 'bytes', 'version']) {
      expect(first[key]).toEqual(conflictBody.current[key]);
    }
  });
});
