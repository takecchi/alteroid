import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkMcpServers, validateMcpServerName } from './mcp-servers-schema.js';
import { mcpServerNameSchema, mcpServersSchema, parseMcpServers } from './mcp-servers.js';

// zod の mcpServersSchema（daemon が使う）と、zod なしの checkMcpServers（web が使う）が、同じ入力で同じ判定になること（#5903）。
// 表は、画面の試験の不正な10種・形に合う例・各 type の全欄・名前の規則を通す
const OK: Array<[string, Record<string, unknown>]> = [
  ['空の登録', {}],
  ['stdio の最小', { a: { command: 'npx' } }],
  ['stdio の type 明示', { a: { type: 'stdio', command: 'npx' } }],
  [
    'stdio の全欄',
    {
      a: {
        command: 'npx',
        args: ['-y', 'x'],
        env: { K: 'v' },
        timeout: 3000,
        alwaysLoad: true,
      },
    },
  ],
  ['http の最小', { a: { type: 'http', url: 'https://example.com/mcp' } }],
  [
    'http の全欄',
    {
      a: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { A: 'b' },
        timeout: 1,
        alwaysLoad: false,
      },
    },
  ],
  ['sse の全欄', { a: { type: 'sse', url: 'x', headers: {}, timeout: 5, alwaysLoad: true } }],
  ['複数', { a: { command: 'x' }, 'B-2_c': { type: 'sse', url: 'y' } }],
  ['名前が64文字', { ['a'.repeat(64)]: { command: 'x' } }],
  ['args が空配列', { a: { command: 'x', args: [] } }],
];

const BAD: Array<[string, Record<string, unknown>]> = [
  ['url が数値', { demo: { type: 'http', url: 5 } }],
  ['url が無い', { demo: { type: 'sse' } }],
  ['command が無い', { demo: {} }],
  ['args の中が文字列でない', { demo: { command: 'npx', args: ['-y', 1] } }],
  ['args が配列でない', { demo: { command: 'npx', args: 'x' } }],
  ['env の値が文字列でない', { demo: { command: 'npx', env: { KEY: true } } }],
  ['env が配列', { demo: { command: 'npx', env: ['a'] } }],
  ['headers の値が数値', { demo: { type: 'http', url: 'x', headers: { A: 1 } } }],
  ['未知の欄（stdio）', { demo: { command: 'npx', header: {} } }],
  ['未知の欄（http）', { demo: { type: 'http', url: 'x', command: 'npx' } }],
  ['type が3つの外', { demo: { type: 'ws', url: 'x' } }],
  ['type が数値', { demo: { type: 5, command: 'x' } }],
  ['type が無いのに url', { demo: { url: 'https://example.com/mcp' } }],
  ['timeout が 0', { demo: { command: 'npx', timeout: 0 } }],
  ['timeout が負', { demo: { command: 'npx', timeout: -1 } }],
  ['timeout が小数', { demo: { command: 'npx', timeout: 1.5 } }],
  ['timeout が文字列', { demo: { command: 'npx', timeout: '5' } }],
  ['alwaysLoad が文字列', { demo: { command: 'npx', alwaysLoad: 'yes' } }],
  ['空の command', { demo: { command: '' } }],
  ['NUL だけの command', { demo: { command: '\u0000' } }],
  ['NUL だけの url', { demo: { type: 'http', url: '\u0000\u0000' } }],
  ['entry が文字列', { demo: 'x' }],
  ['entry が配列', { demo: [] }],
  ['entry が null', { demo: null }],
  ['名前に空白', { 'a b': { command: 'x' } }],
  ['名前が65文字', { ['a'.repeat(65)]: { command: 'x' } }],
  ['名前が空', { '': { command: 'x' } }],
  ['予約名', { alteroid: { command: 'x' } }],
  ['予約名（大文字）', { AlterOid: { command: 'x' } }],
  ['2件目だけ不正', { a: { command: 'x' }, b: { type: 'http' } }],
];

describe('checkMcpServers（zod なし）と mcpServersSchema（zod）の突き合わせ（#5903）', () => {
  it.each(OK)('形に合う（%s）: 両方が通す', (_name, servers) => {
    expect(mcpServersSchema.safeParse(servers).success).toBe(true);
    expect(checkMcpServers(servers)).toBeUndefined();
  });

  it.each(BAD)('形に合わない（%s）: 両方が断る', (_name, servers) => {
    expect(mcpServersSchema.safeParse(servers).success).toBe(false);
    expect(checkMcpServers(servers)).toBeDefined();
  });

  it('サーバ名の規則は、zod の名前のスキーマと同じ判定・同じ理由', () => {
    for (const name of [
      'a',
      'a b',
      '',
      'a'.repeat(64),
      'a'.repeat(65),
      'alteroid',
      'ALTEROID',
      'あ',
    ]) {
      const zodResult = mcpServerNameSchema.safeParse(name);
      const reason = validateMcpServerName(name);
      expect(reason === null, name).toBe(zodResult.success);
      if (!zodResult.success) expect(reason).toBe(zodResult.error.issues[0]?.message);
    }
  });

  it('parseMcpServers は、通るものを通し、断るものを断る', () => {
    for (const [, servers] of OK) expect(() => parseMcpServers(servers)).not.toThrow();
    for (const [, servers] of BAD) expect(() => parseMcpServers(servers)).toThrow();
  });
});

describe('checkMcpServers が返す違い', () => {
  it('どのサーバのどの欄かを返す', () => {
    expect(checkMcpServers({ demo: { type: 'http', url: 5 } })).toEqual({
      kind: 'wrong-type',
      server: 'demo',
      path: ['url'],
      expected: 'string',
      actual: 'number',
    });
    expect(checkMcpServers({ demo: { type: 'sse' } })).toEqual({
      kind: 'wrong-type',
      server: 'demo',
      path: ['url'],
      expected: 'string',
      actual: 'undefined',
    });
    expect(checkMcpServers({ demo: { command: 'x', env: { K: true } } })).toMatchObject({
      path: ['env', 'K'],
      actual: 'boolean',
    });
    expect(checkMcpServers({ demo: { command: 'x', args: ['a', 1] } })).toMatchObject({
      path: ['args', 1],
    });
    expect(checkMcpServers({ demo: { command: 'x', timeout: 0 } })).toEqual({
      kind: 'not-positive',
      server: 'demo',
      field: 'timeout',
    });
    expect(checkMcpServers({ demo: { command: 'x', header: 1 } })).toEqual({
      kind: 'unknown-keys',
      server: 'demo',
      keys: ['header'],
    });
  });

  it('値（秘密になりうる）を返さない', () => {
    const issue = checkMcpServers({ demo: { command: 'x', env: { K: 'sk-secret-value', J: 5 } } });
    expect(JSON.stringify(issue)).not.toContain('sk-secret-value');
  });
});

describe('入口の形', () => {
  it('zod も node: も tools.js も import しない（ブラウザの束に入れられる）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./mcp-servers-schema.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+'(zod|node:)/);
    expect(source).not.toMatch(/from\s+'\.\/tools\.js'/);
    expect(source).not.toMatch(/from\s+'\.\/mcp-servers\.js'/);
  });
});
