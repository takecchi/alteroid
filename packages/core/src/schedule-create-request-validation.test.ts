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
    clientInfo: { name: 'schedule-create-request-validation.test', version: '0' },
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

describe('schedule_create — request が空文字のときの扱い（issue #1651）', () => {
  it('空文字の request は保存層を呼ぶ前に弾かれ、日本語の平文で返る（英語の zod の JSON を返さない）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '',
      everyMinutes: 60,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('request');
    expect(result.text).toContain('空');

    await expect(stores.schedules.get('probe')).resolves.toBeNull();
  });

  it('比較対象: 非空の request は今までどおり通る', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期的に確認する',
      everyMinutes: 60,
    });

    expect(result.isError, result.text).toBe(false);
    const stored = await stores.schedules.get('probe');
    expect(stored?.request).toBe('定期的に確認する');
  });

  it('空文字の request の応答は、不正な kind の応答と同じ形（マーカー無し・isError 無し）である', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const emptyRequest = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '',
      everyMinutes: 60,
    });
    const invalidKind = await callTool(rpc, 'schedule_create', {
      kind: 'ダメな名前',
      request: '定期的に確認する',
      everyMinutes: 60,
    });

    expect(emptyRequest.isError).toBe(invalidKind.isError);
    expect(emptyRequest.text.includes(MCP_INPUT_VALIDATION_ERROR_MARKER)).toBe(
      invalidKind.text.includes(MCP_INPUT_VALIDATION_ERROR_MARKER),
    );
  });
});

describe('schedule_create — everyMinutes が 0 / 負の数 / 非整数のときの扱い（issue #1651 と同じ穴）', () => {
  it('0 は保存層を呼ぶ前に弾かれ、日本語の平文で返る（英語の zod の JSON を返さない）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期的に確認する',
      everyMinutes: 0,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('everyMinutes');

    await expect(stores.schedules.get('probe')).resolves.toBeNull();
  });

  it('負の数も同様に断られる', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期的に確認する',
      everyMinutes: -5,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('everyMinutes');

    await expect(stores.schedules.get('probe')).resolves.toBeNull();
  });

  it('非整数（小数）も同様に断られる', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期的に確認する',
      everyMinutes: 1.5,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('everyMinutes');

    await expect(stores.schedules.get('probe')).resolves.toBeNull();
  });

  it('比較対象: 1以上の整数は今までどおり通る', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期的に確認する',
      everyMinutes: 30,
    });

    expect(result.isError, result.text).toBe(false);
    const stored = await stores.schedules.get('probe');
    expect(stored?.spec).toEqual({ type: 'every', minutes: 30 });
  });
});
