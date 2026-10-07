import { chmod, lstat, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, makeTempDirSync } from '../../../vitest.tmpdir.js';

import { cloneMcpServers } from './claude-provider.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-child.js';
import { buildCloneToolRelayChildDistForTesting } from './clone-tool-relay-child-build.test-support.js';
import { CLONE_TOOLS_TRANSPORT_ENV_KEY } from './clone-tools-transport.js';
import { ALWAYS_REDELIVER, CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import {
  MANAGER_AUTO_MEMORY_ENV_KEY,
  MANAGER_MODEL,
  MANAGER_MODEL_ENV_KEY,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WORKER_MODEL_ENV_KEY,
  createRunnerHost,
  type RunnerHost,
} from './runner.js';
import { CLONE_ALLOWED_TOOLS, CLONE_TOOL_NAMES, MCP_SERVER_NAME } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';

// vi.hoisted にする: vi.mock が hoist されるので、素の const だとファクトリ実行時に TDZ で例外になるため
const relayChildEntryDist = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('./clone-tools-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clone-tools-transport.js')>();
  return {
    ...actual,
    resolveCloneToolRelayChildEntry: () => {
      if (relayChildEntryDist.path === undefined) {
        throw new Error(
          'clone-tool-relay-child-build.test-support.ts の build がまだ終わっていない' +
            '（beforeAll の完了前に呼ばれた）',
        );
      }
      return relayChildEntryDist.path;
    },
  };
});

function fakeCloneSdk(): { fn: typeof sdkQuery; calls: { options: Options }[] } {
  const calls: { options: Options }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    calls.push({ options: params.options ?? {} });

    function* turn(): Generator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'わかった' }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'わかった',
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      } as unknown as SDKMessage;
    }

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      const { prompt } = params;
      if (typeof prompt === 'string') {
        yield* turn();
        return;
      }

      for await (const message of prompt as AsyncIterable<unknown>) {
        void message;
        yield* turn();
      }
    }

    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

