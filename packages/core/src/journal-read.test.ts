import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `journal_read` — **日誌は「特定の1行を探す」ために引く道具である。**
 *
 * 全文を素で並べていた頃は、200 件頼むと 178,524 文字になって MCP の出力上限で
 * 丸ごと落ち、クローンには1文字も届かなかった。人間は Web UI と `GET /journal`
 * で同じものを読めるので、これは能力の削除である（north_star 禁止1）。
 *
 * ここで固定するのは3つ。**過去の一点へ届くこと**（`until` が無いと新しい順の
 * 手前で `limit` が尽きて永久に届かない）、**上限で丸ごと落ちないこと**、
 * **切ったなら切ったと分かり、全文への行き先があること**。
 */

/** MCP の出力上限。実測 52,997 文字で溢れたので、その手前に線を引く。 */
const SAFE_OUTPUT = 20_000;

function tools(stores: Stores) {
  const list = createCloneTools({ stores, emit: () => undefined, memoryCause: () => 'clone' });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

/**
 * 時刻をまたがせる。
 *
 * 追記の `at` はストアが打つミリ秒なので、間を空けないと同じ時刻に並ぶ。
 * 窓の境界を試すテストでは、境界の手前と奥を別の時刻にする必要がある。
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** 実際に溢れた形（長い本文が大量に並ぶ）を作る。 */
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

    // 直っていなければ 17 万文字を返していた場所である。
    expect(reply.length).toBeLessThan(SAFE_OUTPUT);
    // 落としたなら落としたと言う（黙って先頭だけ返さない）。
    expect(reply).toContain('件は省略');
    // 全文への行き先を必ず添える（抜粋にしただけで終わらせない）。
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
    // 後からいくらでも積まれる（本番で 09:02 が埋もれたのと同じ状況）。
    await tick();
    await fillJournal(stores, 100);
    const call = tools(stores);

    // until 無しでは、新しい分が limit を食い尽くして届かない。
    const withoutUntil = await call('journal_read', { limit: 20 });
    expect(withoutUntil).not.toContain('掘り当てたい1件');

    // 窓の終端を閉じれば当たる。
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

/**
 * `journal_read` の `q`（本文を語で探す。issue #250）。
 *
 * **ストア側の契約は `journal-search-contract.ts` が3実装ぶん測る。**
 * ここで測るのは、**道具の口がそれを本当に通しているか**と、**当たらなかった
 * ときに黙らないか**の2つだけである（同じことを2箇所で測らない）。
 */
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

    // 大文字小文字を区別しない（先例 `conversation_read` と同じ契約）。
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

  /**
   * **0件のとき「無い」で終わらせない。**
   *
   * `q` の照合対象は自由文の欄だけで、`tool_use` の `input` は入っていない
   * （`journal-search.ts`「対象にしていない欄」）。そこを黙ると、受け取った側は
   * 「日誌にその語は無い」と読む——**判定できないことを2値へ潰す形そのもの**
   * である（AGENTS.md「静かに失敗する道具」）。
   */
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
    // 「日誌はまだ空」と言わないこと（実際には1件在る）。
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
