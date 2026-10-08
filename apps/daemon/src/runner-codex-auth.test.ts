import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createCodexChatgptAuthService,
  createManagerPool,
  createMemoryStores,
  createRunnerHost,
  createRunnerRegistry,
  fingerprintOf,
  type CodexChatgptAuthService,
  type ManagerPool,
  type RunnerHost,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createHttpRunner } from './runner-client.js';

/**
 * Codex の ChatGPT ログイン（#3939）を、デーモンの正本 → 制御面（HTTP）→ runner の CODEX_HOME へ
 * 降ろし、Codex が書き換えた auth.json を出来事（SSE）→ 制御面で取りに行って正本へ書き戻すまでを、
 * 本物の runner の app と HTTP の client で通す。
 */

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const LOGIN_VALUE = '{"tokens":{"refresh_token":"rt-e2e-login-fake"}}';
const REFRESHED = '{"tokens":{"refresh_token":"rt-e2e-refreshed-fake"}}';

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'u',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

interface Rig {
  pool: ManagerPool;
  stores: Stores;
  host: RunnerHost;
  service: CodexChatgptAuthService | undefined;
  codexHome: string;
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

async function rig(options: { stores?: Stores; oldRunner?: boolean; oldDaemon?: boolean } = {}) {
  const codexHome = join(await makeTempDir('alteroid-codex-e2e-'), 'codex-home');
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    codexHome,
    codexAuthCheckIntervalMs: 20,
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (options.oldRunner === true && url.pathname.startsWith('/codex-auth')) {
      return new Response('404 Not Found', { status: 404 });
    }
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;
  const client = await createHttpRunner({ baseUrl: 'http://runner.test', token: TOKEN, fetchFn });
  const stores = options.stores ?? createMemoryStores();
  const registry = createRunnerRegistry([client]);
  const service =
    options.oldDaemon === true
      ? undefined
      : createCodexChatgptAuthService({
          store: stores.codexAuth,
          runners: registry,
          journal: async (entry) => {
            await stores.journal.append(entry);
          },
          startDeviceLogin: () => Promise.reject(new Error('この試験ではログインしない')),
        });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    ...(service === undefined ? {} : { codexAuth: service }),
  });
  const created: Rig = {
    pool,
    stores,
    host,
    service,
    codexHome,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
  rigs.push(created);
  return created;
}

async function loggedInStores(): Promise<Stores> {
  const stores = createMemoryStores();
  await stores.codexAuth.replace({
    value: LOGIN_VALUE,
    revision: 'rev-login',
    updatedAt: '2026-10-07T00:00:00.000Z',
    email: 'me@example.com',
    planType: 'plus',
    failure: null,
  });
  return stores;
}

// 実時間で待つ（本物の SSE と runner の見回りの周期を通すため）。待ちは vi.waitFor の見回りに任せる。
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await condition())) throw new Error(`まだ: ${what}`);
    },
    { timeout: 3000, interval: 10 },
  );
}

describe('Codex の ChatGPT ログインを runner へ降ろし、書き戻す（#3939）', () => {
  it('runner が繋がると正本が CODEX_HOME/auth.json（0600）へ降りる', async () => {
    const r = await rig({ stores: await loggedInStores() });
    await r.pool.start({ request: '1本' });
    expect(r.host.codexAuth()).toMatchObject({ placed: true, revision: 'rev-login' });
    const path = join(r.codexHome, 'auth.json');
    expect(await readFile(path, 'utf8')).toBe(LOGIN_VALUE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('Codex が書き換えた auth.json は、版の compare-and-swap で正本へ書き戻され、値は日誌に載らない', async () => {
    const r = await rig({ stores: await loggedInStores() });
    await r.pool.start({ request: '1本' });
    await writeFile(join(r.codexHome, 'auth.json'), REFRESHED);
    await until(
      async () => (await r.stores.codexAuth.get())?.value === REFRESHED,
      '正本への書き戻し',
    );
    const stored = await r.stores.codexAuth.get();
    expect(stored?.revision).not.toBe('rev-login');
    await until(
      async () => r.host.codexAuth().revision === stored?.revision,
      'runner へ新しい版が降り直す',
    );
    const journal = JSON.stringify(await r.stores.journal.list({}));
    expect(journal).toContain('書き戻した');
    expect(journal).not.toContain('rt-e2e-refreshed-fake');
    expect(journal).not.toContain('rt-e2e-login-fake');
  });

  it('ログインしていなければ CODEX_HOME を作らない', async () => {
    const r = await rig();
    await r.pool.start({ request: '1本' });
    expect(r.host.codexAuth()).toEqual({ placed: false, revision: null, fingerprint: null });
    await expect(stat(r.codexHome)).rejects.toThrow();
  });

  it('古いデーモン（降ろさない）と組んだ runner は何も置かず、書き換えの知らせも委譲を止めない', async () => {
    const r = await rig({ stores: await loggedInStores(), oldDaemon: true });
    await r.pool.start({ request: '1本' });
    expect(r.host.codexAuth().placed).toBe(false);
    await r.host.setCodexAuth({ value: LOGIN_VALUE, revision: 'r' });
    await writeFile(join(r.codexHome, 'auth.json'), REFRESHED);
    // runner の見回りが書き換えを見つけた（知らせを出した）ところまで待つ。旧いデーモンは取りに来ない。
    await until(
      async () => r.host.takeCodexAuthWriteBack(fingerprintOf(REFRESHED)) !== null,
      'runner が書き換えを見つける',
    );
    await r.pool.start({ request: 'もう1本' });
    expect((await r.stores.codexAuth.get())?.value).toBe(LOGIN_VALUE);
  });

  it('古い runner（口が無い＝404）には降ろせないことを1度だけ日誌に残し、委譲は止まらない', async () => {
    const r = await rig({ stores: await loggedInStores(), oldRunner: true });
    await r.pool.start({ request: '1本' });
    await r.pool.reattachRunner('runner-primary');
    const notes = (await r.stores.journal.list({})).filter((e) =>
      JSON.stringify(e).includes('降ろせなかった'),
    );
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain('rt-e2e-login-fake');
  });
});
