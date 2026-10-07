import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { AgentChildProcess, AgentSpawnOptions } from './agent-session.js';
import {
  CODEX_FILE_AUTH_STORE_OVERRIDE,
  startCodexDeviceLogin,
  type CodexDeviceLoginFs,
} from './codex-device-login.js';

type Json = Record<string, unknown>;

const AUTH_JSON = JSON.stringify({ tokens: { refresh_token: 'rt-fake-not-real' } });

/** デバイスコードのログインを演じる app-server。 */
class FakeLoginServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Json[] = [];
  killed = false;
  exitCode: number | null = null;
  #buffer = '';
  account: Json | null = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };
  startError: string | undefined;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() !== '') this.#handle(JSON.parse(line) as Json);
        index = this.#buffer.indexOf('\n');
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  notify(method: string, params: Json): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  methods(): string[] {
    return this.received.map((m) => m['method']).filter((m): m is string => typeof m === 'string');
  }

  #handle(message: Json): void {
    this.received.push(message);
    const id = message['id'];
    const method = message['method'];
    if (id === undefined || typeof method !== 'string') return;
    const reply = (result: unknown): void => {
      this.stdout.write(`${JSON.stringify({ id, result })}\n`);
    };
    switch (method) {
      case 'initialize':
        reply({ userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' });
        return;
      case 'account/login/start':
        if (this.startError !== undefined) {
          this.stdout.write(
            `${JSON.stringify({ id, error: { code: -32000, message: this.startError } })}\n`,
          );
          return;
        }
        reply({
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://auth.example/device',
        });
        return;
      case 'account/read':
        reply({ requiresOpenaiAuth: true, account: this.account });
        return;
      case 'account/login/cancel':
        reply({ status: 'canceled' });
        return;
      default:
        reply({});
    }
  }
}

function harness(): {
  server: FakeLoginServer;
  spawned: AgentSpawnOptions[];
  fs: CodexDeviceLoginFs & { files: Map<string, string>; removed: string[]; made: string[] };
  spawnProcess: (options: AgentSpawnOptions) => AgentChildProcess;
} {
  const server = new FakeLoginServer();
  const spawned: AgentSpawnOptions[] = [];
  const files = new Map<string, string>();
  const removed: string[] = [];
  const made: string[] = [];
  const fs = {
    files,
    removed,
    made,
    mkdtemp: async (prefix: string) => {
      const dir = `${prefix}X1`;
      made.push(dir);
      return dir;
    },
    readFile: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    rm: async (path: string) => {
      removed.push(path);
    },
  };
  return {
    server,
    spawned,
    fs,
    spawnProcess: (options) => {
      spawned.push(options);
      return server as unknown as AgentChildProcess;
    },
  };
}

describe('Codex のデバイスコードのログイン（#3939）', () => {
  it('開始すると確認用 URL とコードが返り、承認の通知で auth.json の中身とアカウントが返る。一時 CODEX_HOME は消える', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({
      env: { PATH: '/bin', CODEX_API_KEY: 'sk-should-not-leak' },
      spawnProcess: h.spawnProcess,
      fs: h.fs,
      tmpRoot: '/tmp',
    });
    expect(login.started).toEqual({
      loginId: 'login-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://auth.example/device',
    });
    const home = h.fs.made[0];
    expect(home).toBeDefined();
    // 子は一時 CODEX_HOME で、保存先を file に固定して起きる。API キーは渡さない。
    expect(h.spawned[0]?.env['CODEX_HOME']).toBe(home);
    expect(h.spawned[0]?.env['CODEX_API_KEY']).toBeUndefined();
    expect(h.spawned[0]?.args).toEqual([
      '-c',
      CODEX_FILE_AUTH_STORE_OVERRIDE,
      'app-server',
      '--listen',
      'stdio://',
    ]);
    expect(
      h.server.received.find((m) => m['method'] === 'account/login/start')?.['params'],
    ).toEqual({ type: 'chatgptDeviceCode' });

    // 人間がブラウザで承認した: app-server が auth.json を書き、完了を知らせる。
    h.fs.files.set(`${home}/auth.json`, AUTH_JSON);
    h.server.notify('account/login/completed', { success: true, loginId: 'login-1' });
    const outcome = await login.outcome;
    expect(outcome).toEqual({
      kind: 'succeeded',
      authJson: AUTH_JSON,
      email: 'me@example.com',
      planType: 'plus',
    });
    expect(h.fs.removed).toContain(home);
    expect(h.server.killed).toBe(true);
  });

  it('承認されなかった（success: false）ら失敗として返し、一時ディレクトリを消す', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({ env: {}, spawnProcess: h.spawnProcess, fs: h.fs });
    h.server.notify('account/login/completed', {
      success: false,
      loginId: 'login-1',
      error: 'device code expired',
    });
    expect(await login.outcome).toEqual({ kind: 'failed', reason: 'device code expired' });
    expect(h.fs.removed).toEqual(h.fs.made);
  });

  it('別の loginId の完了は無視する', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({ env: {}, spawnProcess: h.spawnProcess, fs: h.fs });
    h.server.notify('account/login/completed', { success: false, loginId: 'other' });
    login.cancel();
    expect(await login.outcome).toEqual({ kind: 'canceled' });
    expect(h.server.methods()).toContain('account/login/cancel');
    expect(h.fs.removed).toEqual(h.fs.made);
  });

  it('期限が来たら取り消して expired を返す', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({
      env: {},
      spawnProcess: h.spawnProcess,
      fs: h.fs,
      timeoutMs: 5,
    });
    expect(await login.outcome).toEqual({ kind: 'expired' });
    expect(h.server.methods()).toContain('account/login/cancel');
    expect(h.fs.removed).toEqual(h.fs.made);
  });

  it('始められなかったら投げ、一時ディレクトリは消してある', async () => {
    const h = harness();
    h.server.startError = 'chatgpt login disabled';
    await expect(
      startCodexDeviceLogin({ env: {}, spawnProcess: h.spawnProcess, fs: h.fs }),
    ).rejects.toThrow(/始められなかった.*chatgpt login disabled/);
    expect(h.fs.removed).toEqual(h.fs.made);
  });

  it('auth.json が JSON でなければ失敗にする（値は理由に載せない）', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({ env: {}, spawnProcess: h.spawnProcess, fs: h.fs });
    h.fs.files.set(`${h.fs.made[0] ?? ''}/auth.json`, 'not-json-secret-value');
    h.server.notify('account/login/completed', { success: true, loginId: 'login-1' });
    const outcome = await login.outcome;
    expect(outcome.kind).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('not-json-secret-value');
  });

  it('子が途中で終わったら失敗として返す', async () => {
    const h = harness();
    const login = await startCodexDeviceLogin({ env: {}, spawnProcess: h.spawnProcess, fs: h.fs });
    h.server.exitCode = 1;
    h.server.emit('exit', 1, null);
    const outcome = await login.outcome;
    expect(outcome.kind).toBe('failed');
    expect(h.fs.removed).toEqual(h.fs.made);
  });
});
