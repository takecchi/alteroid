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
 *
 * ## 追記（#1651 の後始末。PR #1656 のクロスレビュー指摘）
 *
 * #1656 は上の `.min(1)` を**道具の入力スキーマ**（`z` の shape）に足した。
 * これは SDK の `tool()` がハンドラを呼ぶ**前**に検証するので、保存層には
 * 届かなくなった（この点は直っている）——が、失敗時の応答が兄弟の欄
 * （`kind` など。ハンドラの先頭で `safeParse` して日本語の平文を返す）とは
 * 別の形になった。SDK が投げる `McpError` を素通しした結果、
 * `MCP_INPUT_VALIDATION_ERROR_MARKER`（`Input validation error: Invalid
 * arguments for tool …`）に続く**英語の zod の JSON**がそのまま返る。
 * 下の最初の `it` は、直す前（#1656 の実装のまま）は
 * `MCP_INPUT_VALIDATION_ERROR_MARKER` を含む・`isError: true` を期待して
 * いたが、ここでは**期待を反転**させ、`kind` と同じ形（ハンドラの先頭で
 * 弾く・日本語の平文・`isError` は立てない）を期待するよう書き換えた
 * （AGENTS.md「テストを弱めずに直す」——テストは消さず、保存層に届かない
 * ことを見る保証はそのまま。弱くなっていないのは、以前は「マーカー付きの
 * 英語のエラーが返ること」しか保証していなかったのに対し、今回は「日本語
 * の平文が返ること」に加えて「保存層を1文字も呼ばないこと」の両方を保証
 * する点である）。
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

    // **兄弟の欄（`kind` など）と同じ形。** ハンドラの先頭で弾き、
    // `isError` は立てず、日本語の平文だけを返す。SDK の入力検証に
    // 弾かれて英語の zod の JSON がそのまま返る形（マーカー付き）には
    // ならない。
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('request');
    expect(result.text).toContain('空');

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

    // **形（shape）を比較する——文言の一致は求めない。** 直す前は
    // `emptyRequest` だけが `isError: true` かつ英語の zod の JSON
    // （マーカー付き）で、`invalidKind` は `isError` を立てない日本語の
    // 平文だった。この非対称が今回の指摘の芯である。
    expect(emptyRequest.isError).toBe(invalidKind.isError);
    expect(emptyRequest.text.includes(MCP_INPUT_VALIDATION_ERROR_MARKER)).toBe(
      invalidKind.text.includes(MCP_INPUT_VALIDATION_ERROR_MARKER),
    );
  });
});
