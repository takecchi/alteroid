import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createCloneMcpServer,
  formatArrayLengthJa,
  formatStringLengthJa,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
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
    clientInfo: { name: 'tool-non-numeric-args-handler-validation-1752.test', version: '0' },
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
  invalid: unknown;
  valid: unknown;
  hint: string;
}

const cases: Case[] = [
  {
    label: 'memory_outline.q（文字列 .min(1)）',
    tool: 'memory_outline',
    base: { slug: 'probe' },
    field: 'q',
    invalid: '',
    valid: 'x',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'memory_section_read.sections（配列 .min(1)）',
    tool: 'memory_section_read',
    base: { slug: 'probe' },
    field: 'sections',
    invalid: [],
    valid: ['dummy'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'memory_section_move.sections（配列 .min(1)）',
    tool: 'memory_section_move',
    base: { fromSlug: 'probe-a', toSlug: 'probe-b', summary: '要約' },
    field: 'sections',
    invalid: [],
    valid: ['dummy'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'approval_withdraw.reason（文字列 .min(1)）',
    tool: 'approval_withdraw',
    base: { id: 'ap-1' },
    field: 'reason',
    invalid: '',
    valid: 'y',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'usage_read.tokenId（文字列 .min(1)）',
    tool: 'usage_read',
    base: {},
    field: 'tokenId',
    invalid: '',
    valid: 'tok-1',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_open.body（文字列 .min(1)。issue 本文の再現テスト対象）',
    tool: 'commitment_open',
    base: {},
    field: 'body',
    invalid: '',
    valid: 'やる',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close.reason（文字列 .min(1)）',
    tool: 'commitment_close',
    base: { id: 'c-1' },
    field: 'reason',
    invalid: '',
    valid: 'done',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_edit.body（文字列 .min(1)）',
    tool: 'commitment_edit',
    base: { id: 'c-1' },
    field: 'body',
    invalid: '',
    valid: '直した',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close_many.origin（配列(enum) .min(1)）',
    tool: 'commitment_close_many',
    base: { reason: 'x' },
    field: 'origin',
    invalid: [],
    valid: ['self'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close_many.source（配列 .min(1)。要素は別に測る）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'source',
    invalid: [],
    valid: ['token-pool'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close_many.q（文字列 .min(1)）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'q',
    invalid: '',
    valid: 'y',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close_many.until（文字列 .min(1)）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'until',
    invalid: '',
    valid: '2026-09-15T00:00:00.000Z',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'commitment_close_many.reason（文字列 .min(1)）',
    tool: 'commitment_close_many',
    base: { origin: ['self'] },
    field: 'reason',
    invalid: '',
    valid: 'y',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label:
      'inbox_remove_many.types（共有スキーマ inboxRemoveManyTypesSchema の配列 .min(1)。' +
      'PR #1729 の非数値の欄の表には無かった——今回の読み直しで見つけた）',
    tool: 'inbox_remove_many',
    base: { reason: 'x' },
    field: 'types',
    invalid: [],
    valid: ['manager_message'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'inbox_remove_many.sources（配列 .min(1)。要素は別に測る。issue 本文の再現テスト対象）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'sources',
    invalid: [],
    valid: ['manager:mgr-1'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'inbox_remove_many.before（文字列 .min(1)）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'before',
    invalid: '',
    valid: '2026-09-15T00:00:00.000Z',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'inbox_remove_many.reason（文字列 .min(1)）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'] },
    field: 'reason',
    invalid: '',
    valid: 'y',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'conversation_post.text（文字列 .min(1)）',
    tool: 'conversation_post',
    base: {},
    field: 'text',
    invalid: '',
    valid: 'こんにちは',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'conversation_post.conversationId（文字列 .min(1)）',
    tool: 'conversation_post',
    base: { text: 'こんにちは' },
    field: 'conversationId',
    invalid: '',
    valid: '11111111-1111-1111-1111-111111111111',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'archive_remove_many.sessionIds（配列 .min(1)。要素は別に測る）',
    tool: 'archive_remove_many',
    base: { summary: 'x' },
    field: 'sessionIds',
    invalid: [],
    valid: ['sess-1'],
    hint: formatArrayLengthJa({ min: 1 }),
  },
  {
    label: 'archive_remove_many.before（文字列 .min(1)）',
    tool: 'archive_remove_many',
    base: { summary: 'x' },
    field: 'before',
    invalid: '',
    valid: '2026-09-15T00:00:00.000Z',
    hint: formatStringLengthJa({ min: 1 }),
  },
  {
    label: 'archive_remove_many.summary（文字列 .min(1)）',
    tool: 'archive_remove_many',
    base: {},
    field: 'summary',
    invalid: '',
    valid: 'y',
    hint: formatStringLengthJa({ min: 1 }),
  },
];

describe('道具の非数値引数（22件）— 範囲外は日本語の平文、範囲内は今までどおり通る（issue #1752）', () => {
  it.each(cases)('$label', async ({ tool, base, field, invalid, valid }) => {
    const stores = createMemoryStores();

    const badRpc = await connect(stores);
    const bad = await callTool(badRpc, tool, { ...base, [field]: invalid });
    expect(bad.isError, `${tool}.${field}=${JSON.stringify(invalid)}: ${bad.text}`).toBe(false);
    expect(bad.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(bad.text).toContain(`${field} は使えない`);

    const goodRpc = await connect(stores);
    const good = await callTool(goodRpc, tool, { ...base, [field]: valid });
    expect(good.isError, `${tool}.${field}=${JSON.stringify(valid)}: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });
});

interface ElementCase {
  label: string;
  tool: string;
  base: Record<string, unknown>;
  field: string;
}

const elementCases: ElementCase[] = [
  {
    label: 'commitment_close_many.source（要素の空文字）',
    tool: 'commitment_close_many',
    base: { origin: ['self'], reason: 'x' },
    field: 'source',
  },
  {
    label:
      'inbox_remove_many.sources（要素の空文字。issue 本文の再現テスト対象と同じ配列だが要素側）',
    tool: 'inbox_remove_many',
    base: { types: ['manager_message'], reason: 'x' },
    field: 'sources',
  },
  {
    label: 'archive_remove_many.sessionIds（要素の空文字）',
    tool: 'archive_remove_many',
    base: { summary: 'x' },
    field: 'sessionIds',
  },
];

describe('配列の要素が空文字であってはならない制約（issue #1752）', () => {
  it.each(elementCases)('$label', async ({ tool, base, field }) => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);
    const result = await callTool(rpc, tool, { ...base, [field]: [''] });
    expect(result.isError, `${tool}.${field}=['']: ${result.text}`).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain(`${field} は使えない`);

    const goodRpc = await connect(stores);
    const good = await callTool(goodRpc, tool, { ...base, [field]: ['x'] });
    expect(good.isError, `${tool}.${field}=['x']: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });
});

describe('道具の JSON Schema の説明文に、検査と同じ文言が入っている（issue #1752 レビュー指摘と同型）', () => {
  it('22件の欄それぞれで、.describe() の文言に共有の hint がそのまま含まれる', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const seen = new Set<string>();
    for (const { tool, field, hint } of cases) {
      const key = `${tool}.${field}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const schema = tools.find((entry) => entry.name === tool)?.inputSchema as
        { properties?: Record<string, { description?: string }> } | undefined;
      const description = schema?.properties?.[field]?.description;
      expect(description, `${key}: JSON Schema にこの欄が無い`).toBeTruthy();
      expect(description, `${key}: 説明文「${description}」に制約の文言が無い`).toContain(hint);
    }
    expect(seen.size).toBe(22);
  });
});
