import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Stores } from './store.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const SAFE_OUTPUT = 20_000;

function tools(stores: Stores) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function fillJournal(stores: Stores, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: `[mgr-${i}] ${'長い報告本文。'.repeat(120)}`,
    });
  }
}

describe('journal_read', () => {
  it('件数を上限まで頼んでも、MCP の出力上限で丸ごと落ちない', async () => {
    const stores = createMemoryStores();
    await fillJournal(stores, 200);
    const call = tools(stores);

    const reply = await call('journal_read', { limit: 200 });

    expect(reply.length).toBeLessThan(SAFE_OUTPUT);
    expect(reply).toContain('件は省略');
    expect(reply).toContain('journal_read id=');
  });

  it('本文を切っても、いつ・どの型か・id は残る（探せる形で切る）', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: `[mgr-7f4206d8/report] ${'x'.repeat(5_000)}`,
    });
    const call = tools(stores);

    const reply = await call('journal_read', { limit: 20 });

    expect(reply).toContain(entry.at);
    expect(reply).toContain('[exchange manager/inbound]');
    expect(reply).toContain(`id=${entry.id}`);
    expect(reply).toContain('[mgr-7f4206d8/report]');
    expect(reply).toContain('文字省略');
  });

  it('until で過去の一点へ届く（新しい分に押し流されない）', async () => {
    const stores = createMemoryStores();
    const target = await stores.journal.append({
      type: 'decision',
      decision: '掘り当てたい1件',
      grounds: '記憶',
    });
    await tick();
    await fillJournal(stores, 100);
    const call = tools(stores);

    const withoutUntil = await call('journal_read', { limit: 20 });
    expect(withoutUntil).not.toContain('掘り当てたい1件');

    const withUntil = await call('journal_read', { limit: 20, until: target.at });
    expect(withUntil).toContain('掘り当てたい1件');
  });

  it('since と types でも絞れる', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '古い判断', grounds: '記憶' });
    await tick();
    const border = new Date().toISOString();
    await stores.journal.append({ type: 'decision', decision: '新しい判断', grounds: '記憶' });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間の発言',
    });
    const call = tools(stores);

    const since = await call('journal_read', { since: border });
    expect(since).toContain('新しい判断');
    expect(since).not.toContain('古い判断');

    const typed = await call('journal_read', { types: ['decision'] });
    expect(typed).toContain('新しい判断');
    expect(typed).not.toContain('人間の発言');
  });

  it('id で全文が取れ、長ければ続きの取り方が出る', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: `先頭の目印${'y'.repeat(10_000)}末尾の目印`,
    });
    const call = tools(stores);

    const head = await call('journal_read', { id: entry.id });
    expect(head).toContain('先頭の目印');
    expect(head).toContain(`journal_read id=${entry.id} offset=`);
    expect(head).not.toContain('末尾の目印');

    const offset = Number(/offset=(\d+)/.exec(head)?.[1]);
    const rest = await call('journal_read', { id: entry.id, offset });
    expect(rest).toContain('末尾の目印');
  });

  it('無い id を聞かれたら、無いと答える（黙って空を返さない）', async () => {
    const call = tools(createMemoryStores());
    expect(await call('journal_read', { id: 'no-such-entry' })).toContain('無い');
  });

  it('条件に当たらないときと、日誌が空のときを取り違えない', async () => {
    const stores = createMemoryStores();
    const call = tools(stores);
    expect(await call('journal_read', {})).toContain('日誌はまだ空');

    await stores.journal.append({ type: 'decision', decision: '何か', grounds: '記憶' });
    expect(await call('journal_read', { types: ['daily_report'] })).toContain('当たる日誌は無い');
  });

  it('worker_wait は空回りが目で分かる1行として出る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'worker_wait',
      openedAt: '2026-08-20T00:00:00.000Z',
      tasks: 3,
      turns: 41,
      byCause: { input: 1, notification: 3, continuation: 37 },
      toolless: 38,
      notifications: 3,
      submits: 0,
      settled: true,
    });
    const call = tools(stores);

    const reply = await call('journal_read', { types: ['worker_wait'] });
    expect(reply).toContain('作業者 3 体を待つあいだに 41 ターン');
    expect(reply).toContain('通知 3');
    expect(reply).toContain('自己継続 37');
    expect(reply).toContain('話しかけ 1');
    expect(reply).toContain('38 ターンは道具を1つも動かしていない');
  });

  it('turn_usage は cache read/write が潰されずに1行として出て、reset の印は隠れない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'turn_usage',
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: {
        'claude-fable-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 120,
          cacheCreationInputTokens: 40,
          webSearchRequests: 0,
          costUsd: 0.5,
        },
      },
      reset: { fromCostUsd: 5, toCostUsd: 3 },
    });
    const call = tools(stores);

    const reply = await call('journal_read', { types: ['turn_usage'] });
    expect(reply).toContain('read=120');
    expect(reply).toContain('write=40');
    expect(reply).toContain('⚠reset');
    expect(reply).toContain('数え直しを挟んだ回');
  });
});

