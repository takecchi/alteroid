import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';

interface Started {
  options: Options;
  finish: () => void;
  push: (message: SDKMessage) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
    };
    started.push(record);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => record.finish(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

async function firePermissionDenied(
  options: Options,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PermissionDenied フックが登録されていない');
  return hook(input as never, undefined, { signal });
}

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-permission-denied-p1-scope-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function setup(): { host: RunnerHost; started: Started[] } {
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fn,
    env: {},
  });
  return { host, started };
}

async function startSession(): Promise<{ started: Started; host: RunnerHost }> {
  const s = setup();
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const started = s.started[0];
  if (started === undefined) throw new Error('セッションが開いていない');
  return { started, host: s.host };
}

describe('一致鍵は入力全体を見る（issue #1768、横断レビュー14）', () => {
  it('run_in_background:false で許可を得た後、run_in_background:true の撃ち直しを通してはならない', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-run-in-background';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: false },
      tool_use_id: 'tu-scope-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-1',
      decision: 'allow',
      message: 'この前景コマンドなら1回だけ許可する。',
    });
    await denialPromise;

    const backgroundRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_use_id: 'tu-scope-1-retry-background',
    });

    expect(backgroundRetry).toEqual({ continue: true });

    const exactRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: false },
      tool_use_id: 'tu-scope-1-retry-exact',
    });
    const asRecord = exactRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('dangerouslyDisableSandbox だけが違う撃ち直しを通してはならない（issue #1768「測っていないが同じ形」）', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-sandbox';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: false },
      tool_use_id: 'tu-scope-2',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-2',
      decision: 'allow',
      message: 'サンドボックスの中でなら1回だけ許可する。',
    });
    await denialPromise;

    const sandboxOffRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: true },
      tool_use_id: 'tu-scope-2-retry-sandbox-off',
    });
    expect(sandboxOffRetry).toEqual({ continue: true });

    const exactRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: false },
      tool_use_id: 'tu-scope-2-retry-exact',
    });
    const asRecord = exactRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('欄の並び順だけが違う、内容が同一の入力は同じ入力として通す（対照。厳しすぎる側の壊れ方をしていないこと）', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-key-order';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: false, timeout: 5000 },
      tool_use_id: 'tu-scope-3',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-3',
      decision: 'allow',
      message: 'どうぞ。',
    });
    await denialPromise;

    const reorderedRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { timeout: 5000, command, run_in_background: false },
      tool_use_id: 'tu-scope-3-retry-reordered',
    });
    const asRecord = reorderedRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});
