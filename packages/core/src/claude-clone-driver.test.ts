import type { Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AgentCloneSessionSpec } from './agent-clone-session.js';
import { ClaudeCloneDriver, toClaudeMcpServerConfig } from './claude-clone-driver.js';

function makeSpec(overrides: Partial<AgentCloneSessionSpec> = {}): AgentCloneSessionSpec {
  const noop = async () => ({ continue: true }) as never;
  return {
    resume: null,
    input: (async function* () {})(),
    model: 'opus',
    permissionMode: 'auto',
    tools: { kind: 'inproc', server: { type: 'sdk', name: 'alteroid', instance: {} } },
    externalMcpServers: {},
    systemPrompt: 'sp',
    env: {},
    onPreToolUse: noop,
    onPreCompact: async () => undefined,
    onPostToolUse: async () => undefined,
    onPostToolUseFailure: async () => undefined,
    onSubagentStop: async () => undefined,
    ...overrides,
  };
}

function fakeQueryFn(
  captured: { options?: Options; prompt?: unknown },
  messages: unknown[] = [],
  extra: Record<string, unknown> = {},
) {
  const fake = {
    close: vi.fn(),
    interrupt: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => ({ totalTokens: 1 })),
    [Symbol.asyncIterator]: async function* () {
      yield* messages;
    },
    ...extra,
  } as unknown as Query;
  const queryFn = ((params: { prompt: unknown; options?: Options }) => {
    captured.options = params.options;
    captured.prompt = params.prompt;
    return fake;
  }) as unknown as typeof sdkQuery;
  return { queryFn, fake };
}

describe('toClaudeMcpServerConfig（中立の道具 → SDK の McpServerConfig）', () => {
  it('inproc は持ち手をそのまま返す（作り直さない）', () => {
    const server = { type: 'sdk', name: 'alteroid', instance: {} };
    expect(toClaudeMcpServerConfig({ kind: 'inproc', server })).toBe(server);
  });
});

describe('ClaudeCloneDriver#open', () => {
  it('入力は SDK のユーザーメッセージへ写り、SessionStore は包み直さずそのまま渡る', async () => {
    const captured: { options?: Options; prompt?: unknown } = {};
    const { queryFn } = fakeQueryFn(captured);
    const store = { append: vi.fn(async () => undefined), load: vi.fn(async () => null) };
    new ClaudeCloneDriver({ queryFn }).open(
      makeSpec({
        sessionLog: store,
        input: (async function* () {
          yield { text: 'こんにちは' };
        })(),
      }),
    );
    expect(captured.options?.sessionStore).toBe(store);
    const sent: unknown[] = [];
    for await (const message of captured.prompt as AsyncIterable<unknown>) sent.push(message);
    expect(sent).toEqual([
      { type: 'user', message: { role: 'user', content: 'こんにちは' }, parent_tool_use_id: null },
    ]);
  });

  it('画像つきの入力は text + image(base64) ブロックの配列になり、画像が無ければ文字列のまま', async () => {
    const captured: { options?: Options; prompt?: unknown } = {};
    const { queryFn } = fakeQueryFn(captured);
    new ClaudeCloneDriver({ queryFn }).open(
      makeSpec({
        input: (async function* () {
          yield { text: '見て', images: [{ mediaType: 'image/png' as const, data: 'QUJD' }] };
          yield { text: '画像なし', images: [] };
        })(),
      }),
    );
    const sent: unknown[] = [];
    for await (const message of captured.prompt as AsyncIterable<unknown>) sent.push(message);
    expect(sent).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '見て' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          ],
        },
        parent_tool_use_id: null,
      },
      { type: 'user', message: { role: 'user', content: '画像なし' }, parent_tool_use_id: null },
    ]);
  });

  it('sessionLog・cwd が無ければ Options へ欄ごと載せない', () => {
    const captured: { options?: Options } = {};
    new ClaudeCloneDriver({ queryFn: fakeQueryFn(captured).queryFn }).open(makeSpec());
    expect('sessionStore' in captured.options!).toBe(false);
    expect('cwd' in captured.options!).toBe(false);
  });

  it('interrupt / close / contextUsage は Query へそのまま届く', async () => {
    const captured: { options?: Options } = {};
    const { queryFn, fake } = fakeQueryFn(captured);
    const session = new ClaudeCloneDriver({ queryFn }).open(makeSpec());
    await session.interrupt();
    session.close();
    expect(await session.contextUsage()).toEqual({ totalTokens: 1 });
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('sessionModelUsage は readSessionUsage を通る（口が無ければ undefined）', async () => {
    const { queryFn } = fakeQueryFn({});
    const session = new ClaudeCloneDriver({ queryFn }).open(makeSpec());
    expect(await session.sessionModelUsage()).toBeUndefined();
  });

  it('readEvents は SDK のメッセージを中立イベントへ畳み、onEvent が返るのを待つ', async () => {
    const { queryFn } = fakeQueryFn({}, [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'u',
        model: 'm',
        claude_code_version: '1',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [],
      },
    ]);
    const session = new ClaudeCloneDriver({ queryFn }).open(makeSpec());
    const seen: string[] = [];
    await session.readEvents(async (event) => {
      seen.push(event.type);
    });
    expect(seen).toContain('session_started');
  });
});

