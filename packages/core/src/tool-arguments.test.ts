import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneMcpServer } from './tools.js';

/**
 * 「長い引数の後ろに置いた引数が届かない」を、道具の側で観測しにいくテスト。
 *
 * ## 何を疑って書いたか
 *
 * クローンから「長い値を持つ引数を渡すと、その後ろの引数が届かず、エラーは
 * 届かなかった側（後ろ）を名指しする」という観測が上がった（`journal_write` の
 * `decision`/`grounds` で1ターンに11回、`memory_append` の
 * `slug`/`content`/`summary` で1回）。**この道具の側にその経路があるかを、
 * 実際に通して確かめるためのテストである。**
 *
 * ## なぜ `tools.test.ts` の足場では足りないか
 *
 * `tools.test.ts` の `harness.call()` は `entry.handler(args)` を直接叩く。
 * つまり **JSON の往復も zod の検査も通らない** ので、「引数がどう届くか」を
 * 見る足場になっていない。ここでは `createCloneMcpServer()` が組む本物の
 * MCP サーバへ `tools/call` を投げ、**JSON-RPC の往復 → 入力検査 → ハンドラ**
 * という本番と同じ1本道を通す。
 *
 * ## トランスポートを自前で持つ理由
 *
 * `@modelcontextprotocol/sdk` の `InMemoryTransport` を使うにはこのパッケージへ
 * 依存を1本足すことになる。ここで要るのは「メッセージを入れて出す」だけなので、
 * Transport の口（`start`/`send`/`close`/`onmessage`）を満たす最小の器を置く。
 *
 * **往復の両方向で `JSON.parse(JSON.stringify(...))` を通すこと。** ここを
 * 素通し（オブジェクト参照の受け渡し）にすると、直列化の順序や長さに依存する
 * 壊れ方があっても踏まない ＝ 見にいったはずのものを見ない足場になる。
 */

interface Rpc {
  call(method: string, params: unknown): Promise<Record<string, unknown>>;
}

