import {
  createCodexChatgptAuthService,
  createMemoryStores,
  type CloneHost,
  type CodexDeviceLogin,
  type CodexDeviceLoginOutcome,
  type RunnerClient,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const LOGIN_VALUE = '{"tokens":{"refresh_token":"rt-http-fake-not-real"}}';

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

function setup(options: { startFails?: boolean } = {}) {
  const stores = createMemoryStores();
  const pushes: ({ value: string; revision: string } | null)[] = [];
  const runner = {
    runnerId: 'r1',
    setCodexAuth: async (push: { value: string; revision: string } | null) => {
      pushes.push(push);
    },
  } as unknown as RunnerClient;
  let finish!: (outcome: CodexDeviceLoginOutcome) => void;
  const service = createCodexChatgptAuthService({
    store: stores.codexAuth,
    runners: { list: async () => [runner] },
    journal: async (entry) => {
      await stores.journal.append(entry);
    },
    startDeviceLogin: async (): Promise<CodexDeviceLogin> => {
      if (options.startFails === true) {
        throw new Error('デバイスコードのログインを始められなかった: spawn codex ENOENT');
      }
      return {
        started: {
          loginId: 'l',
          userCode: 'WXYZ-1234',
          verificationUrl: 'https://auth.example/device',
        },
        outcome: new Promise((resolve) => {
          finish = resolve;
        }),
        cancel: () => finish({ kind: 'canceled' }),
      };
    },
  });
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    codexAuth: service,
  });
  return { stores, service, app, pushes, finish: (o: CodexDeviceLoginOutcome) => finish(o) };
}

describe('/codex（Codex の ChatGPT ログイン。#3939）', () => {
  it('ログインを始めて完了すると正本に置かれ、状態は返るが値はどの応答にも載らない', async () => {
    const h = setup();
    const before = await (await h.app.request('/codex/auth')).json();
    expect(before).toMatchObject({ loggedIn: false });

    const started = await h.app.request('/codex/login', { method: 'POST' });
    expect(started.status).toBe(200);
    const view = (await started.json()) as {
      id: string;
      state: string;
      userCode: string;
      verificationUrl: string;
    };
    expect(view).toMatchObject({
      state: 'pending',
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://auth.example/device',
    });
    // 能力を広げる口なので、始める前に日誌を書いている。
    expect(JSON.stringify(await h.stores.journal.list())).toContain('ログインを始めようとしている');

    h.finish({
      kind: 'succeeded',
      authJson: LOGIN_VALUE,
      email: 'me@example.com',
      planType: 'pro',
    });
    await h.service.settled();

    const progress = await h.app.request(`/codex/login/${view.id}`);
    expect(await progress.json()).toMatchObject({ state: 'succeeded' });
    const status = await h.app.request('/codex/auth');
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toMatchObject({
      loggedIn: true,
      email: 'me@example.com',
      planType: 'pro',
      failure: null,
    });
    expect(statusText).not.toContain('rt-http-fake-not-real');
    expect(JSON.stringify(await h.stores.journal.list())).not.toContain('rt-http-fake-not-real');
    expect(h.pushes.at(-1)?.value).toBe(LOGIN_VALUE);

    const logout = await h.app.request('/codex/auth', { method: 'DELETE' });
    expect(await logout.json()).toEqual({ removed: true });
    expect(await (await h.app.request('/codex/auth')).json()).toMatchObject({ loggedIn: false });
    expect(h.pushes.at(-1)).toBeNull();
  });

  it('始められなければ 502 で理由を返す', async () => {
    const h = setup({ startFails: true });
    const response = await h.app.request('/codex/login', { method: 'POST' });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('ENOENT');
  });

  it('取り消しと、知らない id', async () => {
    const h = setup();
    const view = (await (await h.app.request('/codex/login', { method: 'POST' })).json()) as {
      id: string;
    };
    const canceled = await h.app.request(`/codex/login/${view.id}`, { method: 'DELETE' });
    expect(await canceled.json()).toMatchObject({ state: 'canceled' });
    expect((await h.app.request('/codex/login/unknown')).status).toBe(404);
    expect((await h.app.request('/codex/login/unknown', { method: 'DELETE' })).status).toBe(404);
  });

  it('持ち主が無い構成では 503', async () => {
    const app = createApp({
      clone: stubCloneHost(),
      stores: createMemoryStores(),
      token: 'test-token',
      shutdown: () => undefined,
    });
    expect((await app.request('/codex/auth')).status).toBe(503);
    expect((await app.request('/codex/login', { method: 'POST' })).status).toBe(503);
  });
});
