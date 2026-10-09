import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentChildProcess,
  AgentManagerSessionSpec,
  AgentSpawnOptions,
  AgentUserInput,
} from './agent-session.js';
import {
  CODEX_EPHEMERAL_AUTH_OVERRIDE,
  CodexManagerDriver,
  isUnauthorizedCodexError,
  type CodexChatgptAuthHandle,
} from './codex-manager-driver.js';

type Json = Record<string, unknown>;

const AUTH_VALUE = '{"tokens":{"refresh_token":"rt-fake-not-real"}}';

class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly received: Json[] = [];
  killed = false;
  exitCode: number | null = null;
  #buffer = '';
  account: Json | null = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' };
  onTurn: ((turnId: string) => void) | undefined;

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
        reply({ type: 'apiKey' });
        return;
      case 'account/read':
        reply({ requiresOpenaiAuth: true, account: this.account });
        return;
      case 'thread/start':
        reply({ thread: { id: 'thr-1', cwd: '/w' }, model: 'gpt-5', approvalPolicy: 'untrusted' });
        return;
      case 'turn/start':
        reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
        setImmediate(() => this.onTurn?.('turn-1'));
        return;
      default:
        reply({});
    }
  }
}

class FakeHandle implements CodexChatgptAuthHandle {
  prepared = 0;
  checks = 0;
  failures: string[] = [];
  constructor(readonly codexHome: string | undefined) {}
  async prepare(): Promise<string | undefined> {
    this.prepared += 1;
    return this.codexHome;
  }
  async check(): Promise<void> {
    this.checks += 1;
  }
  reportFailure(reason: string): void {
    this.failures.push(reason);
  }
}

function open(options: { env?: Record<string, string>; handle?: CodexChatgptAuthHandle }): {
  server: FakeAppServer;
  spawned: AgentSpawnOptions[];
  events: AgentEvent[];
  run: () => Promise<void>;
  close: () => void;
  release: () => void;
  feed: (text: string) => void;
} {
  const server = new FakeAppServer();
  const spawned: AgentSpawnOptions[] = [];
  const events: AgentEvent[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  async function* stream(): AsyncGenerator<AgentUserInput> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield { text: next };
        continue;
      }
      const stop = await Promise.race([
        hold.then(() => true),
        new Promise<boolean>((resolve) => {
          wake = () => resolve(false);
        }),
      ]);
      if (stop) return;
    }
  }
  const spec = {
    input: stream(),
    model: 'opus',
    permissionMode: 'default',
    strictApprovals: true,
    systemPromptAppend: 'peer',
    workerAgentName: 'worker',
    workerPrompt: 'w',
    workerModel: 'sonnet',
    cwd: '/work',
    env: options.env ?? { PATH: '/bin' },
    managerAutoMemoryEnabled: false,
    sessionLog: { append: async () => undefined, load: async () => null },
    spawnProcess: (spawnOptions: AgentSpawnOptions) => {
      spawned.push(spawnOptions);
      return server as unknown as AgentChildProcess;
    },
    onNote: vi.fn(),
    onPermission: async () => ({ behavior: 'allow' }),
    onPreToolUse: vi.fn(),
    onPermissionDenied: vi.fn(),
    onPostToolUse: vi.fn(),
    onPostToolUseFailure: vi.fn(),
    onPreCompact: vi.fn(),
    onUserPromptSubmit: vi.fn(),
    onSubagentStop: vi.fn(),
    onStop: vi.fn(),
  } as unknown as AgentManagerSessionSpec;
  const session = new CodexManagerDriver({
    closeGraceMs: 0,
    ...(options.handle === undefined ? {} : { chatgptAuth: options.handle }),
  }).open(spec);
  return {
    server,
    spawned,
    events,
    run: () =>
      session.readEvents(async (event) => {
        events.push(event);
      }),
    close: () => session.close(),
    release,
    feed: (text) => {
      queue.push(text);
      wake?.();
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`まだ: ${what}`);
    },
    { timeout: 2000, interval: 5 },
  );
}

