import { describe, expect, it } from 'vitest';

import { RECENT_TRACE_LIMIT } from './dropped-record.js';
import { createMemoryStores } from './testing.js';
import {
  createCloneMcpServer,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
  REMOVE_MANY_LIMIT_MAX,
} from './tools.js';

/**
 * issue #1720（PR #1689 の揃え漏れの横断レビュー、12回目）。
 *
 * `tools.ts` の `createCloneTools()` に在る52個の道具を1つずつ読み、
 * `z.number()` 系のうち型以外の制約（`.int()`/`.min()`/`.max()`/`.positive()`）
 * を入力スキーマ側に持つ欄を数え上げたところ21件あり、`schedule_create.
 * everyMinutes`（#1689 で対応済み）を除く20件が同じ穴を持っていた——
 * SDK の `tool()` がハンドラを呼ぶ**前**に検証し、範囲外の値を渡すと英語の
 * zod の JSON（`MCP_INPUT_VALIDATION_ERROR_MARKER` 付き）がそのまま返る。
 *
 * ここではその20件全部について、(1) 範囲外の値では日本語の平文が返り
 * マーカーが付かないこと (2) 範囲内の値は今までどおり通ることを測る。
 *
 * ## なぜ `tools.test.ts` の `harness.call()` では足りないか
 *
 * `harness.call()` は `entry.handler(args)` を直接叩くので、JSON の往復も
 * zod の検査も通らない（`tool-arguments.test.ts` の doc と同じ理由）。
 * 入力スキーマ側の制約を外したことを見るには、本物の MCP の往復
 * （`tools/call`）を通す必要がある——ここではそれを最小限に自前で組む
 * （`schedule-create-request-validation.test.ts` と同じ手）。
 */

interface Rpc {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}

