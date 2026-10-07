import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChildProcess } from './agent-session.js';
import { createRunnerHost } from './runner.js';
import {
  runnerResumeCommandSchema,
  runnerStartCommandSchema,
} from './runner-protocol.js';

/**
 * **マネージャー層は常に Claude で動く**（2026-10-07 のオーナー決定）。runner の既定の provider
 * （旧 `ALTEROID_MANAGER_PROVIDER`）と、命令の `provider` 欄（#486 S6 / S7）は撤去した。
 *
 * ここでは、Claude の駆動役（`queryFn` ＝ SDK の `query()`）で起こすこと、そして**旧いデーモンが
 * `provider` 欄を送ってきても**（版ずれ）命令は断られずに欄だけ捨てられ、Claude で起こすことを測る。
 * `codex app-server` を起こさないことは `spawnAgentProcessFn` の差し替え口で見る（実プロセスは起こさない）。
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

  it('旧いデーモンが start / resume に provider: codex を載せても、欄は捨てられ Claude で起こす', async () => {
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
    const start = runnerStartCommandSchema.parse({
      managerId: 'mgr-1',
      request: 'やって',
      cwd: '/work',
      provider: 'codex',
    });
    expect(start).not.toHaveProperty('provider');
    await host.start(start);
    const resume = runnerResumeCommandSchema.parse({
      managerId: 'mgr-2',
      sessionId: 'sess-claude',
      request: 'つづき',
      cwd: '/work',
      provider: 'codex',
    });
    expect(resume).not.toHaveProperty('provider');
    await host.resume(resume);
    await until(() => sdk.calls() === 2, 'claude の起動（start と resume）');
    expect(spawned).toEqual([]);
    await host.shutdown();
  });

  it('命令の provider 欄は、知らない値でも断らずに捨てる（旧いデーモンの命令を 400 にしない）', () => {
    const base = { managerId: 'm', request: 'r', cwd: '/w' };
    expect(runnerStartCommandSchema.safeParse(base).success).toBe(true);
    for (const provider of ['codex', 'gemini']) {
      const start = runnerStartCommandSchema.safeParse({ ...base, provider });
      expect(start.success && !('provider' in start.data)).toBe(true);
      const resume = runnerResumeCommandSchema.safeParse({ ...base, sessionId: 's', provider });
      expect(resume.success && !('provider' in resume.data)).toBe(true);
    }
  });
});
