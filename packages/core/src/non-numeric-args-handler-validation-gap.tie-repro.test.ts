import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, MCP_INPUT_VALIDATION_ERROR_MARKER } from './tools.js';

/**
 * r1 の横断レビュー（13回目）用の再現テスト。
 *
 * PR #1729（issue #1720）は「数値の欄」だけをハンドラ側の検査へ移し、
 * 「非数値の欄（文字列 `.min()`/`.max()`・配列 `.min()`）」は PR 本文の
 * 表に17件を数え上げたうえで「範囲は数値の欄で閉じる、という指示のとおり、
 * ここは直していない（報告のみ）」と明記している。
 *
 * これは #1729 が作った穴ではなく、意図して範囲外にした既知の残存である。
 * このテストは、その残存が実際に main 上で同じ機構（SDK がハンドラより
 * 手前の JSON Schema 検証で落とし、英語の zod JSON がマーカー付きで返る）
 * で再現することを、配列 `.min(1)` のケースで確かめる。
 *
 * `commitment_open.body`（string `.min(1)`）の単独ケースは
 * `commitment-open-body-min-validation.tie-repro.test.ts` に分けてある。
 *
 * issue #1752 でこの穴を直した。直した後は、下の1本は「マーカーが付か
 * ない・isError が立たない」という緑として通る——テストの中身は issue
 * 本文から1文字も変えていない（期待値も変えていない）。
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
    clientInfo: { name: 'non-numeric-args-handler-validation-gap.tie-repro.test', version: '0' },
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

describe('inbox_remove_many — sources が空配列のときの扱い（配列 .min(1)、#1729 が「範囲外」とした非数値の欄）', () => {
  it('sources=[] は入力スキーマ側の配列 .min(1) で弾かれ、英語の zod の JSON（マーカー付き）が返る', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'inbox_remove_many', {
      types: ['manager_message'],
      sources: [],
      reason: 'x',
      dryRun: true,
    });

    // 【赤の意味】配列の `.min(1)` にも、数値の欄と同じ機構の穴が残っている。
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.isError, result.text).toBe(false);
  });
});