async function connect(stores: ReturnType<typeof createMemoryStores>): Promise<Rpc> {
  const server = createCloneMcpServer({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let deliver: ((message: unknown) => void) | undefined;

  const transport = {
    async start() {},
    async send(message: Record<string, unknown>) {
      const wire = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
      const id = wire['id'];
      if (typeof id === 'number' && pending.has(id)) {
        pending.get(id)?.(wire);
        pending.delete(id);
      }
    },
    async close() {},
    set onmessage(handler: (message: unknown) => void) {
      deliver = handler;
    },
    get onmessage() {
      return deliver as (message: unknown) => void;
    },
    onclose: undefined,
    onerror: undefined,
  };

  await server.instance.connect(transport as never);

  let nextId = 1;
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      deliver?.(JSON.parse(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    });
  };

  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tool-numeric-args-handler-validation-1720.test', version: '0' },
  });
  deliver?.({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return { call };
}

async function callTool(
  rpc: Rpc,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const response = await rpc.call('tools/call', { name, arguments: args });
  const result = response['result'] as
    { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  if (result === undefined) {
    return { isError: true, text: JSON.stringify(response['error']) };
  }
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map((block) => block.text ?? '').join(''),
  };
}

/**
 * 1行が1欄・1境界を測る。`base` はその道具を呼ぶのに要る他の引数
 * （`base` 自体は常に有効な値にしてあるので、`field` を混ぜたときにだけ
 * 検査が働く）。`invalid` は範囲外・非整数の値、`valid` は範囲内の値
 * （境界値そのものを使う——中間値だけでは境界を1つずらす変異を見逃す）。
 */
interface Case {
  label: string;
  tool: string;
  base: Record<string, unknown>;
  field: string;
  invalid: number;
  valid: number;
}

const cases: Case[] = [
  {
    label: 'memory_read.offset（min 0）',
    tool: 'memory_read',
    base: { slug: 'probe' },
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'memory_outline.offset（min 0）',
    tool: 'memory_outline',
    base: { slug: 'probe' },
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'journal_read.limit（min 1）',
    tool: 'journal_read',
    base: {},
    field: 'limit',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'journal_read.limit（max 200）',
    tool: 'journal_read',
    base: {},
    field: 'limit',
    invalid: 201,
    valid: 200,
  },
  {
    label: 'journal_read.offset（min 0）',
    tool: 'journal_read',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'approvals_list.offset（min 0）',
    tool: 'approvals_list',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'schedule_list.offset（min 0）',
    tool: 'schedule_list',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'commitment_list.offset（min 0）',
    tool: 'commitment_list',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'commitment_close_many.limit（min 1）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'limit',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'commitment_close_many.limit（max 2000）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'limit',
    invalid: 2_001,
    valid: 2_000,
  },
  {
    label: 'inbox_remove_many.limit（min 1）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'limit',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'inbox_remove_many.limit（max）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'limit',
    invalid: REMOVE_MANY_LIMIT_MAX + 1,
    valid: REMOVE_MANY_LIMIT_MAX,
  },
  {
    label: 'profile_read.offset（min 0）',
    tool: 'profile_read',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'practice_read.version（positive＝min 1）',
    tool: 'practice_read',
    base: { slug: 'probe' },
    field: 'version',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'self_read.offset（min 0）',
    tool: 'self_read',
    base: { document: 'PRD.md' },
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'self_dropped.limit（min 1）',
    tool: 'self_dropped',
    base: {},
    field: 'limit',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'self_dropped.limit（max RECENT_TRACE_LIMIT）',
    tool: 'self_dropped',
    base: {},
    field: 'limit',
    invalid: RECENT_TRACE_LIMIT + 1,
    valid: RECENT_TRACE_LIMIT,
  },
  {
    label: 'self_dropped.offset（min 0）',
    tool: 'self_dropped',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'self_dropped.offset（max RECENT_TRACE_LIMIT）',
    tool: 'self_dropped',
    base: {},
    field: 'offset',
    invalid: RECENT_TRACE_LIMIT + 1,
    valid: RECENT_TRACE_LIMIT,
  },
  {
    label: 'manager_report.offset（min 0）',
    tool: 'manager_report',
    base: { managerId: 'probe' },
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'conversation_read.scan（min 1）',
    tool: 'conversation_read',
    base: {},
    field: 'scan',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'conversation_read.scan（max 10000）',
    tool: 'conversation_read',
    base: {},
    field: 'scan',
    invalid: 10_001,
    valid: 10_000,
  },
  {
    label: 'conversation_read.limit（min 1）',
    tool: 'conversation_read',
    base: {},
    field: 'limit',
    invalid: 0,
    valid: 1,
  },
  {
    label: 'conversation_read.limit（max 200）',
    tool: 'conversation_read',
    base: {},
    field: 'limit',
    invalid: 201,
    valid: 200,
  },
  {
    label: 'conversation_read.offset（min 0）',
    tool: 'conversation_read',
    base: {},
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'manager_transcript.offset（min 0）',
    tool: 'manager_transcript',
    base: { managerId: 'probe' },
    field: 'offset',
    invalid: -1,
    valid: 0,
  },
  {
    label: 'archive_remove_many.minStoredBytes（min 0）',
    tool: 'archive_remove_many',
    base: { summary: 'x' },
    field: 'minStoredBytes',
    invalid: -1,
    valid: 0,
  },
];

describe('道具の数値引数（20件）— 範囲外は日本語の平文、範囲内は今までどおり通る（issue #1720）', () => {
  it.each(cases)('$label', async ({ tool, base, field, invalid, valid }) => {
    const stores = createMemoryStores();

    // --- 範囲外 ---
    const badRpc = await connect(stores);
    const bad = await callTool(badRpc, tool, { ...base, [field]: invalid });
    expect(bad.isError, `${tool}.${field}=${invalid}: ${bad.text}`).toBe(false);
    expect(bad.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(bad.text).toContain(field);

    // --- 範囲内（境界値そのもの） ---
    const goodRpc = await connect(stores);
    const good = await callTool(goodRpc, tool, { ...base, [field]: valid });
    // **境界値そのものが「範囲外」に化けていないこと。** ここが `isError` を
    // 立てたり、この道具に無関係な文言（`field` 名を含む断り）を返したりして
    // いれば、境界がずれた変異である。
    expect(good.isError, `${tool}.${field}=${valid}: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });

  /**
   * `.int()` 側（非整数）の代表的な数本。範囲内であっても整数でなければ
   * 断ることを見る——`describeIntRangeViolation` が `Number.isInteger` を
   * 先に見ているかどうかは、範囲だけの表では測れない。
   */
  it.each([
    {
      label: 'memory_read.offset（非整数）',
      tool: 'memory_read',
      base: { slug: 'probe' },
      field: 'offset',
      value: 0.5,
    },
    {
      label: 'journal_read.limit（非整数）',
      tool: 'journal_read',
      base: {},
      field: 'limit',
      value: 1.5,
    },
    {
      label: 'practice_read.version（非整数）',
      tool: 'practice_read',
      base: { slug: 'probe' },
      field: 'version',
      value: 1.5,
    },
  ])('$label は整数のみ（非整数は断る）', async ({ tool, base, field, value }) => {
    const rpc = await connect(createMemoryStores());
    const result = await callTool(rpc, tool, { ...base, [field]: value });
    expect(result.isError, `${tool}.${field}=${value}: ${result.text}`).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain(field);
  });
});