describe('クローン本セッションへ渡す Options', () => {
  beforeAll(async () => {
    relayChildEntryDist.path = await buildCloneToolRelayChildDistForTesting(
      'agent-session-options-relay-child-dist-',
    );
  }, 60_000);

  it('既定のモデル帯・道具の配置・許可モードを固定する', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const { options } = calls[0] as { options: Options };

    expect(options.model).toBe('opus');
    expect(options.allowedTools).toEqual(CLONE_ALLOWED_TOOLS);
    expect(options.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.includePartialMessages).toBe(true);

    expect(options.hooks?.PreCompact).toHaveLength(1);
    expect(options.hooks?.PreCompact?.[0]?.timeout).toBe(120);
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    expect(options.hooks?.PostToolUseFailure).toHaveLength(1);

    expect(options.tools).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
    expect(options.resume).toBeUndefined();
    expect(options.settings).toBeUndefined();

    await clone.stop();
  });

  it('ALTEROID_CLONE_MODEL を置くとモデル帯が差し替わる', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: { [CLONE_MODEL_ENV_KEY]: 'opus' },
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    expect((calls[0] as { options: Options }).options.model).toBe('opus');

    await clone.stop();
  });

  it('ALTEROID_CLONE_TOOLS_TRANSPORT 未設定・空・空白は、今日どおり type: sdk のまま（既定固定）', async () => {
    for (const value of [undefined, '', '   ']) {
      const { fn, calls } = fakeCloneSdk();
      const stores = createMemoryStores();
      const clone = createClone({
        stores,
        queryFn: fn,
        env: value === undefined ? {} : { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: value },
        redeliveryGate: ALWAYS_REDELIVER,
      });

      clone.post(humanMessage('やあ'));
      await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

      const mcpServers = (calls[0] as { options: Options }).options.mcpServers ?? {};
      expect(Object.keys(mcpServers)).toEqual([MCP_SERVER_NAME]);
      const own = mcpServers[MCP_SERVER_NAME] as { type?: string; alwaysLoad?: boolean };
      expect(own.type).toBe('sdk');
      expect(own.alwaysLoad).toBeUndefined();

      await clone.stop();
    }
  });

  it('ALTEROID_CLONE_TOOLS_TRANSPORT=stdio のとき、鍵は同じ1本のまま type: stdio へ切り替わる', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const socketDir = makeTempDirSync('clone-tool-relay-wire-');
    const clone = createClone({
      stores,
      queryFn: fn,
      env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stdio' },
      cloneToolRelaySocketDir: socketDir,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const mcpServers = (calls[0] as { options: Options }).options.mcpServers ?? {};
    expect(Object.keys(mcpServers)).toEqual([MCP_SERVER_NAME]);
    const own = mcpServers[MCP_SERVER_NAME] as {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    };
    expect(own.type).toBe('stdio');
    expect(own.command).toBe(process.execPath);
    expect(own.args).toHaveLength(1);
    expect(own.args?.[0]).toMatch(/clone-tool-relay-child\.js$/);
    expect(Object.keys(own.env ?? {}).sort()).toEqual(
      [CLONE_TOOL_RELAY_SOCKET_ENV, CLONE_TOOL_RELAY_TOKEN_ENV].sort(),
    );
    expect(own.alwaysLoad).toBeUndefined();

    await clone.stop();
  });

  it('ALTEROID_CLONE_TOOLS_TRANSPORT に未知の値を置くと、黙って倒さずに構築そのものを止める', () => {
    const { fn } = fakeCloneSdk();
    const stores = createMemoryStores();
    expect(() =>
      createClone({
        stores,
        queryFn: fn,
        env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stido' },
        redeliveryGate: ALWAYS_REDELIVER,
      }),
    ).toThrow(/ALTEROID_CLONE_TOOLS_TRANSPORT/);
  });

  it(
    'stdio モードでも clone.ts の配線を通して本物の createCloneMcpServer へ ' +
      'tools/list が CLONE_TOOL_NAMES の全本数（52本）届く（実際に子プロセスを spawn する）',
    async () => {
      const { fn, calls } = fakeCloneSdk();
      const stores = createMemoryStores();
      const socketDir = makeTempDirSync('clone-tool-relay-wire-e2e-');
      const clone = createClone({
        stores,
        queryFn: fn,
        env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stdio' },
        cloneToolRelaySocketDir: socketDir,
        redeliveryGate: ALWAYS_REDELIVER,
      });

      clone.post(humanMessage('やあ'));
      await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

      const own = ((calls[0] as { options: Options }).options.mcpServers ?? {})[
        MCP_SERVER_NAME
      ] as { command: string; args: string[]; env: Record<string, string> };

      const transport = new StdioClientTransport({
        command: own.command,
        args: own.args,
        env: own.env,
      });
      const client = new Client({ name: 'agent-session-options.test', version: '0' });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());
      } finally {
        await client.close();
      }

      await clone.stop();
    },
    20_000,
  );
});

interface Started {
  options: Options;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

describe('マネージャー（runner）へ渡す Options', () => {
  let dir: string;
  let host: RunnerHost | undefined;

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-agent-session-options-');
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
  });

  it('既定のモデル帯・道具の配置・許可モードを固定する', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.model).toBe('opus');
    expect(MANAGER_MODEL).toBe('opus');
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(typeof (options.systemPrompt as { append?: unknown }).append).toBe('string');

