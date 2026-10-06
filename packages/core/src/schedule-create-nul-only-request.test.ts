import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer } from './tools.js';

/**
 * `schedule_create` の `request` が NUL だけのとき（#3438 と同じ穴の道具の側）。
 *
 * ハンドラの先頭の「空文字」の検査が NUL を落とす前の値で行われ、NUL だけの `request` が通ってしまう。
 * そのあと日誌へ「定期の依頼を設定しようとしている」を書き、ストアは NUL を落として空の依頼を保存しようとして
 * 投げる（fs / pg）か、空の依頼を保存する（メモリ）。検査を NUL を落とした後で行い、日誌より前に断る。
 * 道具の入力スキーマ側に `.min(1)` を足さない理由は `schedule-create-request-validation.test.ts` に在る。
 *
 * MCP の往復（`tools/call`）を通す組み方は `schedule-create-request-validation.test.ts` と同じ。
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
    clientInfo: { name: 'schedule-create-nul-only-request.test', version: '0' },
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

describe('schedule_create — request が NUL だけのとき（#3438 の道具の側）', () => {
  it('日誌へ書く前に断り、日誌にも保存層にも何も残さない', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '\u0000\u0000',
      everyMinutes: 60,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('request');
    expect(result.text).toContain('空');
    expect(result.text).not.toContain('\u0000');
    await expect(stores.schedules.get('probe')).resolves.toBeNull();
    expect(await stores.journal.list({})).toEqual([]);
  });

  it('NUL が混じっても中身が残る request は受ける（NUL は落とされて残る）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '定期\u0000的に確認する',
      everyMinutes: 60,
    });

    expect(result.isError, result.text).toBe(false);
    const stored = await stores.schedules.get('probe');
    expect(stored?.request).toBe('定期的に確認する');
  });
});
