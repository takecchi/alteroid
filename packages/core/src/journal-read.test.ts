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
  const list = createCloneTools({ stores, emit: () => undefined });
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
});
