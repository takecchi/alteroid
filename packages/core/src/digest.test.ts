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
 * `## 記憶の更新` 節が `action` / 前後バイト数を出すこと（#339）。
 *
 * `journal_read`（`tools.ts`）・Web の日誌一覧（`queries.ts`）と同じ穴
 * ——journal の `memory_update` エントリを1件1行で読み手へ並べる面——であり、
 * 同じ3性質（action・バイト数が出る／古いエントリで0を出さない／単位が
 * 混ざらない）をここでも測る。
 */
describe('## 記憶の更新 — action / バイト数（#339）', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('action と前後バイト数を出す（新形式のエントリ）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 12,
      bytesAfter: 34,
      summary: '価値観を書いた',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('write');
    expect(digest).toContain('12→34 バイト');
  });

  it('action / バイト数を持たない古いエントリは「不明」と明示し、0 としては出さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'human',
      summary: '古い形式のエントリ（action フィールドが無い）',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('0→0 バイト');
    expect(digest).toContain('不明');
  });

  it('バイト数（機械可読）と summary に埋め込まれた文字数（自由文）が同じ括弧に混在しない', async () => {
    // memory_delete の summary は「（削除直前 N 文字）」を埋め込む（tools.ts の
    // memory_delete）。バイトの注記は構造化された括弧（cause/action の隣）に
    // 置き、自由文の summary はその括弧の外へ出す——queries.ts と同じ分け方。
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'temp-note',
      cause: 'clone',
      action: 'remove',
      bytesBefore: 42,
      bytesAfter: 0,
      summary: '片付け（削除直前 40 文字）',
    });

    const digest = await buildActivityDigest(stores, { since: since() });
    const line = digest.split('\n').find((row) => row.includes('temp-note'));
    expect(line).toBeDefined();
    if (line === undefined) throw new Error('記憶の更新の行が見つからない');
    const closingParenIndex = line.indexOf('）');
    const structured = line.slice(0, closingParenIndex);
    const freeText = line.slice(closingParenIndex + 1);

    expect(structured).toContain('42→0 バイト');
    expect(structured).not.toContain('文字');
    expect(freeText).toContain('40 文字');
    expect(freeText).not.toContain('バイト');
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

  /**
   * 読めない行の id（#296）にも上限を付ける（#414）。
   *
   * **この歯は worst case（総文字数の予算）とは別に要る。** 予算の歯は
   * 全体の文字数しか見ないので、id の cap を外しても増える文字数が小さければ
   * 予算には引っかからない（歯の入力が偏る形）。ここは cap そのものと、
   * 続きの取り方の文言を直接見る。
   */
  it('読めない行の id は MAX_ITEMS で切り、続きの取り方を書く（issue #296 / #414）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const unreadable = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({
      id: `cm-unreadable-${i}`,
      at: now,
      reason: `台帳の行が壊れている ${i}`,
    }));
    // 本物の memory store は `unreadable` を常に空で返す（`testing.ts` の
    // doc）ので、`list()` を差し替えて注入する。
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`読めない行が ${MAX_ITEMS + 1} 件ある`);
    // 先頭 MAX_ITEMS 件の id は出る。
    expect(digest).toContain('cm-unreadable-0');
    expect(digest).toContain(`cm-unreadable-${MAX_ITEMS - 1}`);
    // MAX_ITEMS を超えた分の id は出ない（上限で切る）。
    expect(digest).not.toContain(`cm-unreadable-${MAX_ITEMS}`);
    // 省いた件数と、続きの取り方（`commitment_list` の一覧モード。実装を読んで
    // 確かめた根拠は `digest.ts` の該当コメントにある）を書く。
    expect(digest).toContain(
      '…ほか 1 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る',
    );
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

/**
 * 「使った分」の4軸（モデル・層・場所・委譲）は、切ったら黙らない（#415）。
 *
 * **4軸とも同じ関数（`usageOmitted`。`digest.ts` の非公開関数）を通る。** ここで
 * 測るのは「切ったら言う」と「切っていないのに言わない」の両方向であって、
 * 片方向だけでは「常に合図を出す」という壊れ方（超えてもいないのに言う）を
 * 見逃す。
 */
