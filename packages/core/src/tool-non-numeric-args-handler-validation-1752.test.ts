import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import {
  createCloneMcpServer,
  formatArrayLengthJa,
  formatStringLengthJa,
  formatWorkKindRangeJa,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
} from './tools.js';

/**
 * issue #1752（PR #1729・issue #1720 の続き。13回目の横断レビュー）。
 *
 * PR #1729 は `createCloneTools()` の52個の道具のうち、**数値の欄**だけを
 * 対象に、入力スキーマ側の型以外の制約（`.int()`/`.min()`/`.max()`/
 * `.positive()`）をハンドラの先頭へ移した。同 PR の本文は「非数値の欄
 * （文字列 `.min()`/`.max()`・配列 `.min()`）は範囲外」として17件を報告
 * だけに留めていた——SDK がハンドラより前に検証するため、範囲外の値を渡すと
 * 英語の zod の JSON（`MCP_INPUT_VALIDATION_ERROR_MARKER` 付き）がそのまま
 * 返る同じ穴が、非数値の欄にも残っていた。
 *
 * ここではその欄を（PR #1729 の報告に加えて、独自に読み直して見つかった
 * `inbox_remove_many.types` を含めて）25件、(1) 範囲外の値では日本語の
 * 平文が返りマーカーが付かないこと (2) 範囲内の値は今までどおり通ること
 * を測る。
 *
 * `workKind`（`commitment_close` / `commitment_appraise` / `manager_appraise`
 * の3道具が使う共有スキーマ `workKindSchema`）は3件とも含む——道具ごとに
 * 検査の呼び出し口が違う（`describeWorkKindViolation` を呼ぶ場所がそれぞれ
 * 違う）ため、1件だけ測って残り2件を構造的な根拠に委ねると、揃え忘れが
 * 個別に起きたときに気づけない。
 *
 * ## なぜ `tools.test.ts` の `harness.call()` では足りないか
 *
 * `tool-numeric-args-handler-validation-1720.test.ts` と同じ理由——
 * `harness.call()` は `entry.handler(args)` を直接叩くので、JSON の往復も
 * zod の検査も通らない。入力スキーマ側の制約を外したことを見るには、本物の
 * MCP の往復（`tools/call`）を通す必要がある。
 */

interface Rpc {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}