describe('journal_read — q で本文を語で探す（issue #250）', () => {
  it('本文にその語を含む行だけを返す（大文字小文字を区別しない部分一致）', async () => {
    const stores = createMemoryStores();
    const call = tools(stores);

    await stores.journal.append({
      type: 'decision',
      decision: 'トマトの水やりを1日1回にする',
      grounds: '前回の観測',
    });
    await tick();
    await stores.journal.append({
      type: 'decision',
      decision: 'ナスの支柱を立てる',
      grounds: '前回の観測',
    });
    await tick();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'TOMATO は英語で書いても残る',
    });

    const hit = await call('journal_read', { q: 'トマト' });
    expect(hit).toContain('トマトの水やりを1日1回にする');
    expect(hit).not.toContain('ナスの支柱を立てる');

    const lowered = await call('journal_read', { q: 'tomato' });
    expect(lowered).toContain('TOMATO は英語で書いても残る');
  });

  it('他の絞り（types）と併用できる', async () => {
    const stores = createMemoryStores();
    const call = tools(stores);

    await stores.journal.append({
      type: 'decision',
      decision: '収穫はトマトから始める',
      grounds: '熟し具合',
    });
    await tick();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: 'トマトはいつ収穫する？',
    });

    const reply = await call('journal_read', { q: 'トマト', types: ['decision'] });
    expect(reply).toContain('収穫はトマトから始める');
    expect(reply).not.toContain('トマトはいつ収穫する？');
  });

  it('当たらなかったら、探す対象に入っていない欄が在ることまで言う', async () => {
    const stores = createMemoryStores();
    const call = tools(stores);

    await stores.journal.append({
      type: 'tool_use',
      actor: 'clone',
      tool: 'Bash',
      input: { command: 'echo ナス' },
    });

    const reply = await call('journal_read', { q: 'ナス' });
    expect(reply).toContain('"ナス" に当たる日誌は無い');
    expect(reply).toContain('tool_use の input');
    expect(reply).toContain(
      'tool_use の input・worker_wait・turn_usage・context_usage・inbox_flow・github_observation',
    );
    expect(reply).not.toContain('日誌はまだ空');
  });

  it('q が未指定なら絞らない（既存の呼びは1文字も変わらない）', async () => {
    const stores = createMemoryStores();
    const call = tools(stores);

    await stores.journal.append({
      type: 'decision',
      decision: 'トマトの水やり',
      grounds: 'a',
    });
    await tick();
    await stores.journal.append({ type: 'decision', decision: 'ナスの支柱', grounds: 'b' });

    const reply = await call('journal_read', {});
    expect(reply).toContain('トマトの水やり');
    expect(reply).toContain('ナスの支柱');
  });
});

describe('journal_read — since/until の正規化（issue #1515）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('秒を省いた since（…T20:21Z）でも、その分内に積まれた行を正しく含める', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T20:21:05.123Z'));
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'decision',
      decision: '20時21分5秒123に積んだ判断',
      grounds: '記憶',
    });
    expect(entry.at).toBe('2026-09-12T20:21:05.123Z');
    const call = tools(stores);

    const reply = await call('journal_read', { since: '2026-09-12T20:21Z' });
    expect(reply).toContain('20時21分5秒123に積んだ判断');
  });

  it('オフセット付きの since（+09:00）でも、同じ瞬間以降の行を正しく含める', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T20:21:05.123Z'));
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'decision',
      decision: 'オフセット越しに掘り当てたい判断',
      grounds: '記憶',
    });
    expect(entry.at).toBe('2026-09-12T20:21:05.123Z');
    const call = tools(stores);

    const reply = await call('journal_read', { since: '2026-09-13T05:21:05+09:00' });
    expect(reply).toContain('オフセット越しに掘り当てたい判断');
  });

  it('秒を省いた until（…T20:21Z）は、実際には正規化した瞬間より後の行を正しく除く', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T20:21:05.123Z'));
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'decision',
      decision: 'until の境界より後に積んだ判断',
      grounds: '記憶',
    });
    expect(entry.at).toBe('2026-09-12T20:21:05.123Z');
    const call = tools(stores);

    const reply = await call('journal_read', { until: '2026-09-12T20:21Z' });
    expect(reply).not.toContain('until の境界より後に積んだ判断');
  });

  it('since に読めない文字列を渡すと、日誌を読まずに分かる言葉で断る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '積んだ判断', grounds: '記憶' });
    const call = tools(stores);

    const reply = await call('journal_read', { since: 'not-a-datetime' });
    expect(reply).toContain('since に渡された「not-a-datetime」は日時として読めない');
    expect(reply).not.toContain('積んだ判断');
  });

  it('until に読めない文字列を渡すと、日誌を読まずに分かる言葉で断る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '積んだ判断', grounds: '記憶' });
    const call = tools(stores);

    const reply = await call('journal_read', { until: 'not-a-datetime' });
    expect(reply).toContain('until に渡された「not-a-datetime」は日時として読めない');
    expect(reply).not.toContain('積んだ判断');
  });
});

