import { beforeEach, describe, expect, it } from 'vitest';

import { createCloneMcpServer, createCloneTools } from '@alteroid/core';

// `@alteroid/core` の公開面に出ていない内部定数の値を複製する: 更新されたら core 側のテストが先に赤くなるため
const MCP_INPUT_VALIDATION_ERROR_MARKER = 'Input validation error: Invalid arguments for tool ';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createFsStores } from './index.js';

interface Rpc {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}

async function connect(stores: ReturnType<typeof createFsStores>): Promise<Rpc> {
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
    clientInfo: { name: 'tool-input-validation-1651.test (fs)', version: '0' },
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

function toolHandler(tools: ReturnType<typeof createCloneTools>, name: string) {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`ツール ${name} が無い`);
  return found.handler;
}

describe('schedule_create / practice_* — issue #1651 の fs 実装での確認', () => {
  let stores: ReturnType<typeof createFsStores>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
  });

  it('schedule_create: 空文字の request はハンドラの先頭で断られ、日本語の平文で返り、fs の保存層に何も残らない', async () => {
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

  it('schedule_create: everyMinutes が 0 / 負の数 / 非整数はハンドラの先頭で断られ、日本語の平文で返り、fs の保存層に何も残らない（issue #1651 と同じ穴。マネージャーの追加指摘）', async () => {
    const rpc = await connect(stores);

    for (const everyMinutes of [0, -5, 1.5]) {
      const result = await callTool(rpc, 'schedule_create', {
        kind: 'probe',
        request: '定期的に確認する',
        everyMinutes,
      });

      expect(result.isError, result.text).toBe(false);
      expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
      expect(result.text).toContain('everyMinutes');

      await expect(stores.schedules.get('probe')).resolves.toBeNull();
    }
  });

  it('practice_write: 形式不正な slug は例外を投げず、「スラッグが不正」と返り、保存層に何も残らない', async () => {
    const invalidSlug = 'Invalid Slug!';
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const handler = toolHandler(tools, 'practice_write');
    const result = await handler(
      { slug: invalidSlug, kind: '調査', title: '題', content: '本文' } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    const responseText = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(responseText).toContain('スラッグが不正');

    await expect(stores.practices.read(invalidSlug)).resolves.toBeNull();
    await expect(stores.practices.listVersions(invalidSlug)).resolves.toEqual([]);
  });

  it('practice_read / practice_history / practice_remove: 形式不正な slug は「スラッグが不正」と返る', async () => {
    const invalidSlug = 'Invalid Slug!';
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });

    const readResult = await toolHandler(tools, 'practice_read')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    const readText = (readResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(readText).toContain('スラッグが不正');

    const historyResult = await toolHandler(tools, 'practice_history')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    const historyText = (historyResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(historyText).toContain('スラッグが不正');

    const removeResult = await toolHandler(tools, 'practice_remove')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    const removeText = (removeResult.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(removeText).toContain('スラッグが不正');
  });
});
