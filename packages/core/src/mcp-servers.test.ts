import { describe, expect, it } from 'vitest';

import { verifyMcpServerStoreContract } from './mcp-server-contract.js';
import { isReservedMcpServerName, mcpServerNames, parseMcpServers } from './mcp-servers.js';
import { createMemoryStores } from './testing.js';
import { MCP_SERVER_NAME } from './tools.js';

describe('MCP サーバの登録（#325 段1）', () => {
  it('器の契約（インメモリ。3実装で同じことを測る）', async () => {
    await verifyMcpServerStoreContract(createMemoryStores().mcpServers);
  });

  it('.mcp.json の mcpServers をそのまま受ける（stdio は type を省略できる）', () => {
    const servers = parseMcpServers({
      local: { command: 'node', args: ['server.js'], env: { A: '1' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp', headers: { X: 'y' } },
      stream: { type: 'sse', url: 'https://example.invalid/sse' },
    });
    expect(mcpServerNames(servers)).toEqual(['local', 'remote', 'stream']);
  });

  /**
   * 自作のインプロセス MCP の名前は入口で拒む。**名前を import して比べる** ——
   * ここで `'alteroid'` を書き写すと、`MCP_SERVER_NAME` が変わったときに歯が
   * 古い名前を測り続ける。
   */
  it('alteroid 自身の名前は大文字小文字を問わず拒む', () => {
    expect(isReservedMcpServerName(MCP_SERVER_NAME)).toBe(true);
    expect(isReservedMcpServerName(MCP_SERVER_NAME.toUpperCase())).toBe(true);
    expect(isReservedMcpServerName(`${MCP_SERVER_NAME}-x`)).toBe(false);
    expect(() => parseMcpServers({ [MCP_SERVER_NAME]: { command: 'x' } })).toThrow(MCP_SERVER_NAME);
  });

  /**
   * **未知の欄は捨てずに拒む。** 捨てると綴りを間違えた欄が「保存できたのに
   * 効かない」になる。そして拒む文言に値を載せない（`env` に鍵が入りうる）。
   */
  it('未知の欄・不正な形は拒み、文言に値を載せない', () => {
    const attempt = (input: unknown) => {
      try {
        parseMcpServers(input);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('拒まなかった');
    };
    const unknownField = attempt({ ok: { command: 'x', headres: { K: 'SECRET-VALUE' } } });
    expect(unknownField).not.toContain('SECRET-VALUE');
    const wrongType = attempt({ ok: { type: 'http', url: 'https://x', headers: { K: 1 } } });
    expect(wrongType).not.toContain('SECRET');
    expect(attempt({ 'bad name': { command: 'x' } })).toContain('bad name');
    expect(attempt({ ok: { type: 'ws', url: 'wss://x' } })).toMatch(/ok/);
  });
});
