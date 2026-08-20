import { describe, expect, it } from 'vitest';

import { buildActivityDigest, MAX_ITEMS } from './digest.js';
import { createMemoryStores } from './testing.js';
import { usageDate } from './usage.js';

/**
 * 日報と発意 tick の材料。ここに要るのは「全体が見えている」ことだけで、
 * 何をすべきかの指示は含めない（判断はクローンに残す）。
 */
describe('活動の要約', () => {
  it('その期間の判断・エスカレーション・記憶の更新・外部イベントを並べる', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' });
    await stores.journal.append({
      type: 'decision',
      decision: 'ログイン周りの修正を委譲した',
      grounds: '記憶にある「小さな修正は任せてよい」',
    });
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'distill',
      summary: '検証の粒度についての好みを追記',
    });
    await stores.journal.append({
      type: 'external_event',
      source: 'ci',
      summary: 'main のビルドが落ちた',
    });

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60_000),
    });

    expect(digest).toContain('人間からの発言: 1 件');
    expect(digest).toContain('ログイン周りの修正を委譲した');
    expect(digest).toContain('小さな修正は任せてよい');
    expect(digest).toContain('検証の粒度についての好みを追記');
    expect(digest).toContain('main のビルドが落ちた');
  });

  /**
   * ツール実行を層で分ける（#32）。
   *
   * クローンも道具を全部持つので、自分の手の実行が同じ日誌へ落ちる。1つの数に
   * まとめると「委譲した量」として読める数が自分の手の量で膨らみ、**この digest を
   * 読んで委譲を決めるクローン自身と、日報を読む人間の両方が誤る。**
   */
  it('ツール実行は「マネージャー・作業者」と「自分の手」を分けて数える', async () => {
    const stores = createMemoryStores();
    for (const actor of ['clone', 'clone:sub:general-purpose', 'clone:distill']) {
      await stores.journal.append({ type: 'tool_use', actor, tool: 'Bash', input: {} });
    }
    await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1234abcd',
      tool: 'Edit',
      input: {},
    });
    await stores.journal.append({
      type: 'tool_use',
      actor: 'worker:mgr-1234abcd:worker',
      tool: 'Read',
      input: {},
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('マネージャー・作業者のツール実行: 2 件');
    expect(digest).toContain('あなた自身が手を動かした回数（委譲せずに使った道具）: 3 件');
  });

  it('継続中の依頼は期間の外でも常に材料に載る（頼まれたままの仕事を忘れないため）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て実装を進める',
      // 期間よりずっと前に仕込まれた依頼でも落とさない
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('継続中の依頼');
    expect(digest).toContain('open issue を見て実装を進める');
    expect(digest).toContain('毎日 09:00');
    expect(digest).toContain('まだ一度も動いていない');
  });

  it('走行中のマネージャーと、人間の回答待ちは「いまの状態」として必ず出る', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-1234',
      createdAt: now,
      updatedAt: now,
      status: 'waiting_human',
      summary: 'ログイン周りを直して',
      request: 'ログイン周りを直して',
      lastReport: '原因まで分かった',
    });
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: now,
      question: '本番へ流してよいか',
      jobId: 'mgr-1234',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('mgr-1234');
    expect(digest).toContain('原因まで分かった');
    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    expect(digest).toContain('本番へ流してよいか');
  });

  it('期間の外の記録は数えない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: 'いま決めた', grounds: '記憶' });

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60_000),
      until: new Date(Date.now() - 30_000),
    });

    expect(digest).toContain('自分で決めたこと（日誌の decision）: 0 件');
    expect(digest).not.toContain('いま決めた');
  });
});

/**
 * **上限で切ること自体は要件である。** 件数に比例して伸びる材料は、MCP の出力上限を
 * 超えると1文字も届かない。ここで守るのは「切ったことが出力から消えない」ことだけで
 * ある — 消えると、クローンの手元に残るのは「これで全部だ」と読める一覧になり、
 * 続きを掘るという判断そのものが起きなくなる。
 */