    const agentKeys = Object.keys(options.agents ?? {});
    expect(agentKeys).toEqual([WORKER_AGENT_NAME]);
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { model?: unknown };
    expect(worker.model).toBe('sonnet');
    expect(WORKER_MODEL).toBe('sonnet');
    expect(Object.hasOwn(worker, 'tools')).toBe(false);

    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(typeof options.canUseTool).toBe('function');
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    expect(options.hooks?.PreCompact).toHaveLength(1);
    expect(options.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(options.hooks?.SubagentStop).toHaveLength(1);
    expect(typeof options.hooks?.SubagentStop?.[0]?.hooks?.[0]).toBe('function');
    expect(options.sessionStore).toBeDefined();
    expect(options.spawnClaudeCodeProcess).toBeUndefined();

    expect(options.tools).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();

    expect(options.settings).toEqual({ autoMemoryEnabled: false });
  });

  it('ALTEROID_MANAGER_AUTO_MEMORY=true を置くと settings を渡さない（SDK の既定へ委ねる。#1189）', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: { [MANAGER_AUTO_MEMORY_ENV_KEY]: 'true' },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.settings).toBeUndefined();
  });

  it('ALTEROID_MANAGER_AUTO_MEMORY に true/false 以外を置くと落ちる（不正な値を黙って既定へ倒さない）', async () => {
    const { fn } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: { [MANAGER_AUTO_MEMORY_ENV_KEY]: 'yes' },
    });

    await expect(host.start({ managerId: 'mgr-1', request: '走る', cwd: dir })).rejects.toThrow(
      MANAGER_AUTO_MEMORY_ENV_KEY,
    );
  });

  it('systemPrompt.append と agents[WORKER_AGENT_NAME].prompt は、ビルダー関数の戻り値そのものである（#357 の残り1点）', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    const expectedManagerAppend = buildManagerSystemPrompt({
      managerId: 'mgr-1',
      workerName: WORKER_AGENT_NAME,
    });
    expect((options.systemPrompt as { append?: unknown }).append).toBe(expectedManagerAppend);

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { prompt?: unknown };
    expect(worker.prompt).toBe(buildWorkerPrompt());
  });

  it('ALTEROID_MANAGER_MODEL / ALTEROID_WORKER_MODEL を置くと差し替わる', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {
        [MANAGER_MODEL_ENV_KEY]: 'sonnet',
        [WORKER_MODEL_ENV_KEY]: 'opus',
      },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.model).toBe('sonnet');
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { model?: unknown };
    expect(worker.model).toBe('opus');
  });

  it('childUser を渡すと spawnClaudeCodeProcess が関数として渡る', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
      childUser: { uid: 12345, gid: 12345 },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});

describe('クローンの蒸留サイドクエリへ渡す Options', () => {
  async function firePreCompact(main: { options: Options }): Promise<void> {
    const dir = await makeTempDir('alteroid-agent-session-options-distill-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('persistSession: false、PostToolUse はあるが PreCompact は無い', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    await firePreCompact(calls[0] as { options: Options });
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);

    const { options } = calls[1] as { options: Options };

    expect(options.persistSession).toBe(false);
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    expect(options.hooks?.PostToolUseFailure).toHaveLength(1);
    expect(options.hooks?.PreCompact).toBeUndefined();
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.settings).toBeUndefined();

    await clone.stop();
  });
});