describe('4軸の合図を1つの関数に閉じる（#415）', () => {
  const since = () => new Date(Date.now() - 60_000);
  const totals = (costUsd: number) => ({
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd,
  });

  it('モデル別: MAX_ITEMS を超えたら合図が出る（axis="model"）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS + 1; i += 1) {
      await stores.usage.record({
        layer: 'clone',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'shared-manager',
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(
      '…ほか 1 件（`usage_read` に axis="model", offset=0 を渡すと続きから辿れる）',
    );
  });

  it('高かった委譲: MAX_ITEMS を超えたら合図が出る（既存の文言のまま。axis="manager"）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS + 1; i += 1) {
      await stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { 'shared-model': totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    // **既存の文言と1文字も変わっていないことを見る（PR 本文の要件）。**
    expect(digest).toContain(
      '  - …ほか 1 本（`usage_read` に axis="manager", offset=0 を渡すと続きから辿れる）',
    );
  });

  it('ちょうど MAX_ITEMS 件（超えていない）なら、どの軸にも合図が出ない', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('axis="model"');
    expect(digest).not.toContain('axis="manager"');
    expect(digest).not.toContain('axis="layer"');
    expect(digest).not.toContain('axis="site"');
  });

  it('層別・場所別は2値の閉じた enum なので、行数を増やしても合図が出ない（逆向きの歯）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    // モデル別・委譲別は MAX_ITEMS を超えるが、層別（'clone'|'manager'）・
    // 場所別（'session'|'distill'）は値が2種類しか無いので超えられない。
    // 「超えている軸には言う／超えていない軸には言わない」を同じ入力で
    // 同時に確かめる。
    for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('axis="model"');
    expect(digest).toContain('axis="manager"');
    expect(digest).not.toContain('axis="layer"');
    expect(digest).not.toContain('axis="site"');
  });
});

/**
 * digest 全体の大きさを測る歯（#414）。
 *
 * **3本セットである。** (a) だけでは「節が増えても、その節を埋める fixture が
 * 無ければ育たない」という偏りが残る（歯の入力が偏る形）ので、(b) で節の集合
 * そのものを固定する。(c) は #415 の4軸の合図を、この worst case からも見る。
 */
