import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { AgentManagerDriver, AgentManagerSessionSpec } from './agent-session.js';
import { createManagerToolsMcpServer } from './manager-tools.js';
import { createPeerBroker } from './peer-broker.js';

// #6753: manager・peer の MCP サーバは中継（clone-tool-relay-host）が
// `instance.connect(new StdioServerTransport(socket, socket))` でつなぐ。その経路と同じ形で tools/list を取り、
// `$schema` だけが消え、残りは素の SDK の出力と同じであることを縛る。

type Tool = { name: string; inputSchema: Record<string, unknown> } & Record<string, unknown>;
type Server = ReturnType<typeof createSdkMcpServer>;

async function listOverStdio(server: Server): Promise<Tool[]> {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  await server.instance.connect(new StdioServerTransport(toServer, fromServer));
  const reply = new Promise<Tool[]>((resolve) => {
    let buffer = '';
    fromServer.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const raw of buffer.split('\n')) {
        if (raw.trim() === '') continue;
        let message: { id?: number; result?: { tools?: Tool[] } };
        try {
          message = JSON.parse(raw) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 2 && message.result?.tools !== undefined) resolve(message.result.tools);
      }
    });
  });
  const send = (message: object) => toServer.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await reply;
  await server.instance.close();
  return tools;
}

function withoutDollarSchema(tools: Tool[]): unknown {
  return JSON.parse(
    JSON.stringify(tools, (key, value: unknown) => (key === '$schema' ? undefined : value)),
  );
}

// 包みを外した（prototype の connect に戻した）同じサーバの出力 = 素の SDK の出力
function unwrapped(server: Server): Server {
  delete (server.instance as unknown as { connect?: unknown }).connect;
  return server;
}

function managerServer(): Server {
  return createManagerToolsMcpServer({
    record: () => undefined,
    restore: () => undefined,
    managerId: 'mgr-1',
    attach: async () => [],
  });
}

function peerServer(): Server {
  const driver = { providerId: 'codex', open: () => ({}) } as unknown as AgentManagerDriver;
  return createPeerBroker({
    allowed: ['codex'],
    driverOf: () => driver,
    makeSpec: () => ({}) as unknown as AgentManagerSessionSpec,
    reportsUsage: () => false,
    onNote: () => undefined,
    onUsage: () => undefined,
  }).mcpServer();
}

describe('中継経由の tools/list', () => {
  for (const [name, make] of [
    ['alteroid-manager', managerServer],
    ['alteroid-peer', peerServer],
  ] as const) {
    it(`${name}: どの道具の schema にも $schema が無く、$schema を除いた中身は素の SDK と同じ`, async () => {
      const lean = await listOverStdio(make());
      const raw = await listOverStdio(unwrapped(make()));
      expect(lean.length).toBeGreaterThan(0);
      expect(lean.length).toBe(raw.length);
      // 素の SDK は付ける（付かなくなったなら、この外し自体が要らなくなっている）
      expect(raw.every((tool) => '$schema' in tool.inputSchema)).toBe(true);
      expect(JSON.stringify(lean)).not.toContain('$schema');
      expect(lean).toEqual(withoutDollarSchema(raw));
    });
  }
});
