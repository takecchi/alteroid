import { createHash } from 'node:crypto';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  computePluginContentSha256,
  createManagerPool,
  createMemoryStores,
  createPluginDistributionService,
  createRunnerHost,
  createRunnerRegistry,
  RunnerPluginsUnsupportedError,
  type ManagerPool,
  type RunnerClient,
  type RunnerHost,
  type RunnerPlugin,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

/**
 * daemon から runner へ plugin を送る口（`RunnerClient.plugins` / `setPlugin` / `retainPlugins`）。
 *
 * **境界は本物を通す**（`runner-mcp-servers.test.ts` と同じ作法）。runner の Hono アプリへ直に流す
 * fetch で、制御面の門番・JSON と base64 の往復・404 の扱いまで確かめる。値はすべて偽物である。
 */

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const SHA = 'a'.repeat(40);

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
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

/** UTF-8 として読めないバイトと NUL を含む本体（base64 の往復で壊れないことを見る）。 */
const BINARY = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255, 0, 10, 13]);

function plugin(name: string, overrides: Partial<RunnerPlugin> = {}): RunnerPlugin {
  const files = [
    {
      path: '.claude-plugin/plugin.json',
      executable: false,
      content: Buffer.from('dummy-content'),
    },
    { path: 'bin/tool', executable: true, content: BINARY },
  ];
  return {
    name,
    sourceSha: SHA,
    scope: 'all',
    enableHooks: false,
    enableMcp: false,
    contentSha256: computePluginContentSha256(files),
    files,
    ...overrides,
  };
}

interface Rig {
  host: RunnerHost;
  client: RunnerClient;
  stores: Stores;
  pool: ManagerPool;
  /** runner の制御面へ届いた plugin 関連の呼び（生の文字列）。 */
  posted: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

async function rig(
  options: { oldRunner?: boolean; garbleHealth?: boolean; stores?: Stores } = {},
): Promise<Rig> {
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const posted: Rig['posted'] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const isPluginPath = url.pathname === '/plugins' || url.pathname.startsWith('/plugins/');
    if (isPluginPath) {
      if (options.oldRunner === true) return new Response('404 Not Found', { status: 404 });
      posted.push({ method: init?.method ?? 'GET', path: url.pathname, body: String(init?.body) });
    }
    const response = await app.request(`${url.pathname}${url.search}`, init as never);
    if (
      url.pathname === '/health' &&
      (options.garbleHealth === true || options.oldRunner === true)
    ) {
      const body = (await response.json()) as Record<string, unknown>;
      if (options.garbleHealth === true) body.plugins = { sha256: 42 };
      else delete body.plugins;
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response;
  }) as typeof fetch;

  const client = await createHttpRunner({ baseUrl: 'http://runner.test', token: TOKEN, fetchFn });
  const stores = options.stores ?? createMemoryStores();
  const registry = createRunnerRegistry([client]);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    plugins: createPluginDistributionService({ stores, runners: registry }),
  });
  const created: Rig = {
    host,
    client,
    stores,
    pool,
    posted,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
  rigs.push(created);
  return created;
}

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

