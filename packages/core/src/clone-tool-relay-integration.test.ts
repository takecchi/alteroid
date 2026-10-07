import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-child.js';
import { buildCloneToolRelayChildDistForTesting } from './clone-tool-relay-child-build.test-support.js';
import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';
import { clearRecentTracesForTesting, noteDroppedRecord } from './dropped-record.js';
import { createMemoryStores } from './testing.js';
import { CLONE_TOOL_NAMES, createCloneMcpServer, type ToolContext } from './tools.js';

describe('clone-tool-relay 統合（子プロセスを実際に spawn する）', () => {
  let childEntry: string;

  beforeAll(async () => {
    childEntry = await buildCloneToolRelayChildDistForTesting('clone-tool-relay-integration-dist-');
  }, 60_000);

  let host: CloneToolRelayHost | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    host?.close();
    host = undefined;
    client = undefined;
    clearRecentTracesForTesting();
  });

  function minimalToolContext(): ToolContext {
    return {
      stores: createMemoryStores(),
      emit: () => {},
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    };
  }

  async function connect(): Promise<Client> {
    const dir = makeTempDirSync('clone-tool-relay-integration-');
    host = await createCloneToolRelayHost({ socketPath: join(dir, 's.sock') });
    const token = host.register(() => createCloneMcpServer(minimalToolContext()).instance);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [childEntry],
      env: {
        [CLONE_TOOL_RELAY_SOCKET_ENV]: host.socketPath,
        [CLONE_TOOL_RELAY_TOKEN_ENV]: token,
      },
    });
    client = new Client({ name: 'clone-tool-relay-integration.test', version: '0' });
    await client.connect(transport);
    return client;
  }

  it('tools/list が CLONE_TOOL_NAMES の全本数と一致する（子プロセス越し）', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());
  }, 20_000);

  it('self_dropped は道具の実体が居るプロセス（このテストプロセス）の跡を返す', async () => {
    const marker = 'clone-tool-relay-integration-test-marker';
    noteDroppedRecord('中継の統合試験', marker, new Error('boom'));

    const c = await connect();
    const result = (await c.callTool({ name: 'self_dropped', arguments: {} })) as {
      content: { type: string; text?: string }[];
    };
    const body = result.content.map((block) => block.text ?? '').join('\n');
    expect(body).toContain(marker);
  }, 20_000);
});
