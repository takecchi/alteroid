import { describe, expect, it } from 'vitest';

import { RECENT_TRACE_LIMIT } from './dropped-record.js';
import { createMemoryStores } from './testing.js';
import {
  CLOSE_MANY_LIMIT_MAX,
  createCloneMcpServer,
  formatIntRangeJa,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
  REMOVE_MANY_LIMIT_MAX,
} from './tools.js';

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

interface Case {
  label: string;
  tool: string;
  base: Record<string, unknown>;
  field: string;
  range: { min?: number; max?: number };
  invalid: number;
  valid: number;
}

const cases: Case[] = [
  {
    label: 'memory_read.offset（min 0）',
    tool: 'memory_read',
    base: { slug: 'probe' },
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'memory_outline.offset（min 0）',
    tool: 'memory_outline',
    base: { slug: 'probe' },
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'journal_read.limit（min 1）',
    tool: 'journal_read',
    base: {},
    field: 'limit',
    range: { min: 1, max: 200 },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'journal_read.limit（max 200）',
    tool: 'journal_read',
    base: {},
    field: 'limit',
    range: { min: 1, max: 200 },
    invalid: 201,
    valid: 200,
  },
  {
    label: 'journal_read.offset（min 0）',
    tool: 'journal_read',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'approvals_list.offset（min 0）',
    tool: 'approvals_list',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'schedule_list.offset（min 0）',
    tool: 'schedule_list',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'commitment_list.offset（min 0）',
    tool: 'commitment_list',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'commitment_close_many.limit（min 1）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'limit',
    range: { min: 1, max: CLOSE_MANY_LIMIT_MAX },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'commitment_close_many.limit（max 2000）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'limit',
    range: { min: 1, max: CLOSE_MANY_LIMIT_MAX },
    invalid: 2_001,
    valid: 2_000,
  },
  {
    label: 'inbox_remove_many.limit（min 1）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'limit',
    range: { min: 1, max: REMOVE_MANY_LIMIT_MAX },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'inbox_remove_many.limit（max）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'limit',
    range: { min: 1, max: REMOVE_MANY_LIMIT_MAX },
    invalid: REMOVE_MANY_LIMIT_MAX + 1,
    valid: REMOVE_MANY_LIMIT_MAX,
  },
  {
    label: 'profile_read.offset（min 0）',
    tool: 'profile_read',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'practice_read.version（positive＝min 1）',
    tool: 'practice_read',
    base: { slug: 'probe' },
    field: 'version',
    range: { min: 1 },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'self_read.offset（min 0）',
    tool: 'self_read',
    base: { document: 'PRD.md' },
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'self_dropped.limit（min 1）',
    tool: 'self_dropped',
    base: {},
    field: 'limit',
    range: { min: 1, max: RECENT_TRACE_LIMIT },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'self_dropped.limit（max RECENT_TRACE_LIMIT）',
    tool: 'self_dropped',
    base: {},
    field: 'limit',
    range: { min: 1, max: RECENT_TRACE_LIMIT },
    invalid: RECENT_TRACE_LIMIT + 1,
    valid: RECENT_TRACE_LIMIT,
  },
  {
    label: 'self_dropped.offset（min 0）',
    tool: 'self_dropped',
    base: {},
    field: 'offset',
    range: { min: 0, max: RECENT_TRACE_LIMIT },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'self_dropped.offset（max RECENT_TRACE_LIMIT）',
    tool: 'self_dropped',
    base: {},
    field: 'offset',
    range: { min: 0, max: RECENT_TRACE_LIMIT },
    invalid: RECENT_TRACE_LIMIT + 1,
    valid: RECENT_TRACE_LIMIT,
  },
  {
    label: 'manager_report.offset（min 0）',
    tool: 'manager_report',
    base: { managerId: 'probe' },
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'conversation_read.scan（min 1）',
    tool: 'conversation_read',
    base: {},
    field: 'scan',
    range: { min: 1, max: 10_000 },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'conversation_read.scan（max 10000）',
    tool: 'conversation_read',
    base: {},
    field: 'scan',
    range: { min: 1, max: 10_000 },
    invalid: 10_001,
    valid: 10_000,
  },
  {
    label: 'conversation_read.limit（min 1）',
    tool: 'conversation_read',
    base: {},
    field: 'limit',
    range: { min: 1, max: 200 },
    invalid: 0,
    valid: 1,
  },
  {
    label: 'conversation_read.limit（max 200）',
    tool: 'conversation_read',
    base: {},
    field: 'limit',
    range: { min: 1, max: 200 },
    invalid: 201,
    valid: 200,
  },
  {
    label: 'conversation_read.offset（min 0）',
    tool: 'conversation_read',
    base: {},
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'manager_transcript.offset（min 0）',
    tool: 'manager_transcript',
    base: { managerId: 'probe' },
    field: 'offset',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
  {
    label: 'archive_remove_many.minStoredBytes（min 0）',
    tool: 'archive_remove_many',
    base: { summary: 'x' },
    field: 'minStoredBytes',
    range: { min: 0 },
    invalid: -1,
    valid: 0,
  },
];

describe('道具の数値引数（20件）— 範囲外は日本語の平文、範囲内は今までどおり通る（issue #1720）', () => {
  it.each(cases)('$label', async ({ tool, base, field, invalid, valid }) => {
    const stores = createMemoryStores();

    const badRpc = await connect(stores);
    const bad = await callTool(badRpc, tool, { ...base, [field]: invalid });
    expect(bad.isError, `${tool}.${field}=${invalid}: ${bad.text}`).toBe(false);
    expect(bad.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(bad.text).toContain(field);

    const goodRpc = await connect(stores);
    const good = await callTool(goodRpc, tool, { ...base, [field]: valid });
    expect(good.isError, `${tool}.${field}=${valid}: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });

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

describe('道具の JSON Schema の説明文に、検査と同じ範囲の文字列が入っている（issue #1720 レビュー指摘）', () => {
  it('20件の欄それぞれで、.describe() の文言に formatIntRangeJa(range) がそのまま含まれる', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const seen = new Set<string>();
    for (const { tool, field, range } of cases) {
      const key = `${tool}.${field}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const schema = tools.find((entry) => entry.name === tool)?.inputSchema as
        { properties?: Record<string, { description?: string }> } | undefined;
      const description = schema?.properties?.[field]?.description;
      expect(description, `${key}: JSON Schema にこの欄が無い`).toBeTruthy();
      expect(description, `${key}: 説明文「${description}」に範囲の文言が無い`).toContain(
        formatIntRangeJa(range),
      );
    }
    expect(seen.size).toBe(20);
  });

  it('schedule_create.everyMinutes（PR #1689 対応済み。同じレビュー指摘の対象）', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const schema = tools.find((entry) => entry.name === 'schedule_create')?.inputSchema as
      { properties?: Record<string, { description?: string }> } | undefined;
    const description = schema?.properties?.['everyMinutes']?.description;
    expect(description).toBeTruthy();
    expect(description).toContain(formatIntRangeJa({ min: 1, max: 525_600 }));
  });
});
