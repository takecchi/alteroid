import {
  createManagerPool,
  createMemoryStores,
  createProfileService,
  createRunnerRegistry,
  fakeCloneHost as fakeCloneHostBase,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

// Issue #6506: 正本へ書いた後に runner の一覧が読めなくても、PUT / DELETE は 200（書けた側を正にする）。
// 応答に runnersUnconfirmed（伏せた理由）が載り、結果の日誌が「確かめられなかった」と書く。

const AUTH = { authorization: 'Bearer test-token' };
const SECRET_ENV_NAME = 'PIN_FAKE_DEPLOY_SECRET';
const FAKE_ENV_VALUE = 'pinfake-env-value-0123456789';

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeCloneHost(stores: Stores): CloneHost {
  return fakeCloneHostBase({
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
}

function setup(listFails: boolean) {
  const stores = createMemoryStores();
  const runners = {
    async list() {
      if (listFails) throw new Error(`一覧が取れない ${FAKE_ENV_VALUE}`);
      return [];
    },
    async get() {
      return null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
  const profile = createProfileService({ stores, runners });
  const app = createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    profile,
  });
  return { stores, profile, app };
}

async function lastTwoJournal(stores: Stores): Promise<{ decision: string; grounds: string }[]> {
  const rows = await stores.journal.list({ order: 'asc' });
  return rows.slice(-2).map((row) => ({
    decision: String((row as { decision?: unknown }).decision),
    grounds: String((row as { grounds?: unknown }).grounds),
  }));
}

describe('runner の一覧を読めないときの PUT / DELETE /profile/:name（#6506）', () => {
  it('PUT は 200: 応答に runnersUnconfirmed（伏せた理由）が載り、日誌が確かめられなかったと書く', async () => {
    vi.stubEnv(SECRET_ENV_NAME, FAKE_ENV_VALUE);
    const { stores, app } = setup(true);

    const response = await app.request('/profile/rust', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'export R=1' }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(FAKE_ENV_VALUE);
    const body = JSON.parse(text) as { runnersUnconfirmed?: string; runners: unknown[] };
    expect(body.runnersUnconfirmed).toBe('Error: 一覧が取れない [REDACTED]');
    expect(body.runners).toEqual([]);
    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['rust']);

    const [, done] = await lastTwoJournal(stores);
    expect(done?.decision).toMatch(
      /を更新した（クローン用 .*）（runner への配布は確かめられなかった）$/,
    );
    expect(done?.grounds).toContain(
      'runner への配布: 確かめられなかった（runner の一覧を読めない: Error: 一覧が取れない [REDACTED]）',
    );
    expect(done?.grounds).not.toContain(FAKE_ENV_VALUE);
  });

  it('DELETE も 200: 同じ欄と文言', async () => {
    vi.stubEnv(SECRET_ENV_NAME, FAKE_ENV_VALUE);
    const { stores, app } = setup(true);
    await stores.profile.set('rust', 'export R=1\n', 'all');

    const response = await app.request('/profile/rust', { method: 'DELETE', headers: AUTH });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { runnersUnconfirmed?: string };
    expect(body.runnersUnconfirmed).toBe('Error: 一覧が取れない [REDACTED]');
    expect(await stores.profile.list()).toEqual([]);

    const [, done] = await lastTwoJournal(stores);
    expect(done?.decision).toContain('（runner への配布は確かめられなかった）');
    expect(done?.grounds).toContain(
      'runner への配布: 確かめられなかった（runner の一覧を読めない: ',
    );
  });

  it('対照: 一覧が読めるときは欄が無く、日誌の文言も変わらない', async () => {
    const { stores, app } = setup(false);

    const response = await app.request('/profile/rust', {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ script: 'export R=1' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect('runnersUnconfirmed' in body).toBe(false);
    const [, done] = await lastTwoJournal(stores);
    expect(done?.decision).not.toContain('確かめられなかった');
    expect(done?.grounds).not.toContain('確かめられなかった');
  });
});
