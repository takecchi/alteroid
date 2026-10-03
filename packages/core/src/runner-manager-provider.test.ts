import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChildProcess } from './agent-session.js';
import { createRunnerHost } from './runner.js';
import {
  runnerResumeCommandSchema,
  runnerStartCommandSchema,
  type RunnerEvent,
} from './runner-protocol.js';

/**
 * マネージャー層の provider が runner の駆動役の選択まで届くこと（#486 S6）。
 *
 * 既定（省略・`claude`）は従来どおり `queryFn`（SDK の `query()`）を使い、`codex` のときは
 * `CodexManagerDriver` が `codex app-server` を起こす（`spawnAgentProcessFn` の差し替え口
 * 経由。実プロセスは起こさない）。
 */

function untouchedQuery(): { fn: typeof sdkQuery; calls: () => number } {
  const fn = vi.fn(() => {
    // 開いたままにし、close() で終わる（読み手は何も受け取らない）
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    // eslint-disable-next-line require-yield
    async function* generate(): AsyncGenerator<never, void> {
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  });
  return { fn: fn as unknown as typeof sdkQuery, calls: () => fn.mock.calls.length };
}

/** `codex app-server` の最小の偽物（ChatGPT ログイン済み・thread/start に答えるだけ）。 */
function fakeAppServer(): AgentChildProcess & { received: string[]; threadStarts: unknown[] } {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: string[] = [];
  const threadStarts: unknown[] = [];
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, i)) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      buffer = buffer.slice(i + 1);
      if (message.method !== undefined) received.push(message.method);
      if (message.method === 'thread/start') threadStarts.push(message.params);
      if (message.id === undefined) continue;
      const result: Record<string, unknown> =
        message.method === 'account/read'
          ? {
              requiresOpenaiAuth: false,
              account: { type: 'chatgpt', email: null, planType: 'plus' },
            }
          : message.method === 'thread/start'
            ? {
                thread: { id: 'thr-codex', cwd: '/work' },
                model: 'gpt-5',
                approvalPolicy: 'on-request',
              }
            : { userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' };
      stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
  });
  return Object.assign(emitter, {
    stdin,
    stdout,
    received,
    threadStarts,
    killed: false,
    exitCode: null,
    pid: 5151,
    kill: () => true,
  }) as unknown as AgentChildProcess & { received: string[]; threadStarts: unknown[] };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  // 実時間では待たず、イベントループを回して条件を見る（I/O の通知も進む）。
  for (let i = 0; i < 20_000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`待ちが終わらない: ${what}`);
}

