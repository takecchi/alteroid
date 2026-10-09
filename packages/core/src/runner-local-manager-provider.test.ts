import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChildProcess } from './agent-session.js';
import { createLocalRunner } from './runner-local.js';
import type { RunnerEvent } from './runner-protocol.js';

const spawned: { command: string; args: readonly string[] }[] = [];
const fakeChildren: (AgentChildProcess & { received: string[] })[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: (command: string, args: readonly string[]) => {
      spawned.push({ command, args });
      const child = fakeAppServer();
      fakeChildren.push(child);
      return child;
    },
  };
});

function untouchedQuery(): { fn: typeof sdkQuery; calls: () => number } {
  const fn = vi.fn(() => {
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

describe('local runner: マネージャー層の provider', () => {
  it('Claude の駆動役で起こし、hello に provider の名乗り（managerProvider / managerProviders）を載せない', async () => {
    spawned.length = 0;
    const sdk = untouchedQuery();
    const events: RunnerEvent[] = [];
    const runner = createLocalRunner({
      workspacePath: '/work',
      queryFn: sdk.fn,
      env: {},
    });
    await runner.connect((event) => events.push(event));
    const hello = events.find((e) => e.type === 'hello');
    expect(hello).toBeDefined();
    expect(hello && 'managerProvider' in hello).toBe(false);
    expect(hello && 'managerProviders' in hello).toBe(false);
    await runner.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.calls()).toBe(1);
    expect(spawned).toEqual([]);
    expect(fakeChildren).toEqual([]);
    await runner.close();
  });
});
