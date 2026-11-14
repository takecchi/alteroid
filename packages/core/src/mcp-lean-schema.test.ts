import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { fakeManagerPool } from './manager-pool.test-support.js';
import { MCP_SERVER_NAME } from './mcp-server-name.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, createCloneTools, type ToolContext } from './tools.js';

// #6753: 道具の schema から意味のない `$schema` だけが消え、引数・説明文は変わらない。

type Listed = Awaited<ReturnType<Client['listTools']>>['tools'];

function makeContext(): ToolContext {
  return {
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: fakeManagerPool({ runningManagerOwning: () => undefined }),
  };
}

async function listTools(server: { instance: { connect: (t: never) => Promise<void> } }) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide as never);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientSide);
  return (await client.listTools()).tools;
}

function withoutDollarSchema(tools: Listed): unknown {
  return JSON.parse(
    JSON.stringify(tools, (key, value: unknown) => (key === '$schema' ? undefined : value)),
  );
}

describe('クローンの道具の tools/list', () => {
  it('どの道具の schema にも $schema が無く、$schema を除いた中身は SDK 素のままと同じ', async () => {
    const context = makeContext();
    const lean = await listTools(createCloneMcpServer(context));
    const raw = await listTools(
      createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: '0.1.0',
        tools: createCloneTools(context),
      }),
    );

    expect(lean.length).toBeGreaterThan(0);
    expect(lean.length).toBe(raw.length);
    // 素の SDK は付ける（付かなくなったなら、この外し自体が要らなくなっている）
    expect(raw.every((tool) => '$schema' in tool.inputSchema)).toBe(true);
    expect(lean.some((tool) => '$schema' in tool.inputSchema)).toBe(false);
    expect(JSON.stringify(lean)).not.toContain('$schema');
    expect(lean).toEqual(withoutDollarSchema(raw));
  });
});
