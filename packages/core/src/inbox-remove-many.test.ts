import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CLONE_REMOVABLE_INBOX_EVENT_TYPES, INBOX_EVENT_TYPE_ORDER } from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent, Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { chunkIdsByChars, createCloneMcpServer, createCloneTools } from './tools.js';

/**
 * `inbox_remove_many`（issue #972。takecchi が「(A) 出所で線を引く」を採用、
 * 2026-09-15）の一括削除を固定する。`commitment-close-many.test.ts`（#844）と
 * 同じ作法——文言ではなく実状態（`stores.inbox` を読み直した結果・日誌の
 * 実データ）で測る。
 *
 * **この道具固有の主題は「人間起点の合図（`human_message` / `human_answer`）を
 * 選べないこと」である。** #972 のコメントでオーナー（クローン）が示した線引き
 * （「クローンは、自分の側の都合で溜まった合図だけを畳める。人間から届いた
 * 合図は畳めない」）を、型（zod の enum）で塞いでいることを実際に通して測る。
 */

/** その `stores` に配線した `inbox_remove_many` を呼ぶ関数を返す。 */
function remover(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'inbox_remove_many');
  expect(found, 'inbox_remove_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/** 日誌に積まれた `decision` の本文だけを取り出す。 */
async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

/** `commitment-close-many.test.ts` の `soleLineWith` と同じもの（複製）。 */
function soleLineWith(reply: string, marker: string): string {
  const lines = reply.split('\n').filter((line) => line.includes(marker));
  expect(lines, `目印「${marker}」を含む行が1本ではない:\n${reply}`).toHaveLength(1);
  return lines[0]!;
}

const BASE_AT = Date.parse('2026-01-01T00:00:00.000Z');

/** `index` 番目の行を古い順に並ぶ時刻で作る（1秒ずつずらす）。 */
function managerEvent(index: number, overrides: Partial<InboxEvent> = {}): InboxEvent {
  return {
    type: 'manager_message',
    id: `evt-${index}`,
    at: new Date(BASE_AT + index * 1000).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text: `429（${index}）`,
    ...overrides,
  } as InboxEvent;
}

/**
 * `managerEvent` と同じだが、id に `randomUUID()` を使う——チャンク分割の歯
 * （9・11番）専用。**`evt-N` のような短い id では、250件でも 3,600 文字の
 * 予算に収まってしまい「実際に複数の塊に割れること」を確かめられない**
 * （`commitment-close-many.test.ts` の `entryAt` が id に `randomUUID()` を
 * 使っているのと同じ理由——本番の id も `randomUUID()` 由来である）。
 */
function managerEventWithUuid(index: number): InboxEvent {
  return {
    type: 'manager_message',
    id: randomUUID(),
    at: new Date(BASE_AT + index * 1000).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text: `429（${index}）`,
  };
}

async function putAll(stores: Stores, events: readonly InboxEvent[]): Promise<void> {
  for (const event of events) await stores.inbox.put(event, event.at);
}

describe('inbox_remove_many（絞り込みでの一括削除。issue #972）', () => {
  it('1. 選べる5種類全部を並べた呼びは断り、未読は1件も変わらない', async () => {
    const stores = createMemoryStores();
    const events = [
      managerEvent(0),
      { type: 'distill', id: 'e-distill', at: '2026-01-01T00:00:01.000Z', reason: 'shutdown' },
      { type: 'timer', id: 'e-timer', at: '2026-01-01T00:00:02.000Z', kind: 'daily_report' },
      {
        type: 'external',
        id: 'e-external',
        at: '2026-01-01T00:00:03.000Z',
        source: 'webhook',
      },
      {
        type: 'self_initiative',
        id: 'e-self',
        at: '2026-01-01T00:00:04.000Z',
        reason: '暇なので',
      },
    ] as InboxEvent[];
    await putAll(stores, events);

    const reply = await remover(stores)({
      types: ['distill', 'timer', 'external', 'self_initiative', 'manager_message'],
      reason: '全部畳んだつもりだった',
      dryRun: false,
    });

    expect(reply.length).toBeGreaterThan(0);
    expect(await stores.inbox.pending()).toMatchObject({ count: 5 });
  });

  /**
   * 🔴 2. 人間起点の合図（`human_message` / `human_answer`）は、そもそも
   * `types` の値になりえない——**型（zod の enum）で塞がれている**ことを、
   * 直接ハンドラを叩く（zod を経由しない）形ではなく、本物の MCP サーバへ
   * `tools/call` を投げる経路で確かめる（`tool-arguments.test.ts` と同じ理由
   * ——直接ハンドラ呼びだと zod の検査そのものを通らない）。
   */
  describe('人間起点の合図は選べない（MCP の入力検査で弾かれる）', () => {
    /** `tool-arguments.test.ts` の `connect`/`callTool` と同じもの（複製）。 */
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
        clientInfo: { name: 'inbox-remove-many.test', version: '0' },
      });
      deliver?.({ jsonrpc: '2.0', method: 'notifications/initialized' });

      return { call };
    }

    async function callTool(
      rpc: Rpc,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string; protocolError: boolean }> {
      const response = await rpc.call('tools/call', { name, arguments: args });
      const result = response['result'] as
        { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
      if (result === undefined) {
        return { isError: true, protocolError: true, text: JSON.stringify(response['error']) };
      }
      return {
        isError: result.isError === true,
        protocolError: false,
        text: (result.content ?? []).map((block) => block.text ?? '').join(''),
      };
    }

    it('2a. types: ["human_message"] は MCP の入力検査で弾かれ、1件も消えない', async () => {
      const stores = createMemoryStores();
      await stores.inbox.put(
        {
          type: 'human_message',
          id: 'evt-human',
          at: '2026-01-01T00:00:00.000Z',
          text: '人間の発言',
          conversationId: 'conv-1',
        },
        '2026-01-01T00:00:00.000Z',
      );

      const rpc = await connect(stores);
      const result = await callTool(rpc, 'inbox_remove_many', {
        types: ['human_message'],
        reason: '人間の発言を畳みたい',
        dryRun: false,
      });

      // zod の enum に無い値なので、道具のハンドラへは届かず、SDK 自身が
      // 「入力検査で落とした」ことを名乗るエラー（isError: true、`types` の
      // 妥当な値の一覧を含む）として返る（実測: `MCP error -32602:
      // Input validation error … "path": ["types", 0] …
      // "message": "Invalid option: expected one of …"`）。
      expect(result.isError).toBe(true);
      expect(result.text).toContain('types');
      expect(result.text).toContain('Invalid option');
      expect(result.text).not.toContain('human_message');
      expect(await stores.inbox.pending()).toMatchObject({ count: 1 });
    });

    it('2b. types: ["human_answer"] も同様に弾かれる', async () => {
      const stores = createMemoryStores();
      await stores.inbox.put(
        {
          type: 'human_answer',
          id: 'evt-answer',
          at: '2026-01-01T00:00:00.000Z',
          approvalId: 'appr-1',
          answer: 'yes',
        },
        '2026-01-01T00:00:00.000Z',
      );

      const rpc = await connect(stores);
      const result = await callTool(rpc, 'inbox_remove_many', {
        types: ['human_answer'],
        reason: '人間の回答を畳みたい',
        dryRun: false,
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('types');
      expect(result.text).toContain('Invalid option');
      expect(await stores.inbox.pending()).toMatchObject({ count: 1 });
    });

    it('2c. 選べる種類（manager_message）は同じ経路で正常に通る（2a/2bの弾かれ方が種類そのものの拒否によることの対照）', async () => {
      const stores = createMemoryStores();
      await stores.inbox.put(managerEvent(0), managerEvent(0).at);

      const rpc = await connect(stores);
      const result = await callTool(rpc, 'inbox_remove_many', {
        types: ['manager_message'],
        reason: '委譲の写しを畳む',
        dryRun: false,
      });

      expect(result.isError).toBe(false);
      expect(await stores.inbox.pending()).toMatchObject({ count: 0 });
    });

    /**
     * 🔴 2d. 【変異試験・機序の裏付け】
     *
     * 2a/2b が守っているのは「道具の `types` の zod スキーマが
     * `CLONE_REMOVABLE_INBOX_EVENT_TYPES` を指していること」1行である
     * （`tools.ts` の該当箇所を `z.enum(INBOX_EVENT_TYPE_ORDER)`
     * ——人間起点を含む全7種——へ差し替えたら、2a/2b は赤くなる）。
     *
     * **その「差し替えたら赤くなる」を、実際に `tools.ts` を書き換えて確かめる
     * ことはこの器ではできない**——差し替えること自体がこの保護を弱める操作
     * そのものであり、たとえ検証のための一時的な変更でも、この環境の安全側の
     * 分類器が「セキュリティを弱める編集」として拒否する（実測: `tools.ts`
     * の `z.enum(CLONE_REMOVABLE_INBOX_EVENT_TYPES)` を
     * `z.enum(INBOX_EVENT_TYPE_ORDER)` へ書き換えようとしたところ、Edit が
     * `[Security Weaken]` で拒否された。元に戻す方向の編集は通った）。
     *
     * ⟹ **ここでは同じ zod のセマンティクスを、本番コードに触れずに再現して
     * 示す。** `CLONE_REMOVABLE_INBOX_EVENT_TYPES` と `INBOX_EVENT_TYPE_ORDER`
     * は両方とも export された実装の値そのもの（ベタ書きしていない）なので、
     * **どちらかの定義が変われば、この歯もそれに追随して測り直す**。
     * 「差し替えたら何が起きるか」という機序の理解が正しいことを、ここで
     * 固定する——「実際に tools.ts がどちらを使っているか」は 2a/2b/2c
     * （本物の MCP round-trip）が保証する側であり、ここでは保証しない。
     */
    it('2d. 【変異試験の裏付け】schema を INBOX_EVENT_TYPE_ORDER へ差し替えていたら human_message/human_answer は通ってしまう（本番コードは書き換えていない。機序の証明）', () => {
      const correctSchema = z.enum(CLONE_REMOVABLE_INBOX_EVENT_TYPES);
      const mutatedSchema = z.enum(INBOX_EVENT_TYPE_ORDER);

      // いまの実装（CLONE_REMOVABLE_INBOX_EVENT_TYPES）は人間起点を拒む。
      expect(correctSchema.safeParse('human_message').success).toBe(false);
      expect(correctSchema.safeParse('human_answer').success).toBe(false);
      // 選べる5種類は通す（拒んでいるのは人間起点の2種だけであることの対照）。
      expect(correctSchema.safeParse('manager_message').success).toBe(true);

      // もし INBOX_EVENT_TYPE_ORDER（全7種）へ差し替えていたら、
      // 人間起点も通ってしまう——これが 2a/2b が実際に踏んでいる境界である。
      expect(mutatedSchema.safeParse('human_message').success).toBe(true);
      expect(mutatedSchema.safeParse('human_answer').success).toBe(true);
    });
  });

  it('3. dryRun を省いた呼びは、当たる行があっても1件も消さない', async () => {
    const stores = createMemoryStores();
    const event = managerEvent(0);
    await stores.inbox.put(event, event.at);

    await remover(stores)({ types: ['manager_message'], reason: '試算のつもり' });

    expect(await stores.inbox.pending()).toMatchObject({ count: 1 });
  });

  it('4. dryRun: false は当たった行だけを消し、他の種類は無傷', async () => {
    const stores = createMemoryStores();
    const target = managerEvent(0);
    const other: InboxEvent = {
      type: 'timer',
      id: 'e-timer',
      at: '2026-01-01T00:00:05.000Z',
      kind: 'daily_report',
    };
    await putAll(stores, [target, other]);

    await remover(stores)({
      types: ['manager_message'],
      reason: '確認して畳んだ',
      dryRun: false,
    });

    const rest = await stores.inbox.peekPending();
    expect(rest.map((r) => r.event.id)).toEqual(['e-timer']);
  });

  it('5. sources は完全一致——別の送信元を巻き込まない', async () => {
    const stores = createMemoryStores();
    const exact = managerEvent(0, { managerId: 'mgr-a' } as Partial<InboxEvent>);
    const near = managerEvent(1, { managerId: 'mgr-ab' } as Partial<InboxEvent>);
    await putAll(stores, [exact, near]);

    await remover(stores)({
      types: ['manager_message'],
      sources: ['manager:mgr-a'],
      reason: 'mgr-a だけ',
      dryRun: false,
    });

    const rest = (await stores.inbox.peekPending()) as PendingInboxEvent[];
    expect(rest.map((r) => r.event.id)).toEqual(['evt-1']);
  });

  it('6. before は「その瞬間ちょうど」を含み、それより後は含まない', async () => {
    const stores = createMemoryStores();
    const boundary = '2026-02-01T00:00:00.000Z';
    const atBoundary = managerEvent(0, { at: boundary } as Partial<InboxEvent>);
    const afterBoundary = managerEvent(1, {
      at: '2026-02-01T00:00:00.001Z',
    } as Partial<InboxEvent>);
    await putAll(stores, [atBoundary, afterBoundary]);

    await remover(stores)({
      types: ['manager_message'],
      before: boundary,
      reason: 'before で絞った',
      dryRun: false,
    });

    const rest = await stores.inbox.peekPending();
    expect(rest.map((r) => r.event.id)).toEqual(['evt-1']);
  });

  it('7. before が ISO8601 として読めない呼びは、当たる行があっても1件も消さない', async () => {
    const stores = createMemoryStores();
    const event = managerEvent(0);
    await stores.inbox.put(event, event.at);

    await remover(stores)({
      types: ['manager_message'],
      before: 'きのう',
      reason: '読めない before',
      dryRun: false,
    });

    expect(await stores.inbox.pending()).toMatchObject({ count: 1 });
  });

  it('8. limit は古い側から limit 件だけを消し、残りは残す。戻り値に残件数が出る', async () => {
    const stores = createMemoryStores();
    const events = [0, 1, 2, 3, 4].map((i) => managerEvent(i));
    await putAll(stores, events);

    const reply = await remover(stores)({
      types: ['manager_message'],
      limit: 2,
      reason: '上限を試す',
      dryRun: false,
    });

    const rest = await stores.inbox.peekPending();
    expect(rest.map((r) => r.event.id)).toEqual(['evt-2', 'evt-3', 'evt-4']);
    expect(soleLineWith(reply, '1回の上限')).toContain('残り 3 件');
  });

  /**
   * 🔴 9. 消した id が全部日誌に在ること（issue #972 の要求そのもの）。
   * `commitment-close-many.test.ts` の 11 番と同じ作法。
   */
  it('9. 250件を一括で消すと、消した id が全部・過不足なく日誌に残る（2件以上に分割）', async () => {
    const REMOVE_MANY_JOURNAL_ID_CHARS_COPY = 3_600;
    const stores = createMemoryStores();
    const events = Array.from({ length: 250 }, (_, i) => managerEventWithUuid(i));
    await putAll(stores, events);
    const allIds = events.map((event) => event.id);

    await remover(stores)({
      types: ['manager_message'],
      reason: '250件を一括で畳んだ',
      dryRun: false,
    });

    expect(await stores.inbox.pending()).toMatchObject({ count: 0 });

    const texts = await decisionTexts(stores);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const seen = new Set<string>();
    for (const text of texts) {
      const idsPart = text.slice(text.indexOf('消した id: ') + '消した id: '.length);
      for (const id of idsPart.split(' ')) if (id.length > 0) seen.add(id);
    }
    expect(seen.size).toBe(allIds.length);
    expect(seen).toEqual(new Set(allIds));

    for (const text of texts) {
      const idsPart = text.slice(text.indexOf('消した id: ') + '消した id: '.length);
      expect(idsPart.length).toBeLessThanOrEqual(REMOVE_MANY_JOURNAL_ID_CHARS_COPY + 10);
    }
  });

  it('10. 1件も消せなかった塊では日誌へ書かない（他の経路が先に消していた形を模す）', async () => {
    const stores = createMemoryStores();
    const events = [managerEvent(0), managerEvent(1), managerEvent(2)];
    await putAll(stores, events);

    const raced: Stores = {
      ...stores,
      inbox: {
        ...stores.inbox,
        removeMany: () => Promise.resolve([]),
      },
    };

    await remover(raced)({
      types: ['manager_message'],
      reason: '消したつもりだった',
      dryRun: false,
    });

    expect(await decisionTexts(stores)).toEqual([]);
  });

  it('11. 塊の途中で日誌が落ちると throw し、①最初の塊の id は日誌に残り ②途中まで消した行は消したまま', async () => {
    const stores = createMemoryStores();
    const events = Array.from({ length: 250 }, (_, i) => managerEventWithUuid(i));
    await putAll(stores, events);
    const allIds = events.map((event) => event.id);
    const chunks = chunkIdsByChars(allIds, 3_600);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    let calls = 0;
    const flaky: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) => {
          calls += 1;
          if (calls >= 2) return Promise.reject(new Error('日誌が落ちた（テスト用）'));
          return stores.journal.append(entry);
        },
      },
    };

    await expect(
      remover(flaky)({ types: ['manager_message'], reason: '途中で落ちた', dryRun: false }),
    ).rejects.toThrow();

    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(1);

    for (const id of [...chunks[0]!, ...chunks[1]!]) {
      const remaining = await stores.inbox.peekPending();
      expect(
        remaining.some((r) => r.event.id === id),
        id,
      ).toBe(false);
    }
    for (const id of chunks[2]!) {
      const remaining = await stores.inbox.peekPending();
      expect(
        remaining.some((r) => r.event.id === id),
        id,
      ).toBe(true);
    }
  });
});