describe('journal_read — 続きの位置 afterId / afterAt', () => {
  function readCursor(reply: string): { afterId: string; afterAt: string } | null {
    const match = /続きは journal_read afterId=(\S+) afterAt=(\S+)/.exec(reply);
    return match === null ? null : { afterId: match[1]!, afterAt: match[2]! };
  }

  function brokenStores(unreadable: (index: number) => boolean, total = 10): Stores {
    const synthetic = createSyntheticJournalStore({
      total,
      entryAt: (index) => ({
        type: 'decision',
        decision: `判断-${String(index).padStart(2, '0')}`,
        grounds: '記憶',
      }),
      unreadable,
    });
    return { ...createMemoryStores(), journal: synthetic.store };
  }

  it('頁が丸ごと読めない行だったとき、続きの位置を出し、それを渡すと先の行が読める', async () => {
    const call = tools(brokenStores((index) => index <= 2));

    const first = await call('journal_read', { limit: 3 });
    expect(first).toContain('読めない形の行だけだった');
    expect(first).toContain('afterId / afterAt');
    expect(first).not.toContain('窓をずらして読み直すこと');
    const cursor = readCursor(first);
    expect(cursor).not.toBeNull();
    expect(cursor!.afterId).toBe('synthetic-000000000002');

    const second = await call('journal_read', { limit: 3, ...cursor! });
    expect(second).toContain('判断-03');
    expect(second).toContain('判断-05');
    expect(second).not.toContain('判断-02');
    expect(readCursor(second)?.afterId).toBe('synthetic-000000000005');
  });

  it('一覧の応答にも続きの位置が出て、渡すと次の行から読み継げる', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `判断-${i}`,
        grounds: '記憶',
      });
    }
    const call = tools(stores);

    const first = await call('journal_read', { limit: 2 });
    expect(first).toContain('判断-4');
    expect(first).toContain('判断-3');
    const cursor = readCursor(first);
    expect(cursor).not.toBeNull();

    const second = await call('journal_read', { limit: 2, ...cursor! });
    expect(second).toContain('判断-2');
    expect(second).toContain('判断-1');
    expect(second).not.toContain('判断-3');
  });

  it('next が null（本当の終わり）なら、続きの行を出さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '最後の判断', grounds: '記憶' });
    const call = tools(stores);

    const reply = await call('journal_read', {});
    expect(reply).toContain('最後の判断');
    expect(reply).not.toContain('続きは');
    expect(readCursor(reply)).toBeNull();
  });

  it('予算で省略したときは、next ではなく表示した最後の行を続きにし、省略した行を飛ばさない', async () => {
    const stores = createMemoryStores();
    await fillJournal(stores, 100);
    const call = tools(stores);

    const first = await call('journal_read', { limit: 100 });
    expect(first).toContain('件は省略');
    const all = await stores.journal.list({ limit: 100 });
    const cursor = readCursor(first);
    expect(cursor).not.toBeNull();
    const lastShownIndex = all.findIndex((entry) => entry.id === cursor!.afterId);
    expect(lastShownIndex).toBeGreaterThanOrEqual(0);
    expect(lastShownIndex).toBeLessThan(all.length - 1);
    expect(first).toContain(`id=${all[lastShownIndex]!.id}`);
    expect(first).not.toContain(`id=${all[lastShownIndex + 1]!.id}`);

    const second = await call('journal_read', { limit: 100, ...cursor! });
    expect(second).toContain(`id=${all[lastShownIndex + 1]!.id}`);
    expect(second).not.toContain(`id=${all[lastShownIndex]!.id}`);
  });

  it('afterId だけ・afterAt だけは、日誌を読まずに断る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '積んだ判断', grounds: '記憶' });
    const call = tools(stores);

    for (const args of [{ afterId: 'x' }, { afterAt: '2026-01-01T00:00:00.000Z' }]) {
      const reply = await call('journal_read', args);
      expect(reply).toContain('afterId と afterAt は両方一緒に渡す');
      expect(reply).toContain('日誌は読んでいない');
      expect(reply).not.toContain('積んだ判断');
    }
  });

  it('afterAt が日時として読めなければ、日誌を読まずに断る', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '積んだ判断', grounds: '記憶' });
    const call = tools(stores);

    const reply = await call('journal_read', { afterId: 'x', afterAt: 'not-a-datetime' });
    expect(reply).toContain('afterAt に渡された「not-a-datetime」は日時として読めない');
    expect(reply).toContain('日誌は読んでいない');
    expect(reply).not.toContain('積んだ判断');
  });

  it('錨が見つからなければ「判定できない」と言い、先頭から読み直さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: '積んだ判断', grounds: '記憶' });
    const call = tools(stores);

    const reply = await call('journal_read', {
      afterId: 'no-such-id',
      afterAt: '2026-01-01T00:00:00.000Z',
    });
    expect(reply).toContain('判定できない');
    expect(reply).toContain('先頭から読み直してもいない');
    expect(reply).not.toContain('積んだ判断');
  });
});
