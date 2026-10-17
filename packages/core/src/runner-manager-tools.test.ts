import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { createCredentialStore } from './credentials.js';
import {
  MANAGER_TOOLS_MCP_SERVER_NAME,
  OUTPUT_RECORD_TOOL_NAME,
  REPORT_ATTACH_TOOL_NAME,
  RESCUE_RESTORE_TOOL_NAME,
  type ManagerToolsSocketHost,
} from './manager-tools.js';
import { buildManagerSystemPrompt } from './prompt.js';
import type { RunnerEvent } from './runner-protocol.js';
import { RUNNER_CAPABILITIES, runnerEventSchema } from './runner-protocol.js';
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

function hostWith(
  managerTools?: RunnerManagerToolsOptions,
  extra: Partial<Parameters<typeof createRunnerHost>[0]> = {},
): {
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
    ...extra,
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

  it('rescue_restore: 呼ぶと rescue_restore_request を1件送り、結果に届く先を案内する。能力を名乗る', async () => {
    expect(RUNNER_CAPABILITIES).toContain('rescue-restore');
    const tools = capturingToolsHost();
    const { host, events } = hostWith({ host: tools, childEntry: '/app/relay.js' });
    await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
    const client = await connect(tools.factory()!());

    const result = (await client.callTool({
      name: RESCUE_RESTORE_TOOL_NAME,
      arguments: { paths: ['repo/a.txt'], from: 'mgr-old' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain('/tmp/alteroid-attachments/mgr-1/');

    await client.callTool({ name: RESCUE_RESTORE_TOOL_NAME, arguments: {} });
    const sent = events.filter((e) => e.type === 'rescue_restore_request');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      type: 'rescue_restore_request',
      managerId: 'mgr-1',
      paths: ['repo/a.txt'],
      from: 'mgr-old',
    });
    expect(sent[1]).toEqual({ type: 'rescue_restore_request', managerId: 'mgr-1' });
    expect(runnerEventSchema.safeParse(sent[0]).success).toBe(true);
    await client.close();
    await host.shutdown();
  });

  describe('report_attach（#5018）', () => {
    const appendOf = (options: Record<string, unknown>): string =>
      String((options.systemPrompt as { append?: unknown }).append);
    const toolNames = async (client: Client): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name);

    it('出し箱があれば道具とプロンプトの案内を出し、名指しした作業場のファイルを出し箱へ写す', async () => {
      const outboxRoot = makeTempDirSync('alteroid-attach-outbox-');
      const scratchRoot = makeTempDirSync('alteroid-attach-tmp-');
      const tools = capturingToolsHost();
      const { host, sdk, events } = hostWith(
        { host: tools, childEntry: '/app/relay.js' },
        { outboxRoot, managerScratchRoot: scratchRoot },
      );
      await host.start({ managerId: 'mgr-abcd1234-xyz', request: 'やって', cwd: '/work' });
      const prompt = appendOf(sdk.options());
      expect(prompt).toContain(`\`${REPORT_ATTACH_TOOL_NAME}\``);
      expect(prompt).toContain('`cp` で出し箱へ写さないこと');

      const scratch = join(scratchRoot, 'mgr-abcd1234');
      mkdirSync(scratch);
      writeFileSync(join(scratch, 'out.txt'), 'hello');
      const client = await connect(tools.factory()!());
      expect(await toolNames(client)).toContain(REPORT_ATTACH_TOOL_NAME);

      const result = (await client.callTool({
        name: REPORT_ATTACH_TOOL_NAME,
        arguments: { paths: [join(scratch, 'out.txt'), '/etc/hosts'] },
      })) as { content: { text: string }[]; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain(
        `写した: ${join(scratch, 'out.txt')} → out.txt（5 バイト）`,
      );
      expect(result.content[0]!.text).toContain('断った: /etc/hosts: 作業場の外は写せない');
      expect(readdirSync(join(outboxRoot, 'mgr-abcd1234-xyz'))).toEqual(['out.txt']);
      expect(events.filter((e) => e.type === 'note')).toEqual([]);

      const refused = (await client.callTool({
        name: REPORT_ATTACH_TOOL_NAME,
        arguments: { paths: ['/etc/hosts'] },
      })) as { isError?: boolean };
      expect(refused.isError).toBe(true);
      await client.close();
      await host.shutdown();
    });

    it('出し箱を用意できない構成では、道具も案内も出さず、従来の `cp` の文のまま', async () => {
      const blocker = join(makeTempDirSync('alteroid-attach-blocker-'), 'file');
      writeFileSync(blocker, 'x');
      const tools = capturingToolsHost();
      const { host, sdk } = hostWith(
        { host: tools, childEntry: '/app/relay.js' },
        { outboxRoot: join(blocker, 'outbox') },
      );
      await host.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
      const prompt = appendOf(sdk.options());
      expect(prompt).not.toContain(REPORT_ATTACH_TOOL_NAME);
      expect(prompt).toContain('`$ALTEROID_OUTBOX` の直下へ写すこと');
      const client = await connect(tools.factory()!());
      expect(await toolNames(client)).not.toContain(REPORT_ATTACH_TOOL_NAME);
      await client.close();
      await host.shutdown();
    });

    it('プロンプトの文は reportAttach の有無で切り替わり、立てなければ従来と1文字も変わらない', () => {
      const base = buildManagerSystemPrompt({ managerId: 'mgr-1', workerName: 'worker' });
      const toolsOnly = buildManagerSystemPrompt({
        managerId: 'mgr-1',
        workerName: 'worker',
        managerTools: true,
      });
      const withAttach = buildManagerSystemPrompt({
        managerId: 'mgr-1',
        workerName: 'worker',
        managerTools: true,
        reportAttach: true,
      });
      expect(base).toContain('`$ALTEROID_OUTBOX` の直下へ写すこと');
      expect(toolsOnly).toContain('`$ALTEROID_OUTBOX` の直下へ写すこと');
      expect(toolsOnly).not.toContain(REPORT_ATTACH_TOOL_NAME);
      expect(withAttach).toContain(`\`${REPORT_ATTACH_TOOL_NAME}\``);
      expect(withAttach).not.toContain('`$ALTEROID_OUTBOX` の直下へ写すこと');
    });
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
