import { describe, expect, it } from 'vitest';

import {
  foldMcpToolsByServer,
  MCP_SERVER_OTHER,
  MCP_SERVER_UNKNOWN,
  MCP_TOOLS_BY_SERVER_LIMIT,
} from './mcp-tools-by-server.js';
import { contextUsageObservationSchema } from './schema.js';

describe('foldMcpToolsByServer（MCP の道具を serverName ごとに畳む）', () => {
  it('複数サーバの本数とトークンを合算し、トークンの大きい順に並べる', () => {
    expect(
      foldMcpToolsByServer([
        { serverName: 'alteroid', tokens: 100 },
        { serverName: 'pixellab', tokens: 700 },
        { serverName: 'alteroid', tokens: 400 },
        { serverName: 'pixellab', tokens: 300 },
        { serverName: 'pixellab', tokens: 50 },
      ]),
    ).toEqual([
      { name: 'pixellab', count: 3, tokens: 1_050 },
      { name: 'alteroid', count: 2, tokens: 500 },
    ]);
  });

  it('serverName が無い（または空の）道具は unknown へ畳む', () => {
    expect(
      foldMcpToolsByServer([
        { tokens: 10 },
        { serverName: '', tokens: 20 },
        { serverName: 'a', tokens: 5 },
      ]),
    ).toEqual([
      { name: MCP_SERVER_UNKNOWN, count: 2, tokens: 30 },
      { name: 'a', count: 1, tokens: 5 },
    ]);
  });

  it('空の入力は空の配列（呼び出し側が欄を作らない）', () => {
    expect(foldMcpToolsByServer([])).toEqual([]);
  });

  it('上限以内なら「ほか」の行を作らない', () => {
    const tools = Array.from({ length: MCP_TOOLS_BY_SERVER_LIMIT }, (_, i) => ({
      serverName: `s${String(i).padStart(2, '0')}`,
      tokens: i + 1,
    }));
    const folded = foldMcpToolsByServer(tools);
    expect(folded).toHaveLength(MCP_TOOLS_BY_SERVER_LIMIT);
    expect(folded.some((row) => row.name === MCP_SERVER_OTHER)).toBe(false);
  });

  it('上限を超えた分は「ほか」の1行へ本数・トークンを合算し、行数は上限に収まる', () => {
    // 20 サーバ、s00（1 トークン）〜 s19（20 トークン）。各サーバ 1 本。
    const tools = Array.from({ length: 20 }, (_, i) => ({
      serverName: `s${String(i).padStart(2, '0')}`,
      tokens: i + 1,
    }));
    const folded = foldMcpToolsByServer(tools);
    expect(folded).toHaveLength(MCP_TOOLS_BY_SERVER_LIMIT);
    expect(folded[0]).toEqual({ name: 's19', count: 1, tokens: 20 });
    const other = folded[folded.length - 1];
    // 上位 15 行（s19..s05）を除いた s04..s00 = 5 + 4 + 3 + 2 + 1
    expect(other).toEqual({ name: MCP_SERVER_OTHER, count: 5, tokens: 15 });
    // 合計は畳んでも変わらない
    expect(folded.reduce((t, r) => t + r.tokens, 0)).toBe(210);
    expect(folded.reduce((t, r) => t + r.count, 0)).toBe(20);
  });

  it('同じトークンの行は名前の順で、入力の順に依存しない', () => {
    const a = foldMcpToolsByServer([
      { serverName: 'b', tokens: 1 },
      { serverName: 'a', tokens: 1 },
    ]);
    const b = foldMcpToolsByServer([
      { serverName: 'a', tokens: 1 },
      { serverName: 'b', tokens: 1 },
    ]);
    expect(a).toEqual(b);
    expect(a.map((row) => row.name)).toEqual(['a', 'b']);
  });
});

describe('contextUsageObservationSchema の mcpToolsByServer', () => {
  it('この欄が無い古い行をそのまま読める', () => {
    const old = { durationMs: 5, totalTokens: 100, mcpToolTokens: 10, mcpToolCount: 2 };
    expect(contextUsageObservationSchema.parse(old)).toEqual(old);
  });

  it('新しい欄を持つ行を読み、中身を落とさない', () => {
    const row = {
      durationMs: 5,
      mcpToolsByServer: [{ name: 'pixellab', count: 110, tokens: 100_000 }],
    };
    expect(contextUsageObservationSchema.parse(row)).toEqual(row);
  });
});
