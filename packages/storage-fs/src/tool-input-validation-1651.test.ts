import { beforeEach, describe, expect, it } from 'vitest';

import { createCloneMcpServer, createCloneTools } from '@alteroid/core';

/**
 * `packages/core/src/tools.ts` の `MCP_INPUT_VALIDATION_ERROR_MARKER` と同じ
 * 値。**このパッケージの公開面（`@alteroid/core` の `index.ts`）には出ていない**
 * ——`tools.js` の内部定数で、他パッケージへ広げるのはこの PR の範囲外だと
 * 判断し、値をここへ複製した（更新されたら `tool-arguments.test.ts` /
 * `schedule-create-request-validation.test.ts` 側の歯が先に赤くなる）。
 */
const MCP_INPUT_VALIDATION_ERROR_MARKER = 'Input validation error: Invalid arguments for tool ';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createFsStores } from './index.js';

/**
 * Issue #1651（fs 実装に対する確認）。
 *
 * `packages/core/src/schedule-create-request-validation.test.ts` /
 * `packages/core/src/practice-tools.test.ts`（「形式不正な slug は保存層を
 * 呼ぶ前に断る」の節）と同じ入力を、**本物の fs 実装**に対して当てる。
 *
 * 直す前は
 * - `schedule_create` に空文字の `request` を渡すと `stores.schedules.put()`
 *   まで届き、fs の `scheduledRequestSchema.parse(entry)` が ZodError を
 *   素で投げていた（`packages/storage-fs/src/schedules.ts`）。
 * - `practice_write` に形式不正な slug を渡すと `stores.practices.write()`
 *   まで届き、`practiceSchema.parse()` が同じく ZodError を投げていた
 *   （`packages/storage-fs/src/practices.ts`）。
 * - `practice_read` / `practice_history` / `practice_remove` は fs には
 *   検査が無いので投げなかったが、pg（別ファイル）とは違う「無い」という
 *   応答になっていた——器によって結果が違う、が Issue の芯である。
 *
 * ここでは「例外にならず、保存層に何も残らない」ことを直接確かめる
 * （fs はファイルなので、`stores.*.get/read` で読み直して確認する）。
 */

/**
 * `schedule_create` の `request` は道具の**入力スキーマ**の側で
 * `z.string()` としか宣言していない（空文字を弾く判定はハンドラの先頭に
 * 移した——下の追記を見よ）ので、`entry.handler(args)` を直接叩く形
 * （`tools.test.ts` の harness と同じ）でも素通りせずに検査へ入る。
 * それでもここでは本物の MCP の往復（`tools/call`）を通す最小の
 * トランスポートを自前で組んで確かめる——JSON の往復を経由しないと
 * 見えない食い違い（`tool-arguments.test.ts` の doc と同じ理由）が
 * 他の欄にも将来出うるため、経路そのものは変えない。
 *
 * ## 追記（#1651 の後始末。PR #1656 のクロスレビュー指摘）
 *
 * 当初（#1656）は `request: z.string().min(1)` を**入力スキーマ**の側に
 * 足していた。これだと SDK の `tool()` がハンドラを呼ぶ**前**に検証し、
 * 落ちたときの応答が英語の zod の JSON（`MCP_INPUT_VALIDATION_ERROR_MARKER`
 * 付き）になる——`practice_*` の slug 検査などハンドラの先頭で断る兄弟の
 * 欄とは違う形だった。下の最初の `it` は、直す前は
 * `MCP_INPUT_VALIDATION_ERROR_MARKER` を含むことを期待していたが、ここでは
 * **期待を反転**させ、日本語の平文（マーカー無し）を期待するよう書き換えた
 * （AGENTS.md「テストを弱めずに直す」——「保存層に何も残らないこと」の保証は
 * そのまま残し、それに加えて「クローンに読める日本語で返ること」も保証する
 * ようになったので、保証は弱くなっていない）。
 */
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

    // **`isError` は立てない——兄弟の欄（`kind` など）と同じ形。**
    // 直す前（#1656 のまま）はここが `isError: true` かつ
    // `MCP_INPUT_VALIDATION_ERROR_MARKER` 付きの英語の zod の JSON だった
    // （SDK の入力検証がハンドラより先に落ちていたため）。期待を反転させた
    // 理由と、保証が弱くなっていないことの説明は上のファイル冒頭の追記に
    // 書いた。
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('request');
    expect(result.text).toContain('空');

    // **保存層に何も残らないこと——ここは変わらない保証。** fs の
    // `scheduledRequestSchema` 自身も `request: z.string().min(1)` を持つ
    // ので（`packages/core/src/schema.ts`）、道具側の判定が万一素通りしても
    // fs 側が最後の網として ZodError を投げる（その場合はこの `it` 自体が
    // 例外で落ちて赤くなる——「保存層に空文字が届かない」ことは、道具の
    // 判定と fs 側の判定の**両方**で保証されている）。
    await expect(stores.schedules.get('probe')).resolves.toBeNull();
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