describe('digest 全体の大きさを測る歯（#414）', () => {
  /**
   * `brief()` の既定の上限（200）と、節ごとの上限（80 / 120）の両方を確実に
   * 超える長さ。**上限より少し長い程度ではなく、大きく超える**——境界値の
   * 近くで「たまたま収まった」を測定に混ぜないため。
   */
  const long = (n: number) => 'あ'.repeat(n);

  /** 各節を MAX_ITEMS より多く埋めた最悪ケースを1つの stores へ組む。 */
  async function seedWorstCase() {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const COUNT = MAX_ITEMS + 5; // 20 件。全節が上限超過になる最小限より少し余裕を持たせた数。

    // 引き受けたまま終わっていない仕事（未了）。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.commitments.open({
        id: `cm-open-${i}`,
        at: now,
        origin: 'human',
        body: `未了の依頼 ${i} ${long(300)}`,
      });
    }

    // この期間に片付けた仕事。
    for (let i = 0; i < COUNT; i += 1) {
      const id = `cm-closed-${i}`;
      await stores.commitments.open({
        id,
        at: now,
        origin: 'human',
        body: `片付け予定だった依頼 ${i} ${long(300)}`,
      });
      await stores.commitments.close(id, now, `片付いたとした理由 ${i} ${long(200)}`, 'clone');
    }

    // **読めない行（(2)で上限を付けた ids）。** 本物の memory store は
    // `unreadable` を常に空で返す（`testing.ts` の doc）ので、`list()` を
    // 差し替えて注入する。これは digest.ts / digest.test.ts の外を1つも
    // 変えていない——テストの中だけの足場である。
    const unreadable = Array.from({ length: COUNT }, (_, i) => ({
      id: `cm-unreadable-${i}-${long(20)}`,
      at: now,
      reason: `台帳の行が壊れている ${i}`,
    }));
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    // 継続中の依頼。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.schedules.put({
        kind: `kind-${i}`,
        spec: { type: 'daily', at: '09:00' },
        request: `継続中の依頼 ${i} ${long(300)}`,
        createdAt: now,
        updatedAt: now,
      });
    }

    // マネージャー。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.jobs.putJob({
        id: `mgr-worst-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `依頼本文 ${i} ${long(300)}`,
        lastReport: `直近の報告 ${i} ${long(300)}`,
      });
    }

    // 人間の回答待ち。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-worst-${i}`,
        createdAt: now,
        question: `確認したいこと ${i} ${long(300)}`,
      });
    }

    // 日誌（決定・エスカレーション・記憶の更新・外部イベント）。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `決めたこと ${i} ${long(300)}`,
        grounds: `根拠 ${i} ${long(150)}`,
      });
      await stores.journal.append({
        type: 'escalation',
        question: `聞いたこと ${i} ${long(300)}`,
        approvalId: `ap-esc-${i}`,
        answer: `回答 ${i} ${long(150)}`,
      });
      await stores.journal.append({
        type: 'memory_update',
        slug: 'values',
        cause: 'clone',
        action: 'write',
        bytesBefore: i,
        bytesAfter: i + 1,
        summary: `直した内容 ${i} ${long(250)}`,
      });
      await stores.journal.append({
        type: 'external_event',
        source: 'ci',
        summary: `届いた内容 ${i} ${long(250)}`,
      });
    }

    // 使った分（4軸）。モデル別・委譲別は MAX_ITEMS を超えるが、層別・場所別は
    // 2値の閉じた enum なので超ええない（超ええないことも worst case に含める
    // ——超えられる軸だけを測ると、超えられない軸の分岐が worst case に無い
    // 状態になる）。
    const at = new Date();
    for (let i = 0; i < COUNT; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-usage-${i}-${long(20)}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: {
          models: {
            [`model-usage-${i}-${long(20)}`]: totals(1000 - i),
          },
        },
      });
    }

    return stores;
  }

  function totals(costUsd: number) {
    return {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd,
    };
  }

  /**
   * **見出しの宣言集合。** `digest.ts` に `## ` で始まる見出しを足したら、
   * ここへも足すこと——足さなければ次の it が赤くなる。それが「節を足した人が
   * 予算を見直す動線に入る」ための唯一の仕掛けである。
   */
  const DECLARED_SECTIONS = [
    '## 引き受けたまま終わっていない仕事（古い順。片付いたら `commitment_close` で閉じる）',
    '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
    '## この期間に片付けた仕事',
    '## マネージャー（走行中・返事待ちから先に出す）',
    '## 聞かずに決めたこと',
    '## エスカレーション',
    '## 人間の回答待ち（保留中。他の仕事は進めてよい）',
    '## 記憶の更新',
    '## 届いた外部イベント',
    '## 使った分',
  ];

  /**
   * (b) 節の数の歯。
   *
   * **(a)（総文字数の予算）は、この it が書いた fixture が埋めた節しか測らない。**
   * 後から `sections.push('', '## 新しい節')` が足されても、この fixture が
   * それを埋めなければ (a) は緑のままである（歯の入力が偏る形）。見出しの
   * 集合をここで固定すれば、節を足した人は必ずこの it で赤を見て、(a) の
   * fixture と予算を見直す動線に入る。
   */
  it('見出し（`## `）の集合が、宣言した集合と完全一致する', async () => {
    const stores = await seedWorstCase();
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const headings = digest.split('\n').filter((line) => line.startsWith('## '));
    expect(new Set(headings)).toEqual(new Set(DECLARED_SECTIONS));
  });

  /**
   * (a) 総文字数の予算。
   *
   * **この定数は本番コードへ export しない。** `digest.ts` は文字数の上限を
   * 強制していない——強制しているのは各節の `MAX_ITEMS`（件数）と `brief()`
   * （1項目の文字数）で、「全体の文字数」を締める仕組みは無い。ここに置く
   * 予算は**強制ではなく、育ったら赤くなるための観測の歯**である。
   *
   * **数値の出し方。** 2026-08-25 に、上の worst case（10節すべてが
   * `MAX_ITEMS` 超過、各項目が `brief()` の上限を確実に超える長さ）で実測した
   * `digest.length` は **42,319 文字**（`pnpm test packages/core/src/digest.test.ts`
   * の `process.stderr.write` の生出力）。そこへ約 11% の余裕を乗せて
   * 47,000 とした。余裕を大きく取ると「1節増える」程度の変化を吸収してしまい、
   * この歯が育ったことに気づけなくなる（PR 本文の要件——余裕は取りすぎない）。
   */
  const CHARACTER_BUDGET = 47_000;

  it(`worst case でも digest.length が ${CHARACTER_BUDGET} 文字以下である`, async () => {
    const stores = await seedWorstCase();
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    // **予算より先に生の値を出す。** 落ちたときに「境界のすぐ外」なのか
    // 「桁が違う」のかが、この1行があるかどうかで分かる。
    process.stderr.write(`digest.length=${digest.length}\n`);
    expect(digest.length).toBeLessThanOrEqual(CHARACTER_BUDGET);
  });
});
