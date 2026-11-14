import { query } from '@anthropic-ai/claude-agent-sdk';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { fakeManagerPool } from './manager-pool.test-support.js';
import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, type ToolContext } from './tools.js';

// #6753: 本番の経路（query が SDK MCP サーバを自分の transport でつなぐ口）を通しても `$schema` が消えている。
// claude 本体の代わりに、stdin/stdout で制御メッセージをやり取りする偽の子プロセスを置く。

const context: ToolContext = {
  stores: createMemoryStores(),
  emit: () => undefined,
  memoryCause: () => 'clone',
  conversationId: () => undefined,
  managers: fakeManagerPool({ runningManagerOwning: () => undefined }),
};

interface Line {
  type?: string;
  request_id?: string;
  request?: { subtype?: string };
  response?: {
    request_id?: string;
    response?: { mcp_response?: { id?: number; result?: unknown } };
  };
}

describe('query 経由の tools/list', () => {
  it('query が SDK MCP サーバをつなぐ経路で取った tools/list に $schema が無い', async () => {
    const server = createCloneMcpServer(context);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const toolsListed = new Promise<{ name: string; inputSchema: object }[]>((resolve) => {
      let buffer = '';
      let sent = 0;
      const sendMcp = (id: number, method: string, params: object) =>
        stdout.write(
          `${JSON.stringify({
            type: 'control_request',
            request_id: `fake-${String(id)}`,
            request: {
              subtype: 'mcp_message',
              server_name: 'alteroid',
              message: { jsonrpc: '2.0', id, method, params },
            },
          })}\n`,
        );
      stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          if (raw.trim() === '') continue;
          const line = JSON.parse(raw) as Line;
          if (line.type === 'control_request' && line.request?.subtype === 'initialize') {
            stdout.write(
              `${JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: line.request_id, response: {} },
              })}\n`,
            );
            sendMcp(1, 'initialize', {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'fake', version: '0' },
            });
          }
          const mcp = line.response?.response?.mcp_response;
          if (mcp?.id === 1 && sent === 0) {
            sent = 1;
            sendMcp(2, 'tools/list', {});
          } else if (mcp?.id === 2) {
            resolve((mcp.result as { tools: { name: string; inputSchema: object }[] }).tools);
          }
        }
      });
    });
    const q = query({
      prompt: 'x',
      options: {
        mcpServers: { alteroid: server },
        pathToClaudeCodeExecutable: '/nonexistent/claude',
        spawnClaudeCodeProcess: () => ({
          stdin,
          stdout,
          killed: false,
          exitCode: null,
          signalCode: null,
          kill: () => true,
          on: () => {},
          once: () => {},
          off: () => {},
        }),
      },
    });
    const drained = (async () => {
      try {
        for await (const message of q) void message;
      } catch {
        // 閉じた後の失敗は見たいものではない
      }
    })();
    const tools = await toolsListed;
    q.close();
    await drained;

    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).not.toContain('$schema');
  });
});
