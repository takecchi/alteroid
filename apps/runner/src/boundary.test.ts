import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  query as sdkQuery,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { createAdaptorServer } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * **マネージャーが自分の許可確認に自分で答えられないこと**を確かめる（roadmap M4）。
 *
 * マネージャーは runner の中で走る子プロセスであり、Bash も WebFetch も持っている。
 * 制御面（runner API）に手が届けば、`GET /managers` で自分の `requestId` を調べ、
 * `POST /managers/:id/answers` に `allow` を送って**クローンも人間も通さずに**
 * 権限境界を迂回できる。それができないことを、実際に子プロセスを起こして確かめる。
 *
 * ここで確かめるのは uid に依らない層（合鍵）である。コンテナではこれに加えて
 * 「TCP の口が無い」「ソケットは別 UID から繋げない」「runner の環境が読めない」が
 * 重なる（compose.yaml と docs/architecture.md「制御面の保護」）。
 */
const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const TCP_PORT = 4519;

const run = promisify(execFile);

interface Fake {
  options: Options;
  ask(toolName: string, requestId: string): Promise<PermissionResult>;
}

function fakeSdk() {
  const sessions: Fake[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let finish: (() => void) | null = null;
    sessions.push({
      options,
      async ask(toolName, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const result = await canUseTool(toolName, { command: 'rm -rf /' }, {
          signal: new AbortController().signal,
          requestId,
          toolUseID: `tool-${requestId}`,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した');
        return result;
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-boundary',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      // 閉じられるまで開いたまま（走行中のセッションを模す）
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

/**
 * マネージャー子プロセス相当の権限で制御面を叩く。
 *
 * **わざと有利な条件を与えている**（ソケットの所在を引数で教える）。それでも通らない
 * ことを見たいので、「知らないから届かない」を証明の代わりにしない。
 */
async function attack(env: NodeJS.ProcessEnv, socketPath: string, managerId: string) {
  const script = `
    const http = require('node:http');
    const call = (method, path, body) => new Promise((resolve) => {
      const req = http.request(
        { socketPath: process.argv[1], path, method, headers: body ? { 'content-type': 'application/json' } : {} },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', () => resolve('ERROR'));
      if (body) req.write(body);
      req.end();
    });
    (async () => {
      const managerId = process.argv[2];
      const answer = JSON.stringify({ requestId: 'req-danger', message: 'いいよ', decision: 'allow' });
      const results = {
        list: await call('GET', '/managers'),
        health: await call('GET', '/health'),
        events: await call('GET', '/events'),
        answer: await call('POST', '/managers/' + managerId + '/answers', answer),
        send: await call('POST', '/managers/' + managerId + '/messages', JSON.stringify({ text: 'x' })),
        stop: await call('DELETE', '/managers/' + managerId),
        transcript: await call('GET', '/managers/' + managerId + '/transcript'),
        // 自分に配られる鍵を自分で書き換えられないこと
        setCredentials: await call(
          'POST',
          '/credentials',
          JSON.stringify({ credentials: [{ name: 'GH_TOKEN', value: 'attacker' }] }),
        ),
        // 環境から鍵を拾えるか（runner と同じ UID なら /proc も読める前提で見る）
        token: process.env.ALTEROID_RUNNER_TOKEN ?? null,
        hash: process.env.ALTEROID_RUNNER_TOKEN_SHA256 ?? null,
        socket: process.env.ALTEROID_RUNNER_SOCKET ?? null,
        databaseUrl: process.env.ALTEROID_DATABASE_URL ?? null,
      };
      process.stdout.write(JSON.stringify(results));
    })();
  `;
  const { stdout } = await run(process.execPath, ['-e', script, socketPath, managerId], { env });
  return JSON.parse(stdout) as Record<string, unknown>;
}

let dir: string;
let socketPath: string;
let server: ServerType;
let host: RunnerHost;
let sessions: Fake[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-'));
  socketPath = join(dir, 'runner.sock');

  const fake = fakeSdk();
  sessions = fake.sessions;
  const outbox = new Outbox();
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: (event) => outbox.push(event),
    queryFn: fake.fn,
    // runner の環境。マネージャーへ渡す env からは落ちていること自体もここで見る。
    env: {
      PATH: process.env.PATH ?? '',
      ALTEROID_RUNNER_TOKEN_SHA256: TOKEN_SHA256,
      ALTEROID_RUNNER_SOCKET: socketPath,
      ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
    },
  });

  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
  chmodSync(socketPath, 0o600);
});

afterEach(async () => {
  await host.shutdown().catch(() => undefined);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('制御面の境界', () => {
  it('マネージャー子プロセスの権限では、runner の制御面を1つも叩けない', async () => {
    await host.start({ managerId: 'mgr-1', request: '危ないことをする', cwd: dir });
    const session = sessions[0] as Fake;

    // マネージャーが「rm -rf /」の許可確認を降ろし、返事待ちで止まる
    const asked = session.ask('Bash', 'req-danger');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.list()[0]?.waiting[0]?.requestId).toBe('req-danger');

    // その子プロセスと同じ環境で、制御面を総当たりする
    const result = await attack(session.options.env ?? {}, socketPath, 'mgr-1');

    // 読み書きの口はすべて拒否（`ok: false` ではなく、そもそも通らない）
    expect(result).toMatchObject({
      list: 401,
      health: 401,
      events: 401,
      answer: 401,
      send: 401,
      stop: 401,
      transcript: 401,
      setCredentials: 401,
    });

    // 鍵は環境から拾えない（記憶ストアの鍵も、制御面の鍵も、ソケットの所在も）
    expect(result.token).toBeNull();
    expect(result.hash).toBeNull();
    expect(result.socket).toBeNull();
    expect(result.databaseUrl).toBeNull();

    // **自分で allow を返せていない。** 確認はまだ人間（クローン）を待っている
    expect(host.list()[0]?.waiting[0]?.requestId).toBe('req-danger');
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it('鍵を持つデーモンなら通る（塞いだのは能力ではなく、本人確認である）', async () => {
    await host.start({ managerId: 'mgr-1', request: '調べて', cwd: dir });

    const script = `
      const http = require('node:http');
      const req = http.request(
        { socketPath: process.argv[1], path: '/managers', headers: { authorization: 'Bearer ' + process.argv[2] } },
        (res) => { res.resume(); process.stdout.write(String(res.statusCode)); },
      );
      req.end();
    `;
    const { stdout } = await run(process.execPath, ['-e', script, socketPath, TOKEN]);

    expect(stdout).toBe('200');
  });

  it('ソケット構成では TCP の口を開かない（curl の宛先が存在しない）', async () => {
    // コンテナのマネージャーが最初に試すのはこれである。
    await expect(fetch(`http://127.0.0.1:${TCP_PORT}/managers`)).rejects.toThrow();
  });

  it('ソケットの権限は所有者だけ（0600）', async () => {
    const { statSync } = await import('node:fs');
    // ここで確かめられるのは mode ビットだけである。**別 UID から実際に繋げない
    // ことは、この in-process のテストでは確かめられない**（vitest プロセスは
    // 非 root で CAP_SETUID を持たず、`pnpm test` が走るどちらの環境（ローカル・
    // CI の `ci` ジョブ）でも別 UID の子プロセスを起こせない）。**実物の検査は
    // `.github/workflows/ci.yml` の `image` ジョブに在る**（UID を実際に分けた
    // 2プロセスを器の中で走らせ、docs/architecture.md「制御面の保護」2枚目を
    // 直接見る）。
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

/**
 * fencing（世代番号）と自己失効の HTTP 面（roadmap M5 PR4）。
 *
 * **実ソケットは要らない。** ここで見たいのは Hono のルーティング・ミドルウェアの
 * 挙動（ステータスコード・`control` ミドルウェアが接触を記録するか）であって、
 * OS のソケット層は上の `beforeEach` の分で既に確かめてある。`app.request()`
 * （daemon 側の `auth.test.ts` などと同じ Hono のテスト用口）で直接叩く。
 *
 * 純粋な判定ロジック（世代の比較・自己失効の材料）は `packages/core/src/
 * runner-fence.test.ts` が固定する。ここで固定するのは**この境界だけが持つ変換**
 * ——`RunnerFenceError` → 409、`control` ミドルウェア → `noteDaemonContact()`。
 */
describe('世代（fencing token）と自己失効', () => {
  const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  it('古い世代の resume は 409 になる（Hono の既定 500 に落とさない）', async () => {
    const fake = fakeSdk();
    const outbox = new Outbox();
    const testHost = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: '/work/project',
      emit: (event) => outbox.push(event),
      queryFn: fake.fn,
      env: { PATH: process.env.PATH ?? '' },
    });
    const app = createRunnerApp({ host: testHost, outbox, tokenSha256: TOKEN_SHA256 });

    const started = await app.request('/managers', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        managerId: 'mgr-1',
        request: '調べて',
        cwd: '/work/project',
        lease: { fence: 5, ttlMs: 60_000 },
      }),
    });
    expect(started.status).toBe(200);

    const resumed = await app.request('/managers/mgr-1/resume', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        managerId: 'mgr-1',
        sessionId: 'sess-old',
        cwd: '/work/project',
        request: '再開して',
        lease: { fence: 3, ttlMs: 60_000 },
      }),
    });

    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toMatchObject({ error: 'fenced', expected: 5, given: 3 });
    // 拒まれた側は走り続けている（`runner-fence.test.ts` が中身を固定する）。
    expect(testHost.list()).toHaveLength(1);

    await testHost.shutdown().catch(() => undefined);
  });

  describe('自己失効の時計', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('`/livez`（無認証）を叩いても期限は延びない', async () => {
      const fake = fakeSdk();
      const outbox = new Outbox();
      const testHost = createRunnerHost({
        runnerId: 'runner-primary',
        workspacePath: '/work/project',
        emit: (event) => outbox.push(event),
        queryFn: fake.fn,
        env: { PATH: process.env.PATH ?? '' },
        enforceLease: true,
      });
      const app = createRunnerApp({ host: testHost, outbox, tokenSha256: TOKEN_SHA256 });

      await app.request('/managers', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          managerId: 'mgr-1',
          request: '調べて',
          cwd: '/work/project',
          lease: { fence: 1, ttlMs: 20_000 },
        }),
      });

      // 見張りの1周目（10秒）。まだ期限（20秒）には届かない。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(1);

      // 無認証の `/livez` を何度叩いても、貸し出し期限の時計は進まない
      // （進んでしまうと、誰でも期限を延ばせることになる）。
      await app.request('/livez');
      await app.request('/livez');

      // 見張りの2周目（合計20秒）。`/livez` は効いていないので期限切れになる。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(0);

      await testHost.shutdown().catch(() => undefined);
    });

    it('認証済みの制御面の呼び（`GET /health`）は接触として記録され、期限を延ばす', async () => {
      const fake = fakeSdk();
      const outbox = new Outbox();
      const testHost = createRunnerHost({
        runnerId: 'runner-primary',
        workspacePath: '/work/project',
        emit: (event) => outbox.push(event),
        queryFn: fake.fn,
        env: { PATH: process.env.PATH ?? '' },
        enforceLease: true,
      });
      const app = createRunnerApp({ host: testHost, outbox, tokenSha256: TOKEN_SHA256 });

      await app.request('/managers', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({
          managerId: 'mgr-1',
          request: '調べて',
          cwd: '/work/project',
          lease: { fence: 1, ttlMs: 20_000 },
        }),
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(1);

      // 認証済みの呼び。**これで接触の時計が進む。**
      const health = await app.request('/health', { headers: AUTH });
      expect(health.status).toBe(200);

      // 起動時点からは20秒を過ぎるが、接触からはまだ10秒。畳まれない。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(1);

      // 接触から20秒経った。ここで期限が切れる。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(0);

      await testHost.shutdown().catch(() => undefined);
    });
  });
});
