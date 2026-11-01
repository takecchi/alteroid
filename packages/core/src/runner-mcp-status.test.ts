import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

function fakeSdkWithInit(initExtras: Record<string, unknown>): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
        ...initExtras,
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<unknown>) void message;
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('runner: 外部 MCP サーバの接続の失敗が担当の側で見える', () => {
  it('init が人間の MCP サーバを failed / needs-auth と知らせたら、runner が出すイベントにその名前と状態が載る', async () => {
    const events: RunnerEvent[] = [];
    let onSession: () => void = () => undefined;
    const sessionSeen = new Promise<void>((resolve) => {
      onSession = resolve;
    });
    const host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      emit: (event) => {
        events.push(event);
        if (event.type === 'session') onSession();
      },
      queryFn: fakeSdkWithInit({
        mcp_servers: [
          { name: 'alteroid', status: 'connected' },
          { name: 'ext-github', status: 'failed' },
          { name: 'ext-notion', status: 'needs-auth' },
        ],
      }),
      env: { PATH: '/usr/bin' },
    });
    hosts.push(host);
    host.setMcpServers({ 'ext-github': { type: 'http', url: 'https://example.invalid/mcp' } });
    await host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    await sessionSeen;

    const wire = JSON.stringify(events);
    expect(wire).toContain('ext-github');
    expect(wire).toContain('needs-auth');
  });
});
