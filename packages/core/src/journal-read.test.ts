import { afterEach, describe, expect, it, vi } from 'vitest';

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

/**
 * `journal_read` の `since`/`until` の正規化（issue #1515）。
 *
 * **何を固定するか。** `since`/`until` は `Date.parse` して読めなければ拒否し、
 * 読めれば `toISOString()`（UTC・ミリ秒3桁・`Z` 終端——`entry.at` と同じ固定
 * 形式）へ正規化してからストアへ渡す（`journal-time.ts` の doc）。
 *
 * インメモリ実装（`testing.ts`）は `entry.at >= since` という**文字列比較**
 * なので、正規化しないと秒を省いた形（`…T20:21Z`）やオフセット付き
 * （`+09:00`）の `since` で、辞書順と時刻の前後関係が食い違う——
 * pg（時刻で比べる）と答えが割れる。ここではその食い違いをインメモリ実装
 * 自身の挙動として固定する（修正前は両方とも赤くなる）。
 */
describe('journal_read — since/until の正規化（issue #1515）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('秒を省いた since（…T20:21Z）でも、その分内に積まれた行を正しく含める', async () => {
    vi.useFakeTimers();
    // issue #1515 の実例そのもの——`2026-09-12T20:21Z` は辞書順では
    // `2026-09-12T20:21:05.123Z` より**後ろ**になる（':' の文字コードが
    // 'Z' より小さいため）。正規化していないと、この行は since より古いと
    // 誤判定されて窓の外へ落ちる。
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

    // `2026-09-13T05:21:05+09:00` は UTC で `2026-09-12T20:21:05.000Z`
    // ——上の entry の瞬間 (.123Z) の120ミリ秒前。正規化していないと、
    // 日付の桁（12 と 13）が食い違う文字列比較になり、この行を
    // 「since より古い」と誤判定して窓の外へ落とす。
    const reply = await call('journal_read', { since: '2026-09-13T05:21:05+09:00' });
    expect(reply).toContain('オフセット越しに掘り当てたい判断');
  });

  it('秒を省いた until（…T20:21Z）は、実際には正規化した瞬間より後の行を正しく除く', async () => {
    vi.useFakeTimers();
    // `until: '2026-09-12T20:21Z'` は「20:21:00.000Z まで」の意味だが、
    // 正規化していないと辞書順では逆に働く——短い形（'Z' で終わる）は
    // 同じ分内のどんな秒・ミリ秒付きの文字列よりも**辞書順で大きい**
    // （':' の文字コードが 'Z' より小さいため、続きが在る文字列のほうが
    // 辞書順で手前に来る）。⟹ 正規化していないと、20:21:00.000Z より
    // **後**（20:21:05.123Z）に積まれたこの行を、文字列比較は
    // 「until 以前」と誤判定して**含めてしまう**（must-exclude が
    // 含まれる、という逆向きの壊れ方）。
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
