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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('ソケットの権限は所有者だけ（別 UID の子プロセスは繋げない）', async () => {
    const { statSync } = await import('node:fs');
    // 0600。UID を分けたコンテナでは、これが「繋げない」を意味する。
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});
