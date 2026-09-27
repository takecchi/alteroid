import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer, MCP_INPUT_VALIDATION_ERROR_MARKER } from './tools.js';

/**
 * r1 の横断レビュー（13回目）用の再現テスト。
 *
 * PR #1729（issue #1720）は「数値の欄」だけを対象に、入力スキーマ側の
 * `.min()`/`.max()`/`.positive()` をハンドラの先頭へ移した。PR 本文の
 * 「数え上げ（非数値の欄）」の節は、`commitment_open.body` の
 * `z.string().min(1)` を含む17件を「範囲は数値の欄で閉じる、という指示の
 * とおり、ここは直していない（報告のみ）」と明記している。
 *
 * つまりこれは #1729 が作った穴ではなく、#1689 からの既知の残存（意図的に
 * 範囲外とされたもの）。ただし PR #1729 の説明文が「同じ形の穴」と言う
 * 対象（数値引数が範囲外のとき英語の zod の JSON がハンドラより手前で
 * 返ってしまう）が、非数値の欄にもまったく同じ機構で残っていることを
 * 実測で示す。
 *
 * `body` を空文字（`.min(1)` 違反）で `commitment_open` を呼ぶと、SDK が
 * 生成した JSON Schema 側の `minLength: 1` がハンドラより前に落とし、
 * `MCP_INPUT_VALIDATION_ERROR_MARKER` 付きの英語 zod JSON がそのまま返る
 * ——`practice_read.version` / `memory_outline.offset` が #1729 前に
 * 示していたのと同じ形。
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
    clientInfo: { name: 'commitment-open-body-min-validation.tie-repro.test', version: '0' },
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

describe('commitment_open — body が空文字のときの扱い（#1720/#1729 が「範囲外」とした非数値の欄）', () => {
  it('body="" は入力スキーマ側の .min(1) で弾かれ、英語の zod の JSON（マーカー付き）が返る', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);

    const result = await callTool(rpc, 'commitment_open', { body: '' });

    // 【赤の意味】#1729 が数値の欄で塞いだのと同じ穴が、非数値の欄
    // （commitment_open.body の .min(1)）にはまだ残っている。マーカー付きの
    // 英語 zod JSON が返り、日本語の断り文には揃っていない。
    //
    // issue #1752 でこの穴を直した。直した後は、この歯は「マーカーが付か
    // ない・isError が立たない」という緑として通る（テストの中身は issue
    // 本文から1文字も変えていない——期待値も変えていない。直した結果として
    // 元から緑になる形の再現テストである）。
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.isError, result.text).toBe(false);
  });
});
