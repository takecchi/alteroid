import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createCredentialStore } from './credentials.js';
import {
  MANAGER_TOOLS_MCP_SERVER_NAME,
  OUTPUT_RECORD_TOOL_NAME,
  type ManagerToolsSocketHost,
} from './manager-tools.js';
import { buildManagerSystemPrompt } from './prompt.js';
import type { RunnerEvent } from './runner-protocol.js';
import { runnerEventSchema } from './runner-protocol.js';
import { createRunnerHost, type RunnerManagerToolsOptions } from './runner.js';

function capturingQuery(): { fn: typeof sdkQuery; options: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const fn = vi.fn((args: { options: Record<string, unknown> }) => {
    captured = args.options;
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
  return { fn: fn as unknown as typeof sdkQuery, options: () => captured };
}

function capturingToolsHost(): ManagerToolsSocketHost & {
  factory: () => (() => McpServer) | undefined;
  tokens: string[];
  closed: () => number;
} {
  let captured: (() => McpServer) | undefined;
  const tokens: string[] = [];
  let closed = 0;
  return {
    socketPath: '/run/alteroid/manager/manager.sock',
    register: (factory) => {
      captured = factory;
      const token = `tok-${String(tokens.length + 1)}`;
      tokens.push(token);
      return token;
    },
    close: () => {
      closed += 1;
    },
    factory: () => captured,
    tokens,
    closed: () => closed,
  };
}

function hostWith(managerTools?: RunnerManagerToolsOptions): {
  host: ReturnType<typeof createRunnerHost>;
  sdk: ReturnType<typeof capturingQuery>;
  events: RunnerEvent[];
} {
  const sdk = capturingQuery();
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    env: {},
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-runner-manager-tools-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-runner-manager-tools-codex-'),
    ...(managerTools === undefined ? {} : { managerTools }),
  });
  return { host, sdk, events };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientSide);
  return client;
}

const externalOutputs = (
  events: RunnerEvent[],
): Extract<RunnerEvent, { type: 'external_output' }>[] =>
  events.filter(
    (e): e is Extract<RunnerEvent, { type: 'external_output' }> => e.type === 'external_output',
  );

describe('runner: MCP alteroid-manager の output_record（#2987）', () => {
  it('ソケットを渡せば、資格が無くても道具とプロンプトの案内を出す', async () => {
    const tools = capturingToolsHost();
    const { host, sdk } = hostWith({ host: tools, childEntry: '/app/relay.js' });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });

    const servers = sdk.options().mcpServers as Record<string, unknown>;
    expect(servers[MANAGER_TOOLS_MCP_SERVER_NAME]).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: ['/app/relay.js'],
      env: {
        ALTEROID_CLONE_TOOL_RELAY_SOCKET: '/run/alteroid/manager/manager.sock',
        ALTEROID_CLONE_TOOL_RELAY_TOKEN: 'tok-1',
      },
    });
    expect(JSON.stringify(sdk.options())).toContain(OUTPUT_RECORD_TOOL_NAME);
    await host.shutdown();
    expect(tools.closed()).toBe(1);
  });

  it('ソケットが無ければ道具もプロンプトの案内も出さない', async () => {
    const { host, sdk } = hostWith();
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    expect(sdk.options().mcpServers).toBeUndefined();
    expect(JSON.stringify(sdk.options())).not.toContain(OUTPUT_RECORD_TOOL_NAME);
    await host.shutdown();
  });

  it('呼ぶと external_output を1件送り、外へは何も出さない（前後の空白は落とす）', async () => {
    const tools = capturingToolsHost();
    const { host, events } = hostWith({ host: tools, childEntry: '/app/relay.js' });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const client = await connect(tools.factory()!());

    const result = (await client.callTool({
      name: OUTPUT_RECORD_TOOL_NAME,
      arguments: { kind: ' mail ', where: 'to: someone@example.com', summary: '見積もりを送った' },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).not.toBe(true);
    const sent = externalOutputs(events);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'external_output',
      managerId: 'mgr-1',
      output: { kind: 'mail', where: 'to: someone@example.com', summary: '見積もりを送った' },
    });
    // デーモンが受ける形のまま送る（旧い形だとデーモンが落とす）
    expect(runnerEventSchema.safeParse(sent[0]).success).toBe(true);
    expect(Number.isNaN(Date.parse(sent[0]!.output.at))).toBe(false);
    await client.close();
    await host.shutdown();
  });

  it('空の種別・長すぎる場所は断り、何も送らない', async () => {
    const tools = capturingToolsHost();
    const { host, events } = hostWith({ host: tools, childEntry: '/app/relay.js' });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const client = await connect(tools.factory()!());

    for (const args of [
      { kind: '  ', where: 'https://example.com/x' },
      { kind: 'post', where: 'x'.repeat(501) },
    ]) {
      const result = (await client.callTool({
        name: OUTPUT_RECORD_TOOL_NAME,
        arguments: args,
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
    }
    expect(externalOutputs(events)).toEqual([]);
    await client.close();
    await host.shutdown();
  });

  it('プロンプトの案内は manager-tools.ts の名前と一致し、立てなければ1文字も増えない', () => {
    const base = buildManagerSystemPrompt({ managerId: 'mgr-1', workerName: 'worker' });
    const withTools = buildManagerSystemPrompt({
      managerId: 'mgr-1',
      workerName: 'worker',
      managerTools: true,
    });
    expect(withTools).toContain(`\`${MANAGER_TOOLS_MCP_SERVER_NAME}\``);
    expect(withTools).toContain(`\`${OUTPUT_RECORD_TOOL_NAME}\``);
    expect(base).not.toContain(OUTPUT_RECORD_TOOL_NAME);
  });
});
