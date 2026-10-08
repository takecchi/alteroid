import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildInboxEventTypesSchema,
  INBOX_EVENT_TYPE_ORDER,
  inboxRemoveManyTypesSchema,
} from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import {
  chunkIdsByChars,
  createCloneMcpServer,
  createCloneTools,
  REMOVE_MANY_JOURNAL_ID_CHARS,
} from './tools.js';

function remover(
  stores: Stores,
  dropQueuedInboxEvents: ((ids: readonly string[]) => Promise<number>) | null = async (ids) =>
    ids.length,
) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(dropQueuedInboxEvents === null ? {} : { dropQueuedInboxEvents }),
  });
  const found = tools.find((entry) => entry.name === 'inbox_remove_many');
  expect(found, 'inbox_remove_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

function soleLineWith(reply: string, marker: string): string {
  const lines = reply.split('\n').filter((line) => line.includes(marker));
  expect(lines, `目印「${marker}」を含む行が1本ではない:\n${reply}`).toHaveLength(1);
  return lines[0]!;
}

const BASE_AT = Date.parse('2026-01-01T00:00:00.000Z');

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

// `evt-N` のような短い id にしない: 250件でも 3,600 文字の予算に収まり、複数の塊に割れることを確かめられないため
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

  describe('人間起点の合図は選べない（MCP の入力検査で弾かれる）', () => {
    interface Rpc {
      call(method: string, params: unknown): Promise<Record<string, unknown>>;
    }

    async function connect(stores: ReturnType<typeof createMemoryStores>): Promise<Rpc> {
      const server = createCloneMcpServer({
        stores,
        emit: () => undefined,
        memoryCause: () => 'clone',
        conversationId: () => undefined,
        dropQueuedInboxEvents: async (ids) => ids.length,
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

    // z.enum を独自に組み直さない: 道具が実際に正しい側を使っていることを示せず、`tools.ts` が参照を差し替えても緑のままになるため
    it('2d. 道具が実際に使う schema（inboxRemoveManyTypesSchema）を直接検査する——差し替えたらここが赤くなる', () => {
      const correctSchema = inboxRemoveManyTypesSchema;
      const mutatedSchema = buildInboxEventTypesSchema(INBOX_EVENT_TYPE_ORDER);

      expect(correctSchema.safeParse(['human_message']).success).toBe(false);
      expect(correctSchema.safeParse(['human_answer']).success).toBe(false);
      expect(correctSchema.safeParse(['manager_message']).success).toBe(true);

      expect(mutatedSchema.safeParse(['human_message']).success).toBe(true);
      expect(mutatedSchema.safeParse(['human_answer']).success).toBe(true);
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

    const rest = (await stores.inbox.peekPending()).entries;
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

    const rest = (await stores.inbox.peekPending()).entries;
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

    const rest = (await stores.inbox.peekPending()).entries;
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

  describe.each([
    { label: '秒あり', before: '2026-02-01T00:00:00.000Z', removes: true },
    { label: '秒なし（Z）', before: '2026-02-01T00:00Z', removes: true },
    { label: '秒なし（+09:00）', before: '2026-02-01T09:00+09:00', removes: true },
    { label: '壊れた値', before: '2026-02-01T25:99Z', removes: false },
  ])('7b. before の書き方: $label', ({ before, removes }) => {
    it(removes ? '境界ちょうどの行まで消し、1ms 後の行は残す' : '1件も消さない', async () => {
      const stores = createMemoryStores();
      const atBoundary = managerEvent(0, { at: '2026-02-01T00:00:00.000Z' } as Partial<InboxEvent>);
      const afterBoundary = managerEvent(1, {
        at: '2026-02-01T00:00:00.001Z',
      } as Partial<InboxEvent>);
      await putAll(stores, [atBoundary, afterBoundary]);

      const reply = await remover(stores)({
        types: ['manager_message'],
        before,
        reason: 'before の書き方',
        dryRun: false,
      });

      expect(reply.includes(`before に渡された「${before}」は日時として読めない`)).toBe(!removes);

      const rest = (await stores.inbox.peekPending()).entries;
      expect(rest.map((r) => r.event.id)).toEqual(removes ? ['evt-1'] : ['evt-0', 'evt-1']);
    });
  });

  describe.each([
    '2026-02-01T00:00',
    '2026-02-01T00:00:00',
    '2026/02/01',
    'Feb 1 2026',
    '2026-02-01',
  ])('7c. 時差の無い before: %s', (before) => {
    it('断り、当たる行があっても1件も消さない', async () => {
      const stores = createMemoryStores();
      const event = managerEvent(0, { at: '2026-01-01T00:00:00.000Z' } as Partial<InboxEvent>);
      await putAll(stores, [event]);

      const reply = await remover(stores)({
        types: ['manager_message'],
        before,
        reason: '時差の無い before',
        dryRun: false,
      });

      expect(reply).toContain(`before に渡された「${before}」`);
      expect(reply).toContain('時差');
      expect((await stores.inbox.peekPending()).entries.map((r) => r.event.id)).toEqual(['evt-0']);
    });
  });

  it('7d. 時差の付いた before（小数秒・-05:00 を含む）は通る', async () => {
    for (const before of ['2026-02-01T00:00:00.123+09:00', '2026-01-31T19:00-05:00']) {
      const stores = createMemoryStores();
      const event = managerEvent(0, { at: '2026-01-01T00:00:00.000Z' } as Partial<InboxEvent>);
      await putAll(stores, [event]);

      await remover(stores)({
        types: ['manager_message'],
        before,
        reason: '時差の付いた before',
        dryRun: false,
      });

      expect((await stores.inbox.peekPending()).entries, before).toEqual([]);
    }
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

    const rest = (await stores.inbox.peekPending()).entries;
    expect(rest.map((r) => r.event.id)).toEqual(['evt-2', 'evt-3', 'evt-4']);
    expect(soleLineWith(reply, '1回の上限')).toContain('残り 3 件');
  });

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

    for (const text of texts) expect(text).toContain('消した id: ');

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
      const remaining = (await stores.inbox.peekPending()).entries;
      expect(
        remaining.some((r) => r.event.id === id),
        id,
      ).toBe(false);
    }
    for (const id of chunks[2]!) {
      const remaining = (await stores.inbox.peekPending()).entries;
      expect(
        remaining.some((r) => r.event.id === id),
        id,
      ).toBe(true);
    }
  });

  it('12. 2つ目以降の塊が丸ごと競合になっても、応答の N は日誌の行の数と一致する', async () => {
    const stores = createMemoryStores();
    const events = Array.from({ length: 250 }, (_, i) => managerEventWithUuid(i));
    await putAll(stores, events);
    const allIds = events.map((event) => event.id);
    // 予算の値を手で書き写さない: 本物の `REMOVE_MANY_JOURNAL_ID_CHARS` を変えても追随せず、歯が緑のままになるため
    const chunksExpected = chunkIdsByChars(allIds, REMOVE_MANY_JOURNAL_ID_CHARS);
    expect(chunksExpected.length).toBeGreaterThanOrEqual(2);

    const originalRemoveMany = stores.inbox.removeMany.bind(stores.inbox);
    let calls = 0;
    stores.inbox.removeMany = async (ids: readonly string[]) => {
      calls += 1;
      if (calls > 1) await originalRemoveMany(ids);
      return originalRemoveMany(ids);
    };

    const reply = await remover(stores)({
      types: ['manager_message'],
      reason: '250件を一括で畳んだ',
      dryRun: false,
    });

    expect(
      calls,
      'removeMany が2回以上呼ばれていない＝道具は実際には複数の塊に割っていない' +
        '（この前提が崩れると、下のアサーションは競合が1回も起きなくても緑になりうる）',
    ).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(chunksExpected.length);

    const claimed = /全 id は日誌に (\d+) 件に分けて残してある/.exec(reply);
    expect(claimed, '省略の断り書きが出ていない（20件を超えて消していない）').not.toBeNull();
    const chunkEntries = (await decisionTexts(stores)).filter((text) => text.includes('塊目'));
    expect(chunkEntries.length).toBeGreaterThan(0);
    expect(chunkEntries.length).toBeLessThan(calls);
    expect(Number(claimed?.[1])).toBe(chunkEntries.length);
  });
});

describe('消した合図の配達も止める（issue #1049）', () => {
  it('実際に消えた id が、そのまま配達停止の口へ渡る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 3; i += 1) {
      const event = managerEvent(i);
      await stores.inbox.put(event, event.at);
    }
    const seen: string[][] = [];

    const reply = await remover(stores, async (ids) => {
      seen.push([...ids]);
      return ids.length;
    })({ types: ['manager_message'], reason: '配達も止める', dryRun: false });

    expect(seen).toEqual([['evt-0', 'evt-1', 'evt-2']]);
    expect(soleLineWith(reply, '配達の待ち行列からも外したのは')).toContain('3 件');
  });

  it('試算（dryRun）では配達停止の口を1度も呼ばない（1件も消していないので止める対象が無い）', async () => {
    const stores = createMemoryStores();
    const event = managerEvent(0);
    await stores.inbox.put(event, event.at);
    const seen: string[][] = [];

    await remover(stores, async (ids) => {
      seen.push([...ids]);
      return ids.length;
    })({ types: ['manager_message'], reason: '試算' });

    expect(seen).toEqual([]);
  });

  it('配達を止める口が配線されていなければ、1件も消さずに断る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 3; i += 1) {
      const event = managerEvent(i);
      await stores.inbox.put(event, event.at);
    }

    const reply = await remover(
      stores,
      null,
    )({
      types: ['manager_message'],
      reason: '配線が無い',
      dryRun: false,
    });

    expect(reply).toContain('1件も消していない');
    expect(await stores.inbox.pending()).toMatchObject({ count: 3 });
  });
});