describe('上限で切ったことを黙らない', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('マネージャー節（この節が黙って切れていた）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_ITEMS + 3; i += 1) {
      await stores.jobs.putJob({
        id: `mgr-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `仕事 ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`マネージャーへの委譲（この期間に動いたもの）: ${MAX_ITEMS + 3} 本`);
    expect(digest).toContain('…ほか 3 件');
    expect(digest).toContain('manager_list');
  });

  /**
   * 切る順序も保証の対象である。digest の材料は `listJobs()` で、順序は器ごとに
   * 違う（pg は `createdAt` 昇順・fs は最終更新順・memory は挿入順）。この節が
   * 走行中と返事待ちを**期間の外からでも**拾っているのは「いまの状態」を渡すため
   * なので、上限で切るときにそれが古い `done` に押し出されると器の目的が消える。
   */
  it('切るときは走行中・返事待ちを先に残す（古い done に押し出させない）', async () => {
    const stores = createMemoryStores();
    const inWindow = new Date().toISOString();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.jobs.putJob({
        id: `done-${i}`,
        createdAt: inWindow,
        updatedAt: inWindow,
        status: 'done',
        summary: `片付いた ${i}`,
      });
    }
    // 期間の外で始まって、いまも走っている1本。**これが落ちてはならない。**
    await stores.jobs.putJob({
      id: 'mgr-running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      summary: '本番の移行作業',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('mgr-running');
    expect(digest).toContain('…ほか 1 件');
  });

  it('人間の回答待ち節', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_ITEMS + 1; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-${i}`,
        createdAt: now,
        question: `確認 ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 1 件');
    // 打ち切らない道具なので、ここだけは「全部見える」と書ける。
    expect(digest).toContain('approvals_list');
  });

  // 日誌から作る節。**どれも同じ形で黙って切れていた**ので、節ごとに1本立てる
  // （1つのテストにまとめると、最初の1件で止まって残りが測れない）。
  const journalSections = [
    {
      name: '聞かずに決めたこと',
      entry: (i: number) =>
        ({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' }) as const,
      types: 'types=["decision"]',
    },
    {
      name: 'エスカレーション',
      entry: (i: number) =>
        ({ type: 'escalation', question: `聞いた ${i}`, approvalId: `ap-${i}` }) as const,
      types: 'types=["escalation"]',
    },
    {
      name: '記憶の更新',
      entry: (i: number) =>
        ({
          type: 'memory_update',
          slug: 'values',
          cause: 'clone',
          summary: `直した ${i}`,
        }) as const,
      types: 'types=["memory_update"]',
    },
    {
      name: '届いた外部イベント',
      entry: (i: number) =>
        ({ type: 'external_event', source: 'ci', summary: `届いた ${i}` }) as const,
      types: 'types=["external_event"]',
    },
  ];

  it.each(journalSections)('$name 節', async ({ entry, types }) => {
    const stores = createMemoryStores();
    for (let i = 0; i < MAX_ITEMS + 2; i += 1) await stores.journal.append(entry(i));

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 2 件');
    // **行き先は「打ち切る道具」であることまで書く。** `journal_read` も予算で
    // 切るので、「全部見える」と書けば嘘になる。
    expect(digest).toContain(types);
  });
});

describe('使った分', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.5,
    },
  };

  it('台帳が空なら「0」ではなく「記録が無い」と書く', async () => {
    const stores = createMemoryStores();

    const digest = await buildActivityDigest(stores, { since: new Date(2026, 7, 14) });

    expect(digest).toContain('## 使った分');
    expect(digest).toContain('記録が無い');
    expect(digest).not.toContain('合計: $0');
  });

  it('モデル別と高かった委譲を出し、但し書きを添える', async () => {
    // 「どの層が高いか」「どの委譲が高かったか」が委譲の粒度を直す材料になる。
    const stores = createMemoryStores();
    const at = new Date(2026, 7, 14, 10, 0);
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-heavy',
      date: usageDate(at),
      at: at.toISOString(),
      snapshot: { models },
    });

    const digest = await buildActivityDigest(stores, { since: new Date(2026, 7, 14) });

    expect(digest).toContain('合計: $2.50');
    expect(digest).toContain('claude-opus-5 $2.00');
    expect(digest).toContain('mgr-heavy');
    expect(digest).toContain('請求明細ではない');
  });
});