describe('HttpRunner: plugin の送り', () => {
  it('base64 で往復する（UTF-8 でないバイト・NUL を含んでも contentSha256 が合う）', async () => {
    const r = await rig();
    const input = plugin('p-one');

    const placed = await r.client.setPlugin?.(input);

    expect(placed).toEqual({
      name: 'p-one',
      sha: SHA,
      contentSha256: input.contentSha256,
      enableHooks: false,
      enableMcp: false,
    });
    // 本文は JSON で、content は base64。生のバイトは載らない。
    const sent = JSON.parse(r.posted[0]?.body ?? '{}') as { files: { content: string }[] };
    expect(sent.files.map((f) => f.content)).toEqual([
      Buffer.from('dummy-content').toString('base64'),
      Buffer.from(BINARY).toString('base64'),
    ]);
    expect(r.posted[0]).toMatchObject({ method: 'POST', path: '/plugins/p-one' });
    // runner が検査（contentSha256 の突き合わせ）を通して持った = バイトが壊れていない。
    expect(r.host.plugins()?.plugins).toEqual([
      {
        name: 'p-one',
        sha: SHA,
        contentSha256: input.contentSha256,
        enableHooks: false,
        enableMcp: false,
      },
    ]);
  });

  it('plugins() は /health の指紋を読む。持っていなければ undefined', async () => {
    const r = await rig();
    expect(await r.client.plugins?.()).toBeUndefined();
    await r.client.setPlugin?.(plugin('p-one'));
    const fp = await r.client.plugins?.();
    expect(fp?.plugins.map((p) => p.name)).toEqual(['p-one']);
    expect(JSON.stringify(fp)).not.toContain('dummy-content');
  });

  it('retainPlugins は一覧に無いものを外し、残った指紋を返す', async () => {
    const r = await rig();
    await r.client.setPlugin?.(plugin('p-one'));
    await r.client.setPlugin?.(plugin('p-two'));
    const fp = await r.client.retainPlugins?.(['p-two']);
    expect(fp?.plugins.map((p) => p.name)).toEqual(['p-two']);
    expect(await r.client.retainPlugins?.([])).toBeUndefined();
    expect(r.host.plugins()).toBeUndefined();
  });

  it('古い runner の 404 は RunnerPluginsUnsupportedError に、/health の欠けは undefined になる', async () => {
    const r = await rig({ oldRunner: true });
    await expect(r.client.setPlugin?.(plugin('p-one'))).rejects.toBeInstanceOf(
      RunnerPluginsUnsupportedError,
    );
    await expect(r.client.retainPlugins?.([])).rejects.toBeInstanceOf(
      RunnerPluginsUnsupportedError,
    );
    expect(await r.client.plugins?.()).toBeUndefined();
  });

  it('/health の plugins の欄が在るのに読めない形なら、undefined ではなく投げる', async () => {
    const r = await rig({ garbleHealth: true });
    await expect(r.client.plugins?.()).rejects.toThrow('plugins の欄を読めなかった');
  });

  it('runner が 400 で拒んだものは、404 に化けず普通の失敗として投げる（前の状態が残る）', async () => {
    const r = await rig();
    await r.client.setPlugin?.(plugin('p-one'));
    const bad = plugin('p-one', { contentSha256: 'f'.repeat(64) });
    const error = await r.client.setPlugin?.(bad).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RunnerPluginsUnsupportedError);
    expect(r.host.plugins()?.plugins[0]?.contentSha256).toBe(plugin('p-one').contentSha256);
  });
});

describe('名乗りでの plugin の降ろし（HTTP 経由）', () => {
  it('正本の plugin（all / runner）が hello で runner に降り、app のものは降りない', async () => {
    const stores = createMemoryStores();
    for (const [name, scope] of [
      ['p-all', 'all'],
      ['p-runner', 'runner'],
      ['p-app', 'app'],
    ] as const) {
      await stores.plugins.put({
        name,
        source: { kind: 'url', url: 'https://example.invalid/p.git', sha: SHA },
        scope,
        files: [{ path: '.claude-plugin/plugin.json', executable: false, content: BINARY }],
        installedAt: '2026-10-07T00:00:00.000Z',
        installedBy: 'tester',
      });
    }
    const r = await rig({ stores });

    await r.pool.start({ request: '走る' });

    expect(r.host.plugins()?.plugins.map((p) => p.name)).toEqual(['p-all', 'p-runner']);
    expect(r.pool.pushHealthOf('runner-primary')?.plugins?.status).toBe('ok');
  });

  it('古い runner（404）は unsupported として記録され、委譲は止まらない', async () => {
    const stores = createMemoryStores();
    await stores.plugins.put({
      name: 'p-all',
      source: { kind: 'url', url: 'https://example.invalid/p.git', sha: SHA },
      files: [{ path: '.claude-plugin/plugin.json', executable: false, content: BINARY }],
      installedAt: '2026-10-07T00:00:00.000Z',
      installedBy: 'tester',
    });
    const r = await rig({ stores, oldRunner: true });

    await r.pool.start({ request: '走る' });

    const outcome = r.pool.pushHealthOf('runner-primary')?.plugins;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('plugin を受け取る口を持たない');
  });
});
