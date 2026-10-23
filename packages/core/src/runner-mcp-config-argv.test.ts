import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createCredentialStore } from './credentials.js';
import type { ManagerToolsSocketHost } from './manager-tools.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { RUNNER_MCP_CONFIG_DIR_PREFIX } from './runner-mcp-config-sweep.js';

const RELAY_TOKEN = 'dummy-secret-relay-token';
const HUMAN_ENV_VALUE = 'dummy-secret-human-env';
const HUMAN_HEADER_VALUE = 'dummy-secret-human-header';

function fakeSdk(sessions: Options[]): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push(params.options ?? {});
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

type Exit = () => void;

function fakeChild(onExit: (listener: Exit) => void): never {
  return {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true,
    on: () => undefined,
    once: (event: string, listener: Exit) => {
      if (event === 'exit') onExit(listener);
    },
    off: () => undefined,
  } as never;
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function start(
  handOverMcpConfigDirFn: (dir: string, uid: number, gid: number) => void,
  sweepIntervalMs?: number,
): Promise<{
  root: string;
  launch: () => string[];
  spawned: string[][];
  exits: Exit[];
  events: RunnerEvent[];
}> {
  const mcpConfigTmpRoot = makeTempDirSync('alteroid-mcp-argv-root-');
  const sessions: Options[] = [];
  const events: RunnerEvent[] = [];
  const spawned: string[][] = [];
  const exits: Exit[] = [];
  const toolsHost: ManagerToolsSocketHost = {
    socketPath: '/run/alteroid/manager/manager.sock',
    register: () => RELAY_TOKEN,
    close: () => undefined,
  };
  const host = createRunnerHost({
    runnerId: 'runner-mcp-argv',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: fakeSdk(sessions),
    env: {},
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-mcp-argv-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-mcp-argv-codex-'),
    outboxStagedRoot: makeTempDirSync('alteroid-mcp-argv-outbox-'),
    rescueStagedRoot: makeTempDirSync('alteroid-mcp-argv-rescue-'),
    managerTools: { host: toolsHost, childEntry: '/app/relay.js' },
    childUser: { uid: 1001, gid: 1002 },
    spawnAgentProcessFn: (options) => {
      spawned.push(options.args);
      return fakeChild((listener) => exits.push(listener));
    },
    handOverResumeConfigDirFn: () => undefined,
    handOverMcpConfigDirFn,
    mcpConfigTmpRoot,
    // 本物の /tmp を scratch の掃きの対象にしない
    ...(sweepIntervalMs === undefined
      ? {}
      : {
          scratchSweep: {
            tmpRoot: makeTempDirSync('alteroid-mcp-argv-scratch-'),
            intervalMs: sweepIntervalMs,
          },
        }),
  });
  hosts.push(host);
  host.setMcpServers({
    human: {
      command: 'human-mcp',
      env: { HUMAN_TOKEN: HUMAN_ENV_VALUE },
    },
    remote: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: HUMAN_HEADER_VALUE },
    },
  });
  await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
  const options = sessions[0] as Options;
  // SDK は mcpServers を JSON にして `--mcp-config` へ載せる（実物の形は mcp-config-arg.test.ts の歯が見ている）
  const sdkArgs = [
    '--print',
    '--mcp-config',
    JSON.stringify({ mcpServers: options.mcpServers }),
    '--verbose',
  ];
  return {
    root: mcpConfigTmpRoot,
    launch: () => {
      void options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: sdkArgs,
        env: {},
        signal: new AbortController().signal,
      });
      return spawned.at(-1) ?? [];
    },
    spawned,
    exits,
    events,
  };
}

describe('Host: 委譲の CLI の argv に MCP の資格を載せない', () => {
  it('資格はどの引数にも現れず、--mcp-config の次は子へ渡した 0600 のファイルで、中身は元の JSON と一致する', async () => {
    const handed: [string, number, number][] = [];
    const { launch } = await start((dir, uid, gid) => handed.push([dir, uid, gid]));
    const args = launch();

    const joined = args.join('\n');
    for (const secret of [RELAY_TOKEN, HUMAN_ENV_VALUE, HUMAN_HEADER_VALUE]) {
      expect(joined).not.toContain(secret);
    }
    expect(args[0]).toBe('--print');
    expect(args[1]).toBe('--mcp-config');
    expect(args[3]).toBe('--verbose');

    const file = args[2] as string;
    const content = readFileSync(file, 'utf8');
    for (const secret of [RELAY_TOKEN, HUMAN_ENV_VALUE, HUMAN_HEADER_VALUE]) {
      expect(content).toContain(secret);
    }
    expect(Object.keys(JSON.parse(content) as object)).toEqual(['mcpServers']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const dir = file.slice(0, file.lastIndexOf('/'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(handed).toEqual([[dir, 1001, 1002]]);
    // CLI の一時ディレクトリ（`alteroid-mcp-`）と名前が重ならない: 接頭辞で掃いても CLI のものを巻き込まないため
    expect(path.basename(dir).startsWith(RUNNER_MCP_CONFIG_DIR_PREFIX)).toBe(true);
    expect(path.basename(dir).startsWith('alteroid-mcp-')).toBe(false);
  });

  it('子が終わるとディレクトリごと消える（終わるまでは残る）', async () => {
    const { launch, exits } = await start(() => undefined);
    const file = launch()[2] as string;
    const dir = file.slice(0, file.lastIndexOf('/'));
    expect(existsSync(dir)).toBe(true);
    for (const listener of exits) listener();
    expect(existsSync(dir)).toBe(false);
  });

  it('周期の掃きは、落ちた runner の古い残骸だけを消す（走っている委譲・若いもの・別の接頭辞は残す）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { launch, exits, root } = await start(() => undefined, 20);
    const live = (launch()[2] as string).replace(/\/[^/]+$/, '');
    const old = new Date(Date.now() - 60 * 60_000);
    const plant = (name: string, mtime: Date | undefined): string => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'mcp-config-1.json'), '{}');
      if (mtime !== undefined) utimesSync(dir, mtime, mtime);
      return dir;
    };
    const stale = plant(`${RUNNER_MCP_CONFIG_DIR_PREFIX}stale`, old);
    const young = plant(`${RUNNER_MCP_CONFIG_DIR_PREFIX}young`, undefined);
    const cli = plant('alteroid-mcp-cli', old);
    // 走っている委譲は古く見えても守る: 生きた集合で外す
    utimesSync(live, old, old);

    await vi.advanceTimersByTimeAsync(20);
    for (let i = 0; i < 5000 && existsSync(stale); i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(cli)).toBe(true);

    for (const listener of exits) listener();
    expect(existsSync(live)).toBe(false);
  });

  it('子へ渡せなければ起動しない（資格を argv へ戻さず、ディレクトリも残さない）', async () => {
    let dirSeen: string | undefined;
    const { launch, spawned, events } = await start((dir) => {
      dirSeen = dir;
      throw new Error('EPERM（テストの偽物）');
    });
    expect(() => launch()).toThrow(/起動しない/);
    expect(spawned).toHaveLength(0);
    expect(dirSeen).toBeDefined();
    expect(existsSync(dirSeen as string)).toBe(false);
    const notes = events.map((event) => (event.type === 'note' ? event.text : ''));
    expect(notes.filter((text) => text.includes('起動しない'))).toEqual([
      expect.stringContaining('EPERM（テストの偽物）'),
    ]);
  });
});
