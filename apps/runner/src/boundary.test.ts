import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
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

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerApp, Outbox } from './app.js';

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

// ソケットの所在を引数で教える: 「知らないから届かない」を証明の代わりにしないため。
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
        setCredentials: await call(
          'POST',
          '/credentials',
          JSON.stringify({ credentials: [{ name: 'GH_TOKEN', value: 'attacker' }] }),
        ),
        setMcpServers: await call(
          'POST',
          '/mcp-servers',
          JSON.stringify({ mcpServers: { evil: { command: 'attacker' } } }),
        ),
        getMcpServers: await call('GET', '/mcp-servers'),
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
  dir = makeTempDirSync('alteroid-runner-');
  socketPath = join(dir, 'runner.sock');

  const fake = fakeSdk();
  sessions = fake.sessions;
  const outbox = new Outbox();
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: (event) => outbox.push(event),
    queryFn: fake.fn,
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
});

describe('制御面の境界', () => {
  it('マネージャー子プロセスの権限では、runner の制御面を1つも叩けない', async () => {
    await host.start({ managerId: 'mgr-1', request: '危ないことをする', cwd: dir });
    const session = sessions[0] as Fake;

    const asked = session.ask('Bash', 'req-danger');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.list()[0]?.waiting[0]?.requestId).toBe('req-danger');

    const result = await attack(session.options.env ?? {}, socketPath, 'mgr-1');

    expect(result).toMatchObject({
      list: 401,
      health: 401,
      events: 401,
      answer: 401,
      send: 401,
      stop: 401,
      transcript: 401,
      setCredentials: 401,
      setMcpServers: 401,
      getMcpServers: 401,
    });
    expect(host.mcpServers()).toBeUndefined();

    expect(result.token).toBeNull();
    expect(result.hash).toBeNull();
    expect(result.socket).toBeNull();
    expect(result.databaseUrl).toBeNull();

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
    // env を空で明示する: 無指定だと親（このテストプロセス）の本物の秘密を継承するため。
    const { stdout } = await run(process.execPath, ['-e', script, socketPath, TOKEN], { env: {} });

    expect(stdout).toBe('200');
  });

  it('ソケット構成では TCP の口を開かない（curl の宛先が存在しない）', async () => {
    await expect(fetch(`http://127.0.0.1:${TCP_PORT}/managers`)).rejects.toThrow();
  });

  it('ソケットの権限は所有者だけ（0600）', async () => {
    const { statSync } = await import('node:fs');
    // mode ビットだけを見る: vitest プロセスは非 root で別 UID の子を起こせず、実物の検査は CI の `image` ジョブが持つため。
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

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
        // cgroup の実ファイルと未 push の観測を実 I/O させない: fake timer の下では実 I/O の完了が assertion より遅れ、`list()` が委譲を持ったままになるため。
        readCgroupEventCountersFn: async () => ({}),
        finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
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

      await app.request('/livez');
      await app.request('/livez');

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
        readCgroupEventCountersFn: async () => ({}),
        finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
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

      const health = await app.request('/health', { headers: AUTH });
      expect(health.status).toBe(200);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(testHost.list()).toHaveLength(0);

      await testHost.shutdown().catch(() => undefined);
    });
  });
});
