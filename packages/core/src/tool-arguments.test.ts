import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createCloneMcpServer,
  GROUNDS_NOT_DELIVERED,
  MCP_INPUT_VALIDATION_ERROR_MARKER,
} from './tools.js';

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
    clientInfo: { name: 'tool-arguments.test', version: '0' },
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

const LONG = Array.from(
  { length: 400 },
  (_, i) => `${i}行目: 長い値である。"引用" と 'クオート' と \\ と { } と 🙂 を含む。`,
).join('\n');

const SHORT = '短い値';

// 実装の ensureTrailingNewline を呼ばない: 突き合わせの両側で同じ関数を使うと、それを壊す変異で両側が同時に動き比較が恒真になるため
const asStored = (content: string): string => (content.endsWith('\n') ? content : `${content}\n`);

describe('クローンの道具に渡した引数は、長さと位置によらず全部届く', () => {
  it('長い値がどの位置にあっても、後ろの引数まで1文字も欠けずに届く（journal_write）', async () => {
    const cases: { label: string; decision: string; grounds: string }[] = [
      { label: '短→長（長が最後）', decision: SHORT, grounds: LONG },
      { label: '長→短（長が先頭）', decision: LONG, grounds: SHORT },
      { label: '長→長（両方長い）', decision: LONG, grounds: LONG },
    ];

    for (const { label, decision, grounds } of cases) {
      const stores = createMemoryStores();
      const rpc = await connect(stores);
      const result = await callTool(rpc, 'journal_write', { decision, grounds });

      expect(result.isError, `${label}: 呼び出しが失敗した（${result.text}）`).toBe(false);

      const entries = await stores.journal.list({ limit: 10 });
      const written = entries.find((entry) => entry.type === 'decision');
      expect(written, `${label}: 日誌に残っていない`).toBeDefined();
      expect(written?.type === 'decision' ? written.decision : undefined).toBe(decision);
      expect(written?.type === 'decision' ? written.grounds : undefined).toBe(grounds);
    }
  });

  it('長い値がどの位置にあっても、後ろの引数まで1文字も欠けずに届く（memory_append）', async () => {
    const LONGEST_SLUG = 'a'.repeat(128);
    const cases: { label: string; slug: string; content: string; summary: string }[] = [
      { label: '短→短→長', slug: 'probe', content: SHORT, summary: LONG },
      { label: '短→長→短（クローンが踏んだ形）', slug: 'probe', content: LONG, summary: SHORT },
      { label: '短→長→長', slug: 'probe', content: LONG, summary: LONG },
      { label: '最長 slug→長→短', slug: LONGEST_SLUG, content: LONG, summary: SHORT },
    ];

    for (const { label, slug, content, summary } of cases) {
      const stores = createMemoryStores();
      const rpc = await connect(stores);
      const result = await callTool(rpc, 'memory_append', { slug, content, summary });

      expect(result.isError, `${label}: 呼び出しが失敗した（${result.text}）`).toBe(false);

      const doc = await stores.persona.read(slug);
      expect(doc?.content, `${label}: 本文が届いていない`).toBe(asStored(content));

      const entries = await stores.journal.list({ limit: 10 });
      const written = entries.find((entry) => entry.type === 'memory_update');
      expect(written?.type === 'memory_update' ? written.summary : undefined).toBe(summary);
    }
  });

  it('長さの閾値は無い（10万字＋制御文字を混ぜても後続の引数は欠けない）', async () => {
    const specials =
      String.fromCharCode(10, 13, 9, 34, 92, 123, 125, 91, 93, 58, 44) + ' \u{1F642}〒ｱあa1';

    for (const size of [1_000, 10_000, 100_000]) {
      const value = specials.repeat(Math.ceil(size / specials.length)).slice(0, size);
      const stores = createMemoryStores();
      const rpc = await connect(stores);
      const result = await callTool(rpc, 'memory_append', {
        slug: 'probe',
        content: value,
        summary: SHORT,
      });

      expect(result.isError, `${size}字: 呼び出しが失敗した（${result.text}）`).toBe(false);
      const doc = await stores.persona.read('probe');
      expect(doc?.content, `${size}字: 本文が届いていない`).toBe(asStored(value));
      const entries = await stores.journal.list({ limit: 10 });
      const written = entries.find((entry) => entry.type === 'memory_update');
      expect(
        written?.type === 'memory_update' ? written.summary : undefined,
        `${size}字: 後続の summary が届いていない`,
      ).toBe(SHORT);
    }
  });

  it('引数が本当に欠けたときは、欠けた引数を名指しして received undefined と返る', async () => {
    const rpc = await connect(createMemoryStores());
    const result = await callTool(rpc, 'memory_delete', { slug: SHORT });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('summary');
    expect(result.text).toContain('received undefined');
  });

  it('欠落の断り文は、MCP の往復を通って呼ぶ側まで届く（#1141）', async () => {
    const rpc = await connect(createMemoryStores());
    const result = await callTool(rpc, 'memory_delete', { slug: SHORT });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('呼び出しの生の形');
    expect(result.text).toContain('タグの接頭辞の脱落');
  });

  it('MCP SDK の入力検証エラーの文言は、alteroid が検知に使う印を含む（issue #1338 残件1）', async () => {
    const rpc = await connect(createMemoryStores());
    const result = await callTool(rpc, 'memory_delete', { slug: SHORT });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('memory_delete');
    expect(result.text).toContain('"path"');
    expect(result.text).toContain('summary');
  });

  it('grounds が届かなくても判断は残り、「根拠なし」とは別の文言で区別される（#1338）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);
    const result = await callTool(rpc, 'journal_write', { decision: SHORT });

    expect(result.isError, `落ちてはならない: ${result.text}`).toBe(false);

    const entries = await stores.journal.list({ limit: 10 });
    const written = entries.find((entry) => entry.type === 'decision');
    expect(written, '判断が日誌に残っていない').toBeDefined();
    expect(written?.type === 'decision' ? written.decision : undefined).toBe(SHORT);

    const grounds = written?.type === 'decision' ? written.grounds : '';
    expect(grounds).toBe(GROUNDS_NOT_DELIVERED);
    expect(grounds).not.toBe('根拠なし');
    expect(result.text).toContain('grounds が呼び出しに届かなかった');
  });

  it('grounds は、モデルへ配る JSON Schema でも required ではない（#1338）', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const schema = tools.find((t) => t.name === 'journal_write')?.inputSchema as
      { required?: string[]; properties?: Record<string, unknown> } | undefined;

    expect(schema?.required).toEqual(['decision']);
    expect(Object.keys(schema?.properties ?? {})).toContain('grounds');
  });

  it('必須の引数は、モデルへ配る JSON Schema でも required になっている', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const expected: Record<string, string[]> = {
      journal_write: ['decision'],
      memory_append: ['slug', 'content', 'summary'],
      memory_write: ['slug', 'content', 'summary'],
      memory_delete: ['slug', 'summary'],
      commitment_close_many: ['origin', 'reason'],
    };

    for (const [name, fields] of Object.entries(expected)) {
      const found = tools.find((entry) => entry.name === name);
      expect(found, `${name} が配られていない`).toBeDefined();
      const schema = found?.inputSchema as { required?: string[]; properties?: object };
      expect(schema.required?.slice().sort(), `${name} の required`).toEqual(fields.slice().sort());
      for (const field of fields) {
        const property = (schema.properties as Record<string, { description?: string }>)[field];
        expect(property?.description, `${name}.${field} の説明`).toBeTruthy();
      }
    }
  });

  it("memory_outline の side は口の検査を通って 'tail' が渡る（列挙の外は弾かれる）", async () => {
    const rpc = await connect(createMemoryStores());

    const tail = await callTool(rpc, 'memory_outline', { slug: 'nope', side: 'tail' });
    expect(tail.isError).toBe(false);
    expect(tail.text).toContain('存在しない');

    const bare = await callTool(rpc, 'memory_outline', { slug: 'nope' });
    expect(bare.isError).toBe(false);
    expect(bare.text).toContain('存在しない');

    const bad = await callTool(rpc, 'memory_outline', { slug: 'nope', side: 'middle' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('side');
  });
});

