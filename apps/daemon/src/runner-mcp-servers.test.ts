import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createManagerPool,
  createMcpServerService,
  createMemoryStores,
  createRunnerHost,
  createRunnerRegistry,
  mcpServersFingerprintOf,
  runnerEventSchema,
  RunnerMcpServersUnsupportedError,
  type ManagerPool,
  type McpServers,
  type RunnerClient,
  type RunnerHost,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner } from './runner-client.js';

/**
 * 人間の MCP 連携の登録を、デーモンが runner へ降ろしてマネージャーへ渡す（#325 段3）。
 *
 * **境界は本物を通す**（`runner-client.test.ts` と同じ作法）。runner の Hono アプリへ
 * 直に流す fetch で、制御面の門番・JSON の往復・404 の扱いまで含めて確かめる。
 * SDK だけは偽物にして、マネージャーのセッションへ渡った `Options` を見る。
 *
 * 固定しているのは4つ:
 *
 * 1. **正本の登録が、これから開くマネージャーのセッションの `mcpServers` に載る**
 *    （作業者の定義には書かない＝親から継承する。`claude-provider.ts` の doc）
 * 2. **runner が登録を失っても、名乗り直し（`hello`）で降り直す**
 *    （runner はメモリにしか持たないので、器の作り直しで消える）
 * 3. **新旧の組を壊さない** —— 古い runner（口が無い＝404）は「口なし」と名乗られ、
 *    古いデーモン（降ろさない）と組んだ新しい runner は段3 以前と同じ `Options` で走る
 * 4. **値（鍵が入りうる）は、runner の応答・指紋・日誌のどこにも出ない**
 */

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const REGISTRATION: McpServers = {
  github: { command: 'gh-mcp', args: ['--stdio'], env: { GITHUB_TOKEN: 'SECRET-IN-ENV' } },
  remote: {
    type: 'http',
    url: 'https://example.invalid/mcp',
    headers: { Authorization: 'Bearer SECRET-IN-HEADER' },
  },
};