describe('peer の Codex を ChatGPT ログインで起こす（#3939）', () => {
  it('ログインが降りていれば CODEX_HOME だけを子の env に置いて起こし、値は env に載らない', async () => {
    const handle = new FakeHandle('/home/worker/.codex');
    const h = open({ handle });
    const running = h.run();
    await until(() => h.events.some((e) => e.type === 'session_started'), 'session_started');
    expect(handle.prepared).toBe(1);
    const env = h.spawned[0]?.env ?? {};
    expect(env['CODEX_HOME']).toBe('/home/worker/.codex');
    expect(JSON.stringify(env)).not.toContain('rt-fake-not-real');
    expect(Object.values(env)).not.toContain(AUTH_VALUE);
    // ephemeral にしない: 付けると auth.json を読まないため。
    expect(h.spawned[0]?.args).not.toContain(CODEX_EPHEMERAL_AUTH_OVERRIDE);
    expect(h.server.methods()).toContain('account/read');
    expect(h.server.methods()).not.toContain('account/login/start');
    const started = h.events.find((e) => e.type === 'session_started');
    expect(JSON.stringify(started)).toContain('"apiKeySource":"chatgpt"');
    h.close();
    h.release();
    await running;
    expect(handle.checks).toBeGreaterThan(0);
  });

  it('CODEX_API_KEY があればそちらが優先され、ログインは書き出さず CODEX_HOME にも触らない', async () => {
    const handle = new FakeHandle('/home/worker/.codex');
    const h = open({ handle, env: { PATH: '/bin', CODEX_API_KEY: 'sk-fake-key-not-real' } });
    const running = h.run();
    await until(() => h.events.some((e) => e.type === 'session_started'), 'session_started');
    expect(handle.prepared).toBe(0);
    expect(h.spawned[0]?.env['CODEX_HOME']).toBeUndefined();
    expect(h.spawned[0]?.env['CODEX_API_KEY']).toBeUndefined();
    expect(h.spawned[0]?.args).toContain(CODEX_EPHEMERAL_AUTH_OVERRIDE);
    expect(h.server.methods()).toContain('account/login/start');
    h.close();
    h.release();
    await running;
  });

  it('ログインが降りていなければ何も変わらない（CODEX_HOME を置かない）', async () => {
    const handle = new FakeHandle(undefined);
    const h = open({ handle });
    const running = h.run();
    await until(() => h.events.some((e) => e.type === 'session_started'), 'session_started');
    expect(handle.prepared).toBe(1);
    expect(h.spawned[0]?.env['CODEX_HOME']).toBeUndefined();
    h.close();
    h.release();
    await running;
    expect(handle.failures).toEqual([]);
  });

  it('書き出したログインを Codex が読まなければ、切れたとして知らせて止まる', async () => {
    const handle = new FakeHandle('/home/worker/.codex');
    const h = open({ handle });
    h.server.account = null;
    await expect(h.run()).rejects.toThrow(/Codex の認証が無い/);
    expect(handle.failures).toHaveLength(1);
    expect(handle.failures[0]).toContain('account/read');
  });

  it('ターンが unauthorized で落ちたら切れたとして知らせる。account/updated で見回る', async () => {
    const handle = new FakeHandle('/home/worker/.codex');
    const h = open({ handle });
    h.server.onTurn = (turnId) => {
      h.server.notify('turn/completed', {
        threadId: 'thr-1',
        turn: {
          id: turnId,
          status: 'failed',
          items: [],
          error: { message: 'refresh token was revoked', codexErrorInfo: 'unauthorized' },
        },
      });
    };
    const running = h.run();
    await until(() => h.events.some((e) => e.type === 'session_started'), 'session_started');
    const before = handle.checks;
    h.server.notify('account/updated', { authMode: 'chatgpt', planType: 'plus' });
    await until(() => handle.checks > before, 'account/updated での見回り');
    h.feed('hello');
    await until(() => h.events.some((e) => e.type === 'turn_ended'), 'turn_ended');
    expect(handle.failures).toEqual([
      'Codex のターンが認証の失敗で落ちた: refresh token was revoked',
    ]);
    h.close();
    h.release();
    await running;
  });
});

describe('isUnauthorizedCodexError', () => {
  it('unauthorized と HTTP 401 を認証の失敗と読み、他は読まない', () => {
    expect(isUnauthorizedCodexError('unauthorized')).toBe(true);
    expect(isUnauthorizedCodexError({ httpConnectionFailed: { httpStatusCode: 401 } })).toBe(true);
    expect(isUnauthorizedCodexError({ httpConnectionFailed: { httpStatusCode: 500 } })).toBe(false);
    expect(isUnauthorizedCodexError('usageLimitExceeded')).toBe(false);
    expect(isUnauthorizedCodexError(undefined)).toBe(false);
  });
});
