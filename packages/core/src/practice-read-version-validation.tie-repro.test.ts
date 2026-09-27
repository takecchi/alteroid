import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, MCP_INPUT_VALIDATION_ERROR_MARKER } from './tools.js';

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
    clientInfo: { name: 'practice-read-version-validation.tie-repro.test', version: '0' },
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

describe('practice_read — version が不正なときの扱い（#1651/#1689 の揃え漏れ）', () => {
  it('version=0 は入力スキーマ側で弾かれ、英語の zod の JSON（マーカー付き）が返る（slug と形が食い違う）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const invalidSlug = await callTool(rpc, 'practice_read', { slug: 'Invalid Slug!' });
    expect(invalidSlug.isError, invalidSlug.text).toBe(false);
    expect(invalidSlug.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);

    const invalidVersion = await callTool(rpc, 'practice_read', { slug: 'ok-slug', version: 0 });
    expect(invalidVersion.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(invalidVersion.isError, invalidVersion.text).toBe(false);
  });
});

describe('memory_outline — offset/q が不正なときの扱い（#1651/#1689 の揃え漏れ、別の道具での同型）', () => {
  it('offset=-1 は入力スキーマ側で弾かれ、英語の zod の JSON（マーカー付き）が返る（slug と形が食い違う）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const missingSlug = await callTool(rpc, 'memory_outline', { slug: 'not-exist' });
    expect(missingSlug.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);

    const invalidOffset = await callTool(rpc, 'memory_outline', {
      slug: 'not-exist',
      offset: -1,
    });
    expect(invalidOffset.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(invalidOffset.isError, invalidOffset.text).toBe(false);
  });
});