describe('runner: マネージャー層の provider の選択', () => {
  it('省略（既定）は Claude の駆動役。queryFn が呼ばれ、codex は起こさない', async () => {
    const sdk = untouchedQuery();
    const spawned: string[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdk.fn,
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push(options.command);
        return fakeAppServer();
      },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.calls()).toBe(1);
    expect(spawned).toEqual([]);
    await host.shutdown();
  });

  it('managerProvider: codex は CodexManagerDriver。queryFn は呼ばれず、codex app-server を起こす', async () => {
    const sdk = untouchedQuery();
    const events: RunnerEvent[] = [];
    const children: ReturnType<typeof fakeAppServer>[] = [];
    const spawned: { command: string; args: string[] }[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: sdk.fn,
      managerProvider: 'codex',
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push({ command: options.command, args: options.args });
        const child = fakeAppServer();
        children.push(child);
        return child;
      },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    await until(
      () => events.some((e) => e.type === 'session' && e.sessionId === 'thr-codex'),
      'session イベント',
    );
    expect(sdk.calls()).toBe(0);
    expect(spawned).toEqual([{ command: 'codex', args: ['app-server', '--listen', 'stdio://'] }]);
    expect(children[0]!.received).toEqual(
      expect.arrayContaining(['initialize', 'initialized', 'account/read', 'thread/start']),
    );
    await host.shutdown();
  });

  /**
   * #486 S7: 命令（start / resume）が provider を名指しすれば、host の既定ではなくそれで動く。
   */
  it('start の provider: codex は、既定が claude の host でも Codex の駆動役で起こす', async () => {
    const sdk = untouchedQuery();
    const events: RunnerEvent[] = [];
    const spawned: string[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: sdk.fn,
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push(options.command);
        return fakeAppServer();
      },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work', provider: 'codex' });
    await until(
      () => events.some((e) => e.type === 'session' && e.sessionId === 'thr-codex'),
      'session イベント',
    );
    expect(sdk.calls()).toBe(0);
    expect(spawned).toEqual(['codex']);
    await host.shutdown();
  });

  it('start の provider: claude は、既定が codex の host でも Claude の駆動役で起こす', async () => {
    const sdk = untouchedQuery();
    const spawned: string[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdk.fn,
      managerProvider: 'codex',
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push(options.command);
        return fakeAppServer();
      },
    });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work', provider: 'claude' });
    expect(sdk.calls()).toBe(1);
    expect(spawned).toEqual([]);
    await host.shutdown();
  });

  it('resume の provider: codex も、既定が claude の host で Codex として開き直す。省略なら既定', async () => {
    const sdk = untouchedQuery();
    const spawned: string[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdk.fn,
      env: {},
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: (options) => {
        spawned.push(options.command);
        return fakeAppServer();
      },
    });
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'thr-codex',
      request: 'つづき',
      cwd: '/work',
      provider: 'codex',
    });
    await until(() => spawned.length === 1, 'codex の起動');
    expect(sdk.calls()).toBe(0);
    await host.shutdown();

    const sdk2 = untouchedQuery();
    const host2 = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: () => undefined,
      queryFn: sdk2.fn,
      env: {},
      childUser: { uid: 1000, gid: 1000 },
    });
    await host2.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-claude',
      request: 'つづき',
      cwd: '/work',
    });
    await until(() => sdk2.calls() === 1, 'claude の起動');
    await host2.shutdown();
  });

  it('命令の provider は知らない値を断り（400 の元）、省略は従来どおり通る', () => {
    const base = { managerId: 'm', request: 'r', cwd: '/w' };
    expect(runnerStartCommandSchema.safeParse(base).success).toBe(true);
    expect(runnerStartCommandSchema.safeParse({ ...base, provider: 'codex' }).success).toBe(true);
    expect(runnerStartCommandSchema.safeParse({ ...base, provider: 'gemini' }).success).toBe(false);
    expect(
      runnerResumeCommandSchema.safeParse({ ...base, sessionId: 's', provider: 'gemini' }).success,
    ).toBe(false);
  });
});

describe('runner: 置かれたモデルは host の既定 provider のセッションにだけ効く（#486 S7）', () => {
  async function codexThreadStartParams(
    env: NodeJS.ProcessEnv,
    managerProvider: 'claude' | 'codex',
  ): Promise<Record<string, unknown>> {
    const events: RunnerEvent[] = [];
    const children: ReturnType<typeof fakeAppServer>[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work',
      emit: (event) => events.push(event),
      queryFn: untouchedQuery().fn,
      managerProvider,
      env,
      childUser: { uid: 1000, gid: 1000 },
      spawnAgentProcessFn: () => {
        const child = fakeAppServer();
        children.push(child);
        return child;
      },
    });
    await host.start({
      managerId: 'mgr-1',
      request: 'やって',
      cwd: '/work',
      provider: 'codex',
    });
    await until(() => children[0]?.threadStarts.length === 1, 'thread/start');
    await host.shutdown();
    return children[0]?.threadStarts[0] as Record<string, unknown>;
  }

  it('claude 既定の host で ALTEROID_MANAGER_MODEL が置かれていても、指名された codex には model を渡さない', async () => {
    const params = await codexThreadStartParams({ ALTEROID_MANAGER_MODEL: 'sonnet' }, 'claude');
    expect(params).not.toHaveProperty('model');
  });

  it('対照: codex 既定の host で置かれたモデルは、従来どおり codex へ渡る', async () => {
    const params = await codexThreadStartParams({ ALTEROID_MANAGER_MODEL: 'sonnet' }, 'codex');
    expect(params).toHaveProperty('model', 'sonnet');
  });
});
