import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChildProcess } from './agent-session.js';
import { createRunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * マネージャー層の provider が runner の駆動役の選択まで届くこと（#486 S6）。
 *
 * 既定（省略・`claude`）は従来どおり `queryFn`（SDK の `query()`）を使い、`codex` のときは
 * `CodexManagerDriver` が `codex app-server` を起こす（`spawnClaudeCodeProcessFn` の差し替え口
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
function fakeAppServer(): AgentChildProcess & { received: string[] } {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: string[] = [];
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, i)) as { id?: number; method?: string };
      buffer = buffer.slice(i + 1);
      if (message.method !== undefined) received.push(message.method);
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
    killed: false,
    exitCode: null,
    pid: 5151,
    kill: () => true,
  }) as unknown as AgentChildProcess & { received: string[] };
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
      spawnClaudeCodeProcessFn: (options) => {
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
      spawnClaudeCodeProcessFn: (options) => {
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
});