/** 本物の MCP サーバを組み、JSON の往復を通す口を返す。 */
async function connect(stores: ReturnType<typeof createMemoryStores>): Promise<Rpc> {
  const server = createCloneMcpServer({ stores, emit: () => undefined });
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

/** `tools/call` を投げ、返ってきた本文と失敗フラグを平らにして返す。 */
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

/**
 * 長い値。**改行・引用符・バックスラッシュ・波括弧・日本語・絵文字を混ぜる。**
 * 「長さ」だけを疑うと、直列化を壊す文字の側の壊れ方を踏まない。
 */
const LONG = Array.from(
  { length: 400 },
  (_, i) => `${i}行目: 長い値である。"引用" と 'クオート' と \\ と { } と 🙂 を含む。`,
).join('\n');

const SHORT = '短い値';

/**
 * 記憶へ書いた本文が、保存された後にどう読み戻るか（`PersonaStore.write` の
 * 契約。`store.ts`）——末尾の改行が正規化される。
 *
 * **実装の `ensureTrailingNewline` を呼ばずに、期待値の側で書き直してある。**
 * 同じ関数を突き合わせの両側で使うと、その関数を壊す変異で両側が同時に動き、
 * この歯が鳴らなくなる（`.claude/skills/mutation-testing/SKILL.md`「比較の
 * 両側が同じ経路で同じ値へ強制されると、比較そのものが恒真になる」）。
 *
 * **ここは長さではなく1文字ずつの一致を測る歯なので、契約を織り込んでもなお
 * `toBe` のままである** —— 末尾の1文字を足す以外の欠けは、いままでどおり撃つ。
 * **以前ここは正規化を織り込まずに緑だった** —— 当たっているのがインメモリ実装
 * だけで、それだけが正規化していなかったからである（#370）。
 */
const asStored = (content: string): string => (content.endsWith('\n') ? content : `${content}\n`);

describe('クローンの道具に渡した引数は、長さと位置によらず全部届く', () => {
  it('長い値がどの位置にあっても、後ろの引数まで1文字も欠けずに届く（journal_write）', async () => {
    // 位置を変えた3通り。**クローンが観測した表と同じ並びである。**
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
      // **`toBe` で突き合わせる（長さの比較にしない）。** 長さだけ見ると
      // 「同じ長さの別物」を通してしまう。
      expect(written?.type === 'decision' ? written.decision : undefined).toBe(decision);
      expect(written?.type === 'decision' ? written.grounds : undefined).toBe(grounds);
    }
  });

  it('長い値がどの位置にあっても、後ろの引数まで1文字も欠けずに届く（memory_append）', async () => {
    // 3引数の道具では、長い値を**先頭・真ん中・最後**の全部の位置に置く。
    // **`slug` には長い値を置けない。** `memorySlugSchema`（`schema.ts:25-29`）が
    // 128 文字までと決めているので、先頭の位置は「規約上いちばん長い slug」で当てる
    // ——ここだけは「長い」の桁が違うことを承知のうえで書いている。
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

  /**
   * 長さの閾値と、直列化を壊しうる文字の両方に当てる。
   *
   * **「長い引数の後ろが落ちる」を疑うなら、長さだけを疑ってはいけない。**
   * 制御文字・引用符・バックスラッシュ・波括弧・絵文字（サロゲートペア）・
   * 全角は、どれも「JSON にすると1文字が1文字でなくなる」側の文字である。
   * 混ぜたうえで桁を上げていき、**どの桁でも後続の引数が欠けない**ことを見る。
   */
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

  /**
   * **ここが「引数が届かなかった」の見分け方そのものである。**
   *
   * 引数が本当に届かなかったとき、応答は `received undefined` と言う。
   * `undefined` は「鍵ごと無かった」という意味で、道具が受け取ってから
   * 落としたのではなく、**呼び出しの JSON にその鍵が最初から無かった**ことを指す。
   * 道具の側でこの文言を作れる箇所は無い（入力検査より手前で加工する層が無い）。
   */
  it('引数が本当に欠けたときは、欠けた引数を名指しして received undefined と返る', async () => {
    const rpc = await connect(createMemoryStores());
    const result = await callTool(rpc, 'journal_write', { decision: SHORT });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('grounds');
    expect(result.text).toContain('received undefined');
  });

  /**
   * モデルへ配る宣言（JSON Schema）の側にも歯を当てる。
   *
   * **`required` が落ちると、引数を省いてよいという宣言になる。** 実装（zod）が
   * 必須のままでも、モデルが見るのはこちらなので「省く → 検査で落ちる」を
   * 誘発する。ここは道具の側で守れる数少ない場所である。
   */
  it('必須の引数は、モデルへ配る JSON Schema でも required になっている', async () => {
    const rpc = await connect(createMemoryStores());
    const response = await rpc.call('tools/list', {});
    const tools = (response['result'] as { tools: { name: string; inputSchema: unknown }[] }).tools;

    const expected: Record<string, string[]> = {
      journal_write: ['decision', 'grounds'],
      memory_append: ['slug', 'content', 'summary'],
      memory_write: ['slug', 'content', 'summary'],
      memory_delete: ['slug', 'summary'],
    };

    for (const [name, fields] of Object.entries(expected)) {
      const found = tools.find((entry) => entry.name === name);
      expect(found, `${name} が配られていない`).toBeDefined();
      const schema = found?.inputSchema as { required?: string[]; properties?: object };
      expect(schema.required?.slice().sort(), `${name} の required`).toEqual(fields.slice().sort());
      // 説明が消えるとモデルは何を入れる欄か分からなくなる（配る側の欠落）。
      for (const field of fields) {
        const property = (schema.properties as Record<string, { description?: string }>)[field];
        expect(property?.description, `${name}.${field} の説明`).toBeTruthy();
      }
    }
  });
});
