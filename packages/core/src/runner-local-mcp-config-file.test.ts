import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createCredentialStore } from './credentials.js';
import type { ManagerToolsSocketHost } from './manager-tools.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

const RELAY_TOKEN = 'dummy-secret-relay-token';
const HUMAN_ENV_VALUE = 'dummy-secret-human-env';
const HUMAN_HEADER_VALUE = 'dummy-secret-human-header';
const SECRETS = [RELAY_TOKEN, HUMAN_ENV_VALUE, HUMAN_HEADER_VALUE];

interface FakeSessions {
  options: Options[];
  // close() を通らずに終わる（CLI が自分で終わった）形を作る
  endNaturally: (index: number) => void;
}

function fakeSdk(sessions: FakeSessions): typeof sdkQuery {
  const ends: (() => void)[] = [];
  sessions.endNaturally = (index) => ends[index]?.();
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.options.push(params.options ?? {});
    let end = (): void => undefined;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    ends.push(end);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      await ended;
    }
    return Object.assign(generate(), {
      close: () => end(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function startHost(withChildUser: boolean): { host: RunnerHost; sessions: FakeSessions } {
  const sessions: FakeSessions = { options: [], endNaturally: () => undefined };
  const toolsHost: ManagerToolsSocketHost = {
    socketPath: '/run/alteroid/manager/manager.sock',
    register: () => RELAY_TOKEN,
    close: () => undefined,
  };
  const host = createRunnerHost({
    runnerId: 'runner-local-mcp',
    workspacePath: '/work',
    emit: () => undefined,
    queryFn: fakeSdk(sessions),
    env: {},
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-local-mcp-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-local-mcp-codex-'),
    outboxStagedRoot: makeTempDirSync('alteroid-local-mcp-outbox-'),
    rescueStagedRoot: makeTempDirSync('alteroid-local-mcp-rescue-'),
    managerTools: { host: toolsHost, childEntry: '/app/relay.js' },
    ...(withChildUser
      ? {
          childUser: { uid: 1001, gid: 1002 },
          spawnAgentProcessFn: () => {
            throw new Error('この試験は起動まで進めない');
          },
          handOverResumeConfigDirFn: () => undefined,
          handOverMcpConfigDirFn: () => undefined,
        }
      : {}),
  });
  hosts.push(host);
  host.setMcpServers({
    human: { command: 'human-mcp', env: { HUMAN_TOKEN: HUMAN_ENV_VALUE } },
    remote: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: HUMAN_HEADER_VALUE },
    },
  });
  return { host, sessions };
}

function mcpConfigPathOf(options: Options): string {
  return (options.extraArgs as Record<string, string>)['mcp-config'] as string;
}

describe('childUser の無い runner: MCP の資格は argv ではなく 0600 のファイルで渡る', () => {
  it('mcpServers にはインプロセスのものしか残らず、mcp-config のファイルに中継のトークンと人間の登録の資格が入る', async () => {
    const { host, sessions } = startHost(false);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const options = sessions.options[0] as Options;

    expect(JSON.stringify(options.mcpServers ?? {})).not.toMatch(/dummy-secret/);
    for (const config of Object.values(options.mcpServers ?? {})) {
      expect(config.type).toBe('sdk');
    }
    const path = mcpConfigPathOf(options);
    const content = readFileSync(path, 'utf8');
    for (const secret of SECRETS) expect(content).toContain(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('stop でファイルが消える', async () => {
    const { host, sessions } = startHost(false);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const path = mcpConfigPathOf(sessions.options[0] as Options);
    expect(existsSync(path)).toBe(true);
    await host.stop('mgr-1');
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('CLI が自分で終わったときも消える', async () => {
    const { host, sessions } = startHost(false);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const path = mcpConfigPathOf(sessions.options[0] as Options);
    sessions.endNaturally(0);
    await host.stop('mgr-1');
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('resume で組み直すたびに新しいファイルになり、前のセッションのファイルは消えている', async () => {
    const { host, sessions } = startHost(false);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const first = mcpConfigPathOf(sessions.options[0] as Options);
    await host.stop('mgr-1', { keepPeers: true });
    expect(existsSync(dirname(first))).toBe(false);

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-fake',
      cwd: '/work',
      request: 'やって',
      message: '続き',
    });
    const second = mcpConfigPathOf(sessions.options[1] as Options);
    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
    await host.stop('mgr-1');
    expect(existsSync(dirname(second))).toBe(false);
  });
});

describe('childUser の有る runner: ファイルへ逃がさない（#5181 の spawnProcess の差し替えのまま）', () => {
  it('extraArgs が付かず、spawnClaudeCodeProcess が渡る', async () => {
    const { host, sessions } = startHost(true);
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const options = sessions.options[0] as Options;
    expect(options.extraArgs).toBeUndefined();
    expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
    expect(JSON.stringify(options.mcpServers)).toContain(HUMAN_ENV_VALUE);
  });
});
