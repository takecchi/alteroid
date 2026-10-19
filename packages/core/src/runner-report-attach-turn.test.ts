import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { REPORT_ATTACH_TOOL_NAME, type ManagerToolsSocketHost } from './manager-tools.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

function capturingToolsHost(): ManagerToolsSocketHost & { factory: () => () => McpServer } {
  let captured: (() => McpServer) | undefined;
  return {
    socketPath: '/run/alteroid/manager/manager.sock',
    register: (factory) => {
      captured = factory;
      return 'tok-1';
    },
    close: () => undefined,
    factory: () => {
      if (captured === undefined) throw new Error('道具が登録されていない');
      return captured;
    },
  };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientSide);
  return client;
}

// ターンの途中で `onTurn`（担当が道具を呼ぶ）を走らせてから結果を出す
function fakeSdk(onTurn: () => Promise<void>): typeof sdkQuery {
  return ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-attach',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      let n = 0;
      for await (const message of params.prompt) {
        void message;
        await onTurn();
        n += 1;
        yield {
          type: 'result',
          subtype: 'success',
          result: '絵を添えた',
          session_id: 'sess-attach',
          uuid: `uuid-result-${String(n)}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
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

describe('report_attach で写したファイルが、そのターンの報告に載る', () => {
  it('⭐ 道具の口で出し箱へ写したファイルは、ターン終わりに取り込まれて報告の files に載り、出し箱から消える', async () => {
    const managerId = 'mgr-abcd1234-attach';
    const outboxRoot = await makeTempDir('runner-attach-turn-outbox-');
    const outboxStagedRoot = await makeTempDir('runner-attach-turn-staged-');
    const scratchRoot = await makeTempDir('runner-attach-turn-tmp-');
    const scratch = join(scratchRoot, 'mgr-abcd1234');
    await mkdir(scratch);
    await writeFile(join(scratch, 'astra.png'), '絵');
    const tools = capturingToolsHost();
    const events: RunnerEvent[] = [];
    const attachTexts: string[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-attach-turn',
      workspacePath: '/workspace',
      emit: (event) => events.push(event),
      queryFn: fakeSdk(async () => {
        const client = await connect(tools.factory()());
        const result = (await client.callTool({
          name: REPORT_ATTACH_TOOL_NAME,
          arguments: { paths: [join(scratch, 'astra.png')] },
        })) as { content: { text: string }[] };
        attachTexts.push(result.content[0]!.text);
        await client.close();
      }),
      env: { PATH: '/usr/bin' },
      managerTools: { host: tools, childEntry: '/app/relay.js' },
      outboxRoot,
      outboxStagedRoot,
      managerScratchRoot: scratchRoot,
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);
    await host.start({ managerId, request: '絵を添えて', cwd: '/workspace' });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
    expect(attachTexts[0]).toContain('写した:');
    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    expect(report.files?.map((file) => file.name)).toEqual(['astra.png']);
    expect(await readdir(join(outboxRoot, managerId))).toEqual([]);
  });
});
