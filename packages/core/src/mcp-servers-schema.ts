import { MCP_SERVER_NAME } from './mcp-server-name.js';
import { stripNul } from './nul-guard.js';

// MCP サーバの登録の「形」の規則。zod を使わない定数と関数。web の保存前の検査が使う入口。
// zod も node: も import しない: ブラウザの束に zod（約 100 KB）を入れないため。mcp-servers.ts は node:crypto も引く。
// daemon が使う zod のスキーマ（mcp-servers.ts の mcpServersSchema）は、ここの定数・関数から組める所を組み（名前の規則・予約名・
// NUL だけの値・type の値）、欄の型と未知の欄の判定は zod の書き方で持つ。2つが同じ判定になることは、同じ入力の表を両方に通して
// mcp-servers-schema.test.ts が突き合わせる。
// 未知の欄は黙って捨てずに拒む: 捨てると綴りを間違えた `headers` が「保存できたのに効かない」になる。
// 拒む理由に値は載せない（`env` / `headers` / `args` には秘密が入りうる）。欄の名前と型だけを返す。

/** 名前は道具名の一部（`mcp__<名前>__<道具>`）になる。緩めると `allowedTools` の照合が壊れる。 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MCP_SERVER_NAME_RULE = '英数字・-・_ の1〜64文字で書くこと';
export const MCP_RESERVED_NAME_RULE = `「${MCP_SERVER_NAME}」は alteroid 自身の MCP サーバの名前なので使えない`;

/** NUL だけの値は、`prepareMcpServersForWrite` が NUL を落とすと空になる。落とした後の形で断る。 */
export const MCP_NUL_ONLY_RULE = 'NUL（\\u0000）だけの値は空と同じ';

/** 大文字小文字を無視して比べる: 接頭辞 `mcp__alteroid__` で自作ツールを許可しているので、見分けにくい綴りの別サーバを入口で止める。 */
export function isReservedMcpServerName(name: string): boolean {
  return name.toLowerCase() === MCP_SERVER_NAME.toLowerCase();
}

/** 名前が使えないときの理由（通れば null） */
export function validateMcpServerName(name: string): string | null {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) return MCP_SERVER_NAME_RULE;
  if (isReservedMcpServerName(name)) return MCP_RESERVED_NAME_RULE;
  return null;
}

/** type の値。`type` が無いときは stdio として読む */
export const MCP_TYPE_STDIO = 'stdio';
export const MCP_TYPE_HTTP = 'http';
export const MCP_TYPE_SSE = 'sse';

type FieldKind = 'nonEmpty' | 'stringArray' | 'stringMap' | 'positiveInt' | 'boolean';

// type ごとの、許す欄・その型・必須か。順番は zod のスキーマの欄の並びと同じ
const COMMON_FIELDS: ReadonlyArray<readonly [string, FieldKind, boolean]> = [
  ['timeout', 'positiveInt', false],
  ['alwaysLoad', 'boolean', false],
];
const STDIO_FIELDS: ReadonlyArray<readonly [string, FieldKind, boolean]> = [
  ['command', 'nonEmpty', true],
  ['args', 'stringArray', false],
  ['env', 'stringMap', false],
  ...COMMON_FIELDS,
];
const URL_FIELDS: ReadonlyArray<readonly [string, FieldKind, boolean]> = [
  ['url', 'nonEmpty', true],
  ['headers', 'stringMap', false],
  ...COMMON_FIELDS,
];

export type JsonKind = 'undefined' | 'null' | 'array' | 'string' | 'number' | 'boolean' | 'object';

export type McpExpected = 'string' | 'number' | 'int' | 'boolean' | 'array' | 'record';

export type McpServersIssue =
  | { kind: 'name'; server: string; reason: string }
  | { kind: 'not-object'; server: string; actual: JsonKind }
  /** type が stdio・http・sse のどれでもない */
  | { kind: 'type'; server: string; actual: JsonKind }
  /** 欄の型が違う（actual が undefined なら、欄が無い）。path は配列の添字・map のキーまで */
  | {
      kind: 'wrong-type';
      server: string;
      path: ReadonlyArray<string | number>;
      expected: McpExpected;
      actual: JsonKind;
    }
  | { kind: 'empty'; server: string; field: string }
  | { kind: 'nul-only'; server: string; field: string }
  | { kind: 'not-positive'; server: string; field: string }
  | { kind: 'unknown-keys'; server: string; keys: string[] };

export function jsonKindOf(value: unknown): JsonKind {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkField(
  server: string,
  field: string,
  kind: FieldKind,
  value: unknown,
): McpServersIssue | undefined {
  const wrong = (
    path: ReadonlyArray<string | number>,
    expected: McpExpected,
    actual: unknown,
  ): McpServersIssue => ({
    kind: 'wrong-type',
    server,
    path,
    expected,
    actual: jsonKindOf(actual),
  });
  switch (kind) {
    case 'nonEmpty':
      if (typeof value !== 'string') return wrong([field], 'string', value);
      if (value.length < 1) return { kind: 'empty', server, field };
      if (stripNul(value).length === 0) return { kind: 'nul-only', server, field };
      return undefined;
    case 'stringArray': {
      if (!Array.isArray(value)) return wrong([field], 'array', value);
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string') return wrong([field, index], 'string', item);
      }
      return undefined;
    }
    case 'stringMap': {
      if (!isPlainObject(value)) return wrong([field], 'record', value);
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') return wrong([field, key], 'string', item);
      }
      return undefined;
    }
    case 'positiveInt':
      if (typeof value !== 'number') return wrong([field], 'number', value);
      if (!Number.isSafeInteger(value)) return wrong([field], 'int', value);
      if (value <= 0) return { kind: 'not-positive', server, field };
      return undefined;
    case 'boolean':
      if (typeof value !== 'boolean') return wrong([field], 'boolean', value);
      return undefined;
  }
}

function checkEntry(server: string, entry: unknown): McpServersIssue | undefined {
  if (!isPlainObject(entry)) return { kind: 'not-object', server, actual: jsonKindOf(entry) };
  const type = entry.type;
  let fields: ReadonlyArray<readonly [string, FieldKind, boolean]>;
  if (type === undefined || type === MCP_TYPE_STDIO) fields = STDIO_FIELDS;
  else if (type === MCP_TYPE_HTTP || type === MCP_TYPE_SSE) fields = URL_FIELDS;
  else return { kind: 'type', server, actual: jsonKindOf(type) };

  for (const [field, kind, required] of fields) {
    const value = entry[field];
    if (value === undefined && !required) continue;
    const issue = checkField(server, field, kind, value);
    if (issue !== undefined) return issue;
  }
  const known = new Set<string>(['type', ...fields.map(([field]) => field)]);
  const unknown = Object.keys(entry).filter((key) => !known.has(key));
  if (unknown.length > 0) return { kind: 'unknown-keys', server, keys: unknown };
  return undefined;
}

/**
 * 登録（サーバ名 → 設定）の形を見て、最初に見つかった違いを返す（合っていれば undefined）。
 * zod の `mcpServersSchema` が通すものを通し、断るものを断る（試験で突き合わせる）。
 */
export function checkMcpServers(servers: Record<string, unknown>): McpServersIssue | undefined {
  for (const [server, entry] of Object.entries(servers)) {
    const reason = validateMcpServerName(server);
    if (reason !== null) return { kind: 'name', server, reason };
    const issue = checkEntry(server, entry);
    if (issue !== undefined) return issue;
  }
  return undefined;
}