describe('道具に無い引数は黙って捨てずに断る', () => {
  it('ask_human に options を渡すと断られ、選択肢の無い承認待ちは積まれない', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);
    const result = await callTool(rpc, 'ask_human', {
      question: 'デプロイ先を決めたい',
      options: [{ id: 'target', label: 'デプロイ先', choices: ['railway', 'fly'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expect(result.text).toContain('この道具に無い引数: options（近い名前: questions）');
    expect((await stores.jobs.listApprovals()).entries).toEqual([]);
  });

  it('ask_human の questions は通り、選択肢ごと承認待ちに積まれる', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);
    const questions = [
      {
        id: 'target',
        prompt: 'デプロイ先は？',
        options: [
          { id: 'railway', label: 'Railway' },
          { id: 'fly', label: 'Fly.io' },
        ],
      },
    ];
    const result = await callTool(rpc, 'ask_human', {
      question: 'デプロイ先を決めたい',
      questions,
    });

    expect(result.isError, result.text).toBe(false);
    const { entries } = await stores.jobs.listApprovals();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.questions).toEqual(questions);
  });

  it('ask_human に限らず、どの道具でも知らない引数は断る（journal_write）', async () => {
    const stores = createMemoryStores();
    const rpc = await connect(stores);
    const result = await callTool(rpc, 'journal_write', {
      decision: '決めた',
      grounds: '根拠',
      reason: '道具に無い引数',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('この道具に無い引数: reason');
    expect(await stores.journal.list({ limit: 10 })).toEqual([]);
  });
});