describe('ClaudeCloneDriver: 人間の MCP 登録は argv ではなくファイルで渡る', () => {
  const external = {
    human: { type: 'stdio', command: 'x', env: { TOKEN: 'dummy-secret-env' } },
    remote: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: { A: 'dummy-secret-hdr' },
    },
  } as never;

  function configPathOf(options: Options | undefined): string {
    return (options?.extraArgs as Record<string, string>)['mcp-config']!;
  }

  it('open: mcpServers はインプロセスだけで、mcp-config のファイルに人間の登録が入り、close で消える', () => {
    const captured: { options?: Options } = {};
    const session = new ClaudeCloneDriver({ queryFn: fakeQueryFn(captured).queryFn }).open(
      makeSpec({ externalMcpServers: external }),
    );
    expect(Object.keys(captured.options!.mcpServers!)).toEqual(['alteroid']);
    const path = configPathOf(captured.options);
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers).toEqual(external);
    session.close();
    expect(existsSync(dirname(path))).toBe(false);
    session.close();
  });

  it('open: readEvents が終わったら消え、投げても消える', async () => {
    const captured: { options?: Options } = {};
    const ok = new ClaudeCloneDriver({ queryFn: fakeQueryFn(captured).queryFn }).open(
      makeSpec({ externalMcpServers: external }),
    );
    const okPath = configPathOf(captured.options);
    expect(existsSync(okPath)).toBe(true);
    await ok.readEvents(async () => undefined);
    expect(existsSync(dirname(okPath))).toBe(false);

    const failing = new ClaudeCloneDriver({
      queryFn: fakeQueryFn(captured, [], {
        [Symbol.asyncIterator]: async function* () {
          yield* [];
          throw new Error('boom');
        },
      }).queryFn,
    }).open(makeSpec({ externalMcpServers: external }));
    const failPath = configPathOf(captured.options);
    await expect(failing.readEvents(async () => undefined)).rejects.toThrow('boom');
    expect(existsSync(dirname(failPath))).toBe(false);
  });

  it('open: query() が同期で投げたらその場で消す', () => {
    let path = '';
    const queryFn = ((params: { options?: Options }) => {
      path = configPathOf(params.options);
      throw new Error('sync boom');
    }) as unknown as typeof sdkQuery;
    expect(() =>
      new ClaudeCloneDriver({ queryFn }).open(makeSpec({ externalMcpServers: external })),
    ).toThrow('sync boom');
    expect(path).not.toBe('');
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('open: 全部インプロセスなら extraArgs を足さずファイルも作らない', () => {
    const captured: { options?: Options } = {};
    new ClaudeCloneDriver({ queryFn: fakeQueryFn(captured).queryFn }).open(makeSpec());
    expect('extraArgs' in captured.options!).toBe(false);
  });

  it('distill: 最後まで回すと消え、途中で return しても消える', async () => {
    const spec = {
      prompt: 'p',
      model: 'opus',
      permissionMode: 'auto' as const,
      tools: { kind: 'inproc' as const, server: { type: 'sdk', name: 'alteroid', instance: {} } },
      externalMcpServers: external,
      systemPrompt: 'sp',
      env: {},
      onPostToolUse: async () => undefined,
      onPostToolUseFailure: async () => undefined,
    };
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: 's',
      uuid: 'u',
      model: 'm',
      claude_code_version: '1',
      apiKeySource: 'user',
      permissionMode: 'default',
      mcp_servers: [],
    };
    const captured: { options?: Options } = {};
    const full = new ClaudeCloneDriver({
      queryFn: fakeQueryFn(captured, [init, init]).queryFn,
    }).distill(spec);
    const fullPath = configPathOf(captured.options);
    expect(Object.keys(captured.options!.mcpServers!)).toEqual(['alteroid']);
    expect(existsSync(fullPath)).toBe(true);
    for await (const event of full) void event;
    expect(existsSync(dirname(fullPath))).toBe(false);

    const early = new ClaudeCloneDriver({
      queryFn: fakeQueryFn(captured, [init, init]).queryFn,
    }).distill(spec);
    const earlyPath = configPathOf(captured.options);
    for await (const event of early) {
      void event;
      break;
    }
    expect(existsSync(dirname(earlyPath))).toBe(false);
  });
});

describe('ClaudeCloneDriver#distill', () => {
  it('呼んだ時点で query() を起こし、文字列のプロンプトと蒸留用の Options を渡す', () => {
    const captured: { options?: Options; prompt?: unknown } = {};
    const driver = new ClaudeCloneDriver({ queryFn: fakeQueryFn(captured).queryFn });
    void driver.distill({
      prompt: 'p',
      model: 'opus',
      permissionMode: 'auto',
      tools: { kind: 'inproc', server: { type: 'sdk', name: 'alteroid', instance: {} } },
      externalMcpServers: {},
      systemPrompt: 'sp',
      env: {},
      onPostToolUse: async () => undefined,
      onPostToolUseFailure: async () => undefined,
    });
    expect(captured.prompt).toBe('p');
    expect(captured.options?.systemPrompt).toBe('sp');
  });
});