async function connect(
  stores: ReturnType<typeof createMemoryStores>,
  managers?: ManagerPool,
): Promise<Rpc> {
  const server = createCloneMcpServer({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === undefined ? {} : { managers }),
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

/** `manager_appraise` は `context.managers` が無いと `NO_POOL` を即返すので、
 * `appraise()` だけを実装した最小のダブルを渡す（`tools.test.ts` の
 * `as unknown as ManagerPool` と同じ手）。
 */
function minimalManagerPool(): ManagerPool {
  return {
    async appraise() {
      return { outcome: 'appraised' as const, detail: 'ok', previous: null };
    },
  } as unknown as ManagerPool;
}

/**
 * 1行が1欄を測る。`base` はその道具を呼ぶのに要る他の引数（`field` を混ぜた
 * ときにだけ検査が働くよう、常に有効な値にしてある）。`invalid` は制約に
 * 反する値（空文字・空配列）、`valid` は制約を満たす境界値そのもの。
 * `hint` は `.describe()` 側にも同じ文言で載っているはずの共有の言い方
 * （`formatStringLengthJa` / `formatArrayLengthJa` / `formatWorkKindRangeJa`
 * の戻り値そのもの）。
 */
interface Case {
  label: string;
  tool: string;
  base: Record<string, unknown>;
  field: string;
  invalid: unknown;
  valid: unknown;
  hint: string;
  managers?: () => ManagerPool;
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
    label: 'commitment_close.workKind（共有スキーマ workKindSchema の .min(1).max(128)）',
    tool: 'commitment_close',
    base: { id: 'c-1', reason: 'done' },
    field: 'workKind',
    invalid: '',
    valid: '実装',
    hint: formatWorkKindRangeJa(),
  },
  {
    label: 'commitment_appraise.workKind（共有スキーマ workKindSchema）',
    tool: 'commitment_appraise',
    base: { id: 'c-1', appraisal: 'good' },
    field: 'workKind',
    invalid: '',
    valid: '実装',
    hint: formatWorkKindRangeJa(),
  },
  {
    label: 'manager_appraise.workKind（共有スキーマ workKindSchema）',
    tool: 'manager_appraise',
    base: { managerId: 'mgr-1', appraisal: 'good' },
    field: 'workKind',
    invalid: '',
    valid: '実装',
    hint: formatWorkKindRangeJa(),
    managers: minimalManagerPool,
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

describe('道具の非数値引数（25件）— 範囲外は日本語の平文、範囲内は今までどおり通る（issue #1752）', () => {
  it.each(cases)('$label', async ({ tool, base, field, invalid, valid, managers }) => {
    const stores = createMemoryStores();

    // --- 範囲外 ---
    const badRpc = await connect(stores, managers?.());
    const bad = await callTool(badRpc, tool, { ...base, [field]: invalid });
    expect(bad.isError, `${tool}.${field}=${JSON.stringify(invalid)}: ${bad.text}`).toBe(false);
    expect(bad.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    // **`field` 単独ではなく `${field} は使えない` まで見る。** 欄名だけを
    // 見ると、この道具の別の断り文（絞り込みの漏斗など）が偶然その欄名を
    // 含んでいるだけで緑になる——実際に `commitment_close_many.origin` は
    // 検査を丸ごと外しても、`funnel` の行が無条件に `origin=[...]` を含む
    // ため `toContain('origin')` だけでは生存を見逃した（変異試験で発見。
    // PR 本文に実測を書く）。`describeStringLengthViolation` /
    // `describeArrayLengthViolation` / `describeWorkKindViolation` の断り文は
    // すべて「${field} は使えない（…）。」の形で揃えてあるので、ここまで
    // 見れば偶然の一致では緑にならない。
    expect(bad.text).toContain(`${field} は使えない`);

    // --- 範囲内（境界値そのもの） ---
    const goodRpc = await connect(stores, managers?.());
    const good = await callTool(goodRpc, tool, { ...base, [field]: valid });
    // **範囲内の値が「範囲外」に化けていないこと。**
    expect(good.isError, `${tool}.${field}=${JSON.stringify(valid)}: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });
});

/**
 * `z.array(z.string().min(1))` のうち**要素側**の制約（配列そのものの件数
 * ではなく、各要素が空文字であってはならないという制約）を別表で測る。
 * `commitment_close_many.source` / `inbox_remove_many.sources` /
 * `archive_remove_many.sessionIds` の3件が該当する（元は
 * `z.array(z.string().min(1)).min(1)` だった）。
 *
 * 上の `cases` は配列そのものが空（`[]`）のケースを測っている——ここでは
 * 配列は1件以上あるが、その要素に空文字が混じっている（`['']`）ケースを
 * 測る。2つは別の制約なので、別の表にする。
 */
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
    // **`field` 単独ではなく `${field} は使えない` まで見る**（上の主表と
    // 同じ理由——欄名だけでは他の断り文の偶然の一致を見逃す）。
    expect(result.text).toContain(`${field} は使えない`);

    // --- 比較対象: 要素が空文字でなければ今までどおり通る ---
    const goodRpc = await connect(stores);
    const good = await callTool(goodRpc, tool, { ...base, [field]: ['x'] });
    expect(good.isError, `${tool}.${field}=['x']: ${good.text}`).toBe(false);
    expect(good.text).not.toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
  });
});

/**
 * レビュー指摘（issue #1720 の PR #1729）と同じ形の後退が、非数値の欄でも
 * 起こりうる——入力スキーマ側から `.min()`/`.max()` を外すと、モデルへ配る
 * JSON Schema（`tools/list` が返す `inputSchema`）からも `minLength`/
 * `maxLength`/`minItems` が消える。
 *
 * ここでは、上の `cases` が持つ `hint`（ハンドラの先頭の検査に渡している
 * のと同じ文字列——`formatStringLengthJa` / `formatArrayLengthJa` /
 * `formatWorkKindRangeJa` の戻り値そのもの）が、`.describe()` の説明文に
 * そのまま含まれていることを測る。値を2箇所に手で書き写すのではなく関数を
 * 共有しているので、どちらか一方だけ直して食い違う（#923 と同じ形の腐り）
 * ことは構造的に起きない——この歯が測っているのは「その共有をやめて
 * いないか」である。
 */
describe('道具の JSON Schema の説明文に、検査と同じ文言が入っている（issue #1752 レビュー指摘と同型）', () => {
  it('25件の欄それぞれで、.describe() の文言に共有の hint がそのまま含まれる', async () => {
    const rpc = await connect(createMemoryStores(), minimalManagerPool());
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
    // **表そのものが空にすり替わっていないこと。**
    expect(seen.size).toBe(25);
  });
});
