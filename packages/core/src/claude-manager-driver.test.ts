import type { Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentManagerSessionSpec, AgentUserInput } from './agent-session.js';
import { ClaudeManagerDriver, toClaudePermissionResult } from './claude-manager-driver.js';

describe('toClaudePermissionResult（中立の決定 → SDK の PermissionResult）', () => {
  it('allow は updatedInput が無ければ欄ごと作らない', () => {
    const result = toClaudePermissionResult({ behavior: 'allow' });
    expect(result).toEqual({ behavior: 'allow' });
    expect('updatedInput' in result).toBe(false);
  });

  it('allow は updatedInput（AskUserQuestion の答え）をそのまま運ぶ', () => {
    expect(
      toClaudePermissionResult({ behavior: 'allow', updatedInput: { answers: { q: 'a' } } }),
    ).toEqual({ behavior: 'allow', updatedInput: { answers: { q: 'a' } } });
  });

  it('deny は message をそのまま運ぶ', () => {
    expect(toClaudePermissionResult({ behavior: 'deny', message: '断る' })).toEqual({
      behavior: 'deny',
      message: '断る',
    });
  });
});

function makeSpec(overrides: Partial<AgentManagerSessionSpec> = {}): AgentManagerSessionSpec {
  const noop = async () => ({ continue: true }) as never;
  return {
    input: (async function* (): AsyncGenerator<AgentUserInput> {})(),
    model: 'opus',
    permissionMode: 'auto',
    systemPromptAppend: 'append',
    workerAgentName: 'worker',
    workerPrompt: 'prompt',
    workerModel: 'sonnet',
    cwd: '/tmp',
    env: {},
    managerAutoMemoryEnabled: false,
    sessionLog: { append: async () => undefined, load: async () => null },
    onPermission: async () => ({ behavior: 'allow' }),
    onPreToolUse: noop,
    onPermissionDenied: async () => ({ kind: 'no-retry' }),
    onPostToolUse: noop,
    onPostToolUseFailure: async () => undefined,
    onPreCompact: async () => undefined,
    onUserPromptSubmit: async () => undefined,
    onSubagentStop: noop,
    onStop: async () => undefined,
    ...overrides,
  };
}

function fakeQueryFn(captured: { options?: Options; prompt?: AsyncIterable<unknown> }) {
  const fake = {
    close: vi.fn(),
    [Symbol.asyncIterator]: async function* () {},
  } as unknown as Query;
  const queryFn = ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    captured.options = params.options;
    captured.prompt = params.prompt;
    return fake;
  }) as unknown as typeof sdkQuery;
  return { queryFn, fake };
}

describe('ClaudeManagerDriver#open', () => {
  it('canUseTool は中立の要求（種類・id・道具名・入力）へ写り、決定は PermissionResult へ戻る', async () => {
    const captured: { options?: Options } = {};
    const { queryFn } = fakeQueryFn(captured);
    const onPermission = vi.fn(async () => ({ behavior: 'deny', message: 'no' }) as const);
    new ClaudeManagerDriver({ queryFn }).open(makeSpec({ onPermission }));

    const signal = new AbortController().signal;
    const result = await captured.options!.canUseTool!('Bash', { command: 'ls' }, {
      signal,
      requestId: 'req-1',
      toolUseID: 'tu-1',
    } as never);

    expect(onPermission).toHaveBeenCalledWith({
      requestId: 'req-1',
      kind: 'permission',
      toolName: 'Bash',
      input: { command: 'ls' },
      signal,
    });
    expect(result).toEqual({ behavior: 'deny', message: 'no' });
  });

  it('canUseTool の decisionReason は、中立の要求の reason へ写る（Bash の門の ask の理由。#2884）', async () => {
    const captured: { options?: Options } = {};
    const { queryFn } = fakeQueryFn(captured);
    const onPermission = vi.fn(async () => ({ behavior: 'allow' }) as const);
    new ClaudeManagerDriver({ queryFn }).open(makeSpec({ onPermission }));

    await captured.options!.canUseTool!('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      requestId: 'req-3',
      toolUseID: 'tu-3',
      decisionReason: '待つ形の門',
    } as never);

    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-3', reason: '待つ形の門' }),
    );
  });

  it('requestId が無ければ toolUseID を id にする。AskUserQuestion は question で、答えは updatedInput で返る', async () => {
    const captured: { options?: Options } = {};
    const { queryFn } = fakeQueryFn(captured);
    const onPermission = vi.fn(
      async () => ({ behavior: 'allow', updatedInput: { answers: { q: 'x' } } }) as const,
    );
    new ClaudeManagerDriver({ queryFn }).open(makeSpec({ onPermission }));

    const result = await captured.options!.canUseTool!('AskUserQuestion', { questions: [] }, {
      signal: new AbortController().signal,
      toolUseID: 'tu-2',
    } as never);

    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'tu-2', kind: 'question', toolName: 'AskUserQuestion' }),
    );
    expect(result).toEqual({ behavior: 'allow', updatedInput: { answers: { q: 'x' } } });
  });

  it('spawnProcess が無ければ spawnClaudeCodeProcess を渡さない', () => {
    const captured: { options?: Options } = {};
    const { queryFn } = fakeQueryFn(captured);
    new ClaudeManagerDriver({ queryFn }).open(makeSpec());
    expect('spawnClaudeCodeProcess' in captured.options!).toBe(false);

    const withSpawn: { options?: Options } = {};
    new ClaudeManagerDriver({ queryFn: fakeQueryFn(withSpawn).queryFn }).open(
      makeSpec({ spawnProcess: () => ({}) as never }),
    );
    expect(typeof withSpawn.options!.spawnClaudeCodeProcess).toBe('function');
  });

  it('入力は SDK のユーザーメッセージへ、生ログは SessionStore へ写る', async () => {
    const captured: { options?: Options; prompt?: AsyncIterable<unknown> } = {};
    const { queryFn } = fakeQueryFn(captured);
    const append = vi.fn(async () => undefined);
    const load = vi.fn(async () => [{ type: 'user' }]);
    new ClaudeManagerDriver({ queryFn }).open(
      makeSpec({
        input: (async function* () {
          yield { text: 'こんにちは' };
        })(),
        sessionLog: { append, load },
      }),
    );

    const sent: unknown[] = [];
    for await (const message of captured.prompt!) sent.push(message);
    expect(sent).toEqual([
      { type: 'user', message: { role: 'user', content: 'こんにちは' }, parent_tool_use_id: null },
    ]);

    const store = captured.options!.sessionStore!;
    await store.append({ projectKey: 'p', sessionId: 's' }, [{ type: 'user' }]);
    expect(append).toHaveBeenCalledWith({ projectKey: 'p', sessionId: 's' }, [{ type: 'user' }]);
    await expect(store.load!({ projectKey: 'p', sessionId: 's', subpath: 'x' })).resolves.toEqual([
      { type: 'user' },
    ]);
    expect(load).toHaveBeenCalledWith({ projectKey: 'p', sessionId: 's', subpath: 'x' });
  });

  it('close は query の close へ届く', () => {
    const captured: { options?: Options } = {};
    const { queryFn, fake } = fakeQueryFn(captured);
    new ClaudeManagerDriver({ queryFn }).open(makeSpec()).close();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
