import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as fromMcpServers from './mcp-servers.js';
import * as fromSchema from './mcp-servers-schema.js';

describe('mcp-servers-schema（web の保存前の検査が使う小さな入口。#5903）', () => {
  it('mcp-servers.ts から出すスキーマは、この入口のものと同一（検査が2つに分かれない）', () => {
    expect(fromMcpServers.mcpServersSchema).toBe(fromSchema.mcpServersSchema);
    expect(fromMcpServers.mcpServerConfigSchema).toBe(fromSchema.mcpServerConfigSchema);
    expect(fromMcpServers.mcpServerNameSchema).toBe(fromSchema.mcpServerNameSchema);
    expect(fromMcpServers.isReservedMcpServerName).toBe(fromSchema.isReservedMcpServerName);
  });

  it('parseMcpServers はこの入口のスキーマが通すものを通し、断るものを断る', () => {
    const ok = { demo: { type: 'http', url: 'https://example.com/mcp' } };
    const bad = { demo: { type: 'http', url: 5 } };
    expect(fromSchema.mcpServersSchema.safeParse(ok).success).toBe(true);
    expect(() => fromMcpServers.parseMcpServers(ok)).not.toThrow();
    expect(fromSchema.mcpServersSchema.safeParse(bad).success).toBe(false);
    expect(() => fromMcpServers.parseMcpServers(bad)).toThrow(/MCP サーバの登録の形が不正/);
  });

  it('node: の組み込みも tools.js も import しない（ブラウザの束に入れられる）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./mcp-servers-schema.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+'node:/);
    expect(source).not.toMatch(/from\s+'\.\/tools\.js'/);
  });
});