describe('人間の MCP 連携の登録をクローンへ渡す（#325 段2）', () => {
  async function firePreCompact(main: { options: Options }): Promise<void> {
    const dir = await makeTempDir('alteroid-agent-session-options-mcp-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('本セッションと蒸留の両方に、自作と並べて渡る（蒸留は起こすたびに読み直す）', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.mcpServers.write({
      github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } },
    });
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const main = calls[0] as { options: Options };
    expect(Object.keys(main.options.mcpServers ?? {}).sort()).toEqual(
      ['github', MCP_SERVER_NAME].sort(),
    );
    expect(main.options.mcpServers?.github).toEqual({ command: 'gh-mcp', env: { TOKEN: 'dummy' } });
    expect(main.options.mcpServers?.[MCP_SERVER_NAME]?.type).toBe('sdk');

    await stores.mcpServers.write({
      github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    await firePreCompact(main);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);
    const distill = calls[1] as { options: Options };
    expect(Object.keys(distill.options.mcpServers ?? {}).sort()).toEqual(
      ['github', MCP_SERVER_NAME, 'remote'].sort(),
    );
    expect(distill.options.mcpServers?.[MCP_SERVER_NAME]?.type).toBe('sdk');

    await clone.stop();
  });

  it('自作と同じ名前の登録が器に紛れ込んでも、自作が勝つ', async () => {
    const own = { type: 'sdk', name: MCP_SERVER_NAME, instance: {} } as never;
    const merged = cloneMcpServers(own, {
      [MCP_SERVER_NAME]: { command: 'impostor' },
      other: { command: 'x' },
    });
    expect(merged[MCP_SERVER_NAME]).toBe(own);
    expect(Object.keys(merged).sort()).toEqual([MCP_SERVER_NAME, 'other'].sort());
    expect(cloneMcpServers(own, undefined)).toEqual({ [MCP_SERVER_NAME]: own });
  });

  it('登録が読めなくてもセッションは起き、そのことを日誌に残す', async () => {
    const { fn, calls } = fakeCloneSdk();
    const base = createMemoryStores();
    const stores = {
      ...base,
      mcpServers: {
        read: async () => {
          throw new Error('MCP サーバの登録の形が不正: alteroid: 使えない');
        },
        write: base.mcpServers.write.bind(base.mcpServers),
      },
    };
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const { options } = calls[0] as { options: Options };
    expect(Object.keys(options.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    const entries = await base.journal.list({ types: ['exchange'] });
    expect(
      entries.some(
        (entry) =>
          entry.type === 'exchange' && entry.text.includes('MCP サーバの登録が読めなかった'),
      ),
    ).toBe(true);

    await clone.stop();
  });
});