function fakeSdk(): { fn: typeof sdkQuery; started: Options[] } {
  const started: Options[] = [];
  const fn = ((input: { options: Options }) => {
    started.push(input.options);
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
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
  return { fn, started };
}

interface Rig {
  pool: ManagerPool;
  stores: Stores;
  host: RunnerHost;
  /** デーモン側の HttpRunner（口を直に叩くため）。 */
  client: RunnerClient;
  started: Options[];
  /** runner の制御面へ届いた `POST /mcp-servers` の本文（生の文字列）。 */
  posted: string[];
  close(): Promise<void>;
}

/**
 * runner（別プロセス相当）と、それに繋ぐデーモン側のプールを1組作る。
 *
 * `oldRunner: true` は「この変更より前の runner」を模す —— `/mcp-servers` を
 * 持たないので 404 を返し、`/health` も `mcpServers` の欄を持たない。
 * `oldDaemon: true` は「この変更より前のデーモン」を模す —— プールに
 * `mcpServers` の1本道を渡さない（＝降ろさない）。
 */
async function rig(
  options: { stores?: Stores; oldRunner?: boolean; oldDaemon?: boolean } = {},
): Promise<Rig> {
  const { fn, started } = fakeSdk();
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const posted: string[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/mcp-servers') {
      if (options.oldRunner === true) return new Response('404 Not Found', { status: 404 });
      if (init?.method === 'POST') posted.push(String(init.body));
    }
    const response = await app.request(`${url.pathname}${url.search}`, init as never);
    if (options.oldRunner === true && url.pathname === '/health') {
      const body = (await response.json()) as Record<string, unknown>;
      delete body.mcpServers;
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
    ...(options.oldDaemon === true
      ? {}
      : { mcpServers: createMcpServerService({ stores, runners: registry }) }),
  });
  const created: Rig = {
    pool,
    stores,
    host,
    client,
    started,
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

describe('MCP の登録を runner へ降ろす（#325 段3）', () => {
  it('正本の登録が、マネージャーのセッションの mcpServers に載る（作業者には書かない）', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores });

    await r.pool.start({ request: '外部サービスを確かめて' });

    const options = r.started[0];
    expect(options?.mcpServers).toEqual(REGISTRATION);
    // **作業者の定義には書かない**（親の接続を継承する。名前で書くと disk config から
    // 引き直しになる —— `claude-provider.ts` の `agents` の doc）。
    const worker = Object.values(options?.agents ?? {})[0];
    expect(worker).toBeDefined();
    expect(worker && 'mcpServers' in worker).toBe(false);
    expect(worker && 'tools' in worker).toBe(false);

    // runner が名乗る指紋は、正本から取った指紋と一致する（値を見ずに「届いた」が言える）。
    expect(r.host.mcpServers()).toMatchObject({
      sha256: mcpServersFingerprintOf(REGISTRATION),
      names: ['github', 'remote'],
    });
    expect(r.pool.pushHealthOf('runner-primary')?.mcpServers?.status).toBe('ok');

    // runner_list（fingerprints: true）に名前と指紋が出る。値は出ない。
    const overview = await r.pool.runners({ fingerprints: true });
    const entry = overview.runners.find((e) => e.runnerId === 'runner-primary');
    expect(entry?.mcpServers?.names).toEqual(['github', 'remote']);
    expect(JSON.stringify(overview)).not.toContain('SECRET');
  });

  it('runner が登録を失っても、名乗り直し（hello）で降り直す', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores });
    await r.pool.start({ request: 'まず1本' });
    expect(r.host.mcpServers()).toBeDefined();

    // 器を作り直した runner を模す（メモリに置いた登録は消える）。
    r.host.setMcpServers({});
    expect(r.host.mcpServers()).toBeUndefined();

    // `reattachRunner` は runner の名乗り（`hello`）と同じ1本である（manager.ts の doc）。
    await r.pool.reattachRunner('runner-primary');

    expect(r.host.mcpServers()?.sha256).toBe(mcpServersFingerprintOf(REGISTRATION));
    await r.pool.start({ request: '作り直した後の1本' });
    expect(r.started.at(-1)?.mcpServers).toEqual(REGISTRATION);
  });

  it('同じ版が載っていれば降ろし直さない（名乗りのたびに往復を足さない）', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores });
    await r.pool.start({ request: '1本' });
    const before = r.posted.length;
    expect(before).toBe(1);

    await r.pool.reattachRunner('runner-primary');
    expect(r.posted.length).toBe(before);
  });

  it('登録が無ければ、マネージャーの Options は段3 以前と同じ（mcpServers の欄が無い）', async () => {
    const r = await rig();
    await r.pool.start({ request: '1本' });
    expect(r.started[0] && 'mcpServers' in r.started[0]).toBe(false);
    // 何も置いていないので往復もしない。
    expect(r.posted).toEqual([]);
  });

  it('古いデーモン（降ろさない）と組んだ新しい runner は、段3 以前と同じ Options で走る', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores, oldDaemon: true });
    await r.pool.start({ request: '1本' });
    expect(r.started[0] && 'mcpServers' in r.started[0]).toBe(false);
    expect(r.pool.pushHealthOf('runner-primary')?.mcpServers).toBeUndefined();
  });

  it('古い runner（口が無い＝404）は「口なし」と記録され、委譲は止まらない', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores, oldRunner: true });

    await r.pool.start({ request: '1本' });

    // 委譲は走る（押し込みの失敗で止めない）。
    expect(r.started).toHaveLength(1);
    const outcome = r.pool.pushHealthOf('runner-primary')?.mcpServers;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('MCP の登録を受け取る口を持たない');

    // 日誌に失敗が残る。**値は書かない。**
    const journal = await stores.journal.list({});
    const line = journal.find(
      (e) => e.type === 'exchange' && e.text.includes('MCP サーバの登録を降ろせなかった'),
    );
    expect(line).toBeDefined();
    expect(JSON.stringify(journal)).not.toContain('SECRET');
  });

  it('HttpRunner: 古い runner の 404 は RunnerMcpServersUnsupportedError に、/health の欠けは undefined になる', async () => {
    const r = await rig({ oldRunner: true, oldDaemon: true });

    await expect(r.client.setMcpServers?.(REGISTRATION)).rejects.toBeInstanceOf(
      RunnerMcpServersUnsupportedError,
    );
    // 古い runner の `/health` は欄を持たない ⟹「置いていない」とは区別できないが、
    // 指紋を作りもしない（区別は押し込みの 404 が持つ）。
    expect(await r.client.mcpServers?.()).toBeUndefined();
  });

  it('形が不正な登録は runner が 400 で拒み、前の登録が残る（応答に値を載せない）', async () => {
    const stores = createMemoryStores();
    await stores.mcpServers.write(REGISTRATION);
    const r = await rig({ stores });
    await r.pool.start({ request: '1本' });
    const before = r.host.mcpServers();

    const bad = {
      bad: { command: 'x', enviroment: { K: 'SECRET-TYPO' } },
    } as unknown as McpServers;
    let message = '';
    try {
      await r.client.setMcpServers?.(bad);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/\(400\)/);
    expect(message).toContain('MCP サーバの登録の形が不正');
    expect(message).not.toContain('SECRET');
    expect(r.host.mcpServers()).toEqual(before);
  });
});

describe('runner のプロトコル（#325 段3。新旧の組）', () => {
  it('hello は capabilities を持たない古い形のまま読める（段3 は新しい出来事を足していない）', () => {
    expect(runnerEventSchema.safeParse({ type: 'hello', runnerId: 'r' }).success).toBe(true);
  });

  it('RunnerMcpServersUnsupportedError は runnerId を名乗り、値を持たない', () => {
    const error = new RunnerMcpServersUnsupportedError('runner-old');
    expect(error.message).toContain('runner-old');
    expect(error.name).toBe('RunnerMcpServersUnsupportedError');
  });
});
