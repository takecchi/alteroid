import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, MCP_INPUT_VALIDATION_ERROR_MARKER } from './tools.js';

/**
 * Issue #1651。
 *
 * HTTP の `scheduleBody`（`apps/daemon/src/app.ts`）は `request: z.string().min(1)`
 * だが、クローンの道具（`tools.ts` の `schedule_create`）は `.min(1)` を持たず
 * `z.string()` だけだった。空文字の `request` はそのまま `stores.schedules.put(plan)`
 * まで届き、fs / pg の実装は `scheduledRequestSchema.parse(entry)` が投げる
 * ZodError をそのままクローンへ返していた（メモリ実装は検査を持たないので
 * 静かに保存していた——器によって結果が違う）。
 *
 * ## なぜ `tools.test.ts` の `harness.call()` では測れないか
 *
 * `harness.call()` は `entry.handler(args)` を直接叩くので、JSON の往復も
 * zod の検査も通らない（`tool-arguments.test.ts` の doc と同じ理由）。
 * `.min(1)` は道具の入力スキーマの側に足したので、それが効くのを見るには
 * 本物の MCP の往復（`tools/call`）を通す必要がある——ここではそれを
 * 最小限に自前で組む（`tool-arguments.test.ts` と同じ手）。
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
    | { content?: { type: string; text?: string }[]; isError?: boolean }
    | undefined;
  if (result === undefined) {
    return { isError: true, text: JSON.stringify(response['error']) };
  }
  return {
    isError: result.isError === true,
    text: (result.content ?? []).map((block) => block.text ?? '').join(''),
  };
}

describe('schedule_create — request が空文字のときの扱い（issue #1651）', () => {
  it('空文字の request は保存層を呼ぶ前に弾かれる（MCP 入力検査で落ちる）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'schedule_create', {
      kind: 'probe',
      request: '',
      everyMinutes: 60,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('request');

    // **保存層に触れていないことの直接の証拠。** ハンドラが実行されていれば
    // `stores.schedules.put(plan)` まで届き、メモリ実装は検査を持たないので
    // 静かに保存してしまう——ここが `null` のままであることが「保存層を
    // 呼んでいない」の証拠になる。
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
});