describe('人間の MCP 連携の登録をマネージャーへ渡す（#325 段3）', () => {
  let dir: string;
  let host: RunnerHost | undefined;

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-agent-session-options-mcp3-');
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
  });

  const REGISTRATION = {
    github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'dummy' } },
    remote: { type: 'http' as const, url: 'https://example.invalid/mcp' },
  };

  function makeHost() {
    const sdk = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: sdk.fn,
      env: {},
    });
    return { host, started: sdk.started };
  }

  it('置いた登録がマネージャーの mcpServers に載り、作業者の定義には書かない', async () => {
    const { host, started } = makeHost();
    const placed = host.setMcpServers(REGISTRATION);
    expect(placed?.names).toEqual(['github', 'remote']);

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.mcpServers).toEqual(REGISTRATION);
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as Record<string, unknown>;
    expect(Object.hasOwn(worker, 'mcpServers')).toBe(false);
    expect(Object.hasOwn(worker, 'tools')).toBe(false);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('置いていなければ mcpServers の欄そのものが無い（段3 以前の Options と同じ）', async () => {
    const { host, started } = makeHost();
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    expect(Object.hasOwn((started[0] as Started).options, 'mcpServers')).toBe(false);

    host.setMcpServers(REGISTRATION);
    host.setMcpServers({});
    expect(host.mcpServers()).toBeUndefined();
    await host.start({ managerId: 'mgr-2', request: '走る', cwd: dir });
    expect(Object.hasOwn((started[1] as Started).options, 'mcpServers')).toBe(false);
  });

  it('走っているセッションには届かず、次に開くセッションから効く', async () => {
    const { host, started } = makeHost();
    await host.start({ managerId: 'mgr-1', request: '先に走る', cwd: dir });

    host.setMcpServers(REGISTRATION);
    await host.start({ managerId: 'mgr-2', request: '後から走る', cwd: dir });

    expect(Object.hasOwn((started[0] as Started).options, 'mcpServers')).toBe(false);
    expect((started[1] as Started).options.mcpServers).toEqual(REGISTRATION);
  });

  it('形が不正なら投げ、前の登録が残る（文言に値を載せない）', () => {
    const { host } = makeHost();
    const before = host.setMcpServers(REGISTRATION);

    let message = '';
    try {
      host.setMcpServers({ bad: { command: 'x', enviroment: { K: 'SECRET-TYPO' } } });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('MCP サーバの登録の形が不正');
    expect(message).not.toContain('SECRET');
    expect(host.mcpServers()).toEqual(before);

    expect(() => host.setMcpServers({ [MCP_SERVER_NAME]: { command: 'x' } })).toThrow();
  });

  it('指紋はキーの順序に依らない（pg の jsonb が並べ替えても「届いていない」に見えない）', () => {
    const { host } = makeHost();
    const a = host.setMcpServers({
      github: { command: 'gh-mcp', env: { B: '2', A: '1' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    const b = host.setMcpServers({
      remote: { url: 'https://example.invalid/mcp', type: 'http' },
      github: { env: { A: '1', B: '2' }, command: 'gh-mcp' },
    });
    expect(a?.sha256).toBe(b?.sha256);
    const c = host.setMcpServers({
      github: { command: 'gh-mcp', env: { A: '1', B: '3' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    expect(c?.sha256).not.toBe(a?.sha256);
    expect(JSON.stringify(c)).not.toContain('gh-mcp');
  });
});

// ---------------------------------------------------------------------------
// 記憶ストアの plugin をクローンへ渡す
// ---------------------------------------------------------------------------

describe('記憶ストアの plugin をクローンへ渡す', () => {
  const SHA = 'a'.repeat(40);
  const encoder = new TextEncoder();
  const MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0', description: 'dummy-content' });

  function pluginInput(name: string, extra: Record<string, unknown> = {}, withHooks = false) {
    return {
      name,
      source: { kind: 'url' as const, url: 'https://example.invalid/repo', sha: SHA },
      files: [
        {
          path: '.claude-plugin/plugin.json',
          executable: false,
          content: encoder.encode(MANIFEST),
        },
        {
          path: 'skills/one/SKILL.md',
          executable: false,
          content: encoder.encode('---\nname: one\ndescription: dummy-content\n---\n# body\n'),
        },
        ...(withHooks
          ? [{ path: 'hooks/hooks.json', executable: false, content: encoder.encode('{}') }]
          : []),
      ],
      installedAt: '2026-10-07T00:00:00.000Z',
      installedBy: 'account-1',
      ...extra,
    };
  }

  /** 展開先は読み取り専用（0o555）なので、掃除が消せるように書込み可へ戻す。 */
  async function makeWritable(dir: string): Promise<void> {
    const info = await lstat(dir).catch(() => null);
    if (info === null || !info.isDirectory()) return;
    await chmod(dir, 0o700);
    for (const name of await readdir(dir)) await makeWritable(join(dir, name));
  }
  const roots: string[] = [];
  async function newRoot(prefix: string): Promise<string> {
    const root = await makeTempDir(prefix);
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    for (const root of roots.splice(0)) await makeWritable(root);
  });

  async function firePreCompact(main: { options: Options }, root: string): Promise<void> {
    const transcriptPath = join(root, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  async function exchangeTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
    const entries = await stores.journal.list({ types: ['exchange'] });
    return entries.flatMap((entry) => (entry.type === 'exchange' ? [entry.text] : []));
  }

  it('本セッションと蒸留の options.plugins に展開先と skipMcpDiscovery が載り、scope runner は載らない', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('all-one'));
    await stores.plugins.put(pluginInput('app-one', { scope: 'app', enableMcp: true }));
    await stores.plugins.put(pluginInput('runner-one', { scope: 'runner' }));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const main = calls[0] as { options: Options };
    expect(main.options.plugins).toEqual([
      {
        type: 'local',
        path: expect.stringContaining(join(root, 'plugins', `all-one@${SHA}-`)),
        skipMcpDiscovery: true,
      },
      {
        type: 'local',
        path: expect.stringContaining(join(root, 'plugins', `app-one@${SHA}-`)),
        skipMcpDiscovery: false,
      },
    ]);
    expect(JSON.stringify(main.options.plugins)).not.toContain('runner-one');

    await firePreCompact(main, root);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);
    const distill = calls[1] as { options: Options };
    expect(distill.options.plugins).toEqual(main.options.plugins);

    await clone.stop();
  });

  it('plugin が無ければ options.plugins の欄ごと無い', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-none-');
    const { fn, calls } = fakeCloneSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });
    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);
    expect('plugins' in (calls[0] as { options: Options }).options).toBe(false);
    await clone.stop();
  });

  it('ストアが読めなくてもセッションは起き、段だけを日誌に残す（内容は書かない）', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-fail-');
    const { fn, calls } = fakeCloneSdk();
    const base = createMemoryStores();
    const stores = {
      ...base,
      plugins: {
        ...base.plugins,
        list: async () => {
          throw new Error('dummy-reason');
        },
      },
    };
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    expect('plugins' in (calls[0] as { options: Options }).options).toBe(false);
    const texts = await exchangeTexts(base);
    expect(texts.some((text) => text.includes('plugin') && text.includes('list'))).toBe(true);

    await clone.stop();
  });

  it('展開しなかったものを plugin 名・相対 path・理由だけで日誌に残す', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-removed-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('with-hooks', {}, true));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const texts = await exchangeTexts(stores);
    const line = texts.find((text) => text.includes('hooks/hooks.json'));
    expect(line).toBeDefined();
    expect(line).toContain(`with-hooks@${SHA}`);
    expect(line).not.toContain(root);
    expect(line).not.toContain('example.invalid');

    await clone.stop();
  });

  it('展開しなかったものが多くても、理由ごとの件数と先頭20件の path だけを書く', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-many-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const manifest: Record<string, string> = { name: 'many', version: '1.0.0' };
    for (let i = 0; i < 30; i += 1) manifest[`extra-${String(i).padStart(2, '0')}`] = 'dummy';
    await stores.plugins.put(
      pluginInput('many', {
        files: [
          {
            path: '.claude-plugin/plugin.json',
            executable: false,
            content: encoder.encode(JSON.stringify(manifest)),
          },
          { path: 'skills/one/SKILL.md', executable: false, content: encoder.encode('# x\n') },
          { path: 'hooks/hooks.json', executable: false, content: encoder.encode('{}') },
        ],
      }),
    );
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const line = (await exchangeTexts(stores)).find((text) => text.includes('展開しなかったもの'));
    expect(line).toBeDefined();
    expect(line).toContain('not-allowlisted 30件');
    expect(line).toContain('hooks-disabled 1件');
    expect(line).toContain('ほか 11 件');
    expect(line?.match(/many:/g)).toHaveLength(20);

    await clone.stop();
  });

  it('展開しなかったものの path は、制御文字を落として長さを切って書く', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-sanitize-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const manifest = {
      name: 'dirty',
      [`evil\u001b[31m‮key${'a'.repeat(400)}`]: 'dummy',
    };
    await stores.plugins.put(
      pluginInput('dirty', {
        files: [
          {
            path: '.claude-plugin/plugin.json',
            executable: false,
            content: encoder.encode(JSON.stringify(manifest)),
          },
          { path: 'skills/one/SKILL.md', executable: false, content: encoder.encode('# x\n') },
        ],
      }),
    );
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const line = (await exchangeTexts(stores)).find((text) => text.includes('展開しなかったもの'));
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex -- 制御文字が残らないことの検査
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    expect(line).toContain('evil[31mkey');
    expect(line).not.toContain('a'.repeat(300));

    await clone.stop();
  });

  it('同じ一覧は毎セッション書かず、変わったときだけ書く', async () => {
    const root = await newRoot('alteroid-agent-session-options-plugins-digest-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('with-hooks', {}, true));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);
    await firePreCompact(calls[0] as { options: Options }, root);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);

    const count = async () =>
      (await exchangeTexts(stores)).filter((text) => text.includes('hooks/hooks.json')).length;
    expect(await count()).toBe(1);

    await stores.plugins.put(pluginInput('another'));
    await firePreCompact(calls[0] as { options: Options }, root);
    await expect.poll(() => calls.length > 2, { timeout: 3000 }).toBe(true);
    expect((await exchangeTexts(stores)).filter((text) => text.includes('another@')).length).toBe(
      1,
    );

    await clone.stop();
  });
});
