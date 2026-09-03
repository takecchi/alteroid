import { describe, expect, it } from 'vitest';

import {
  buildActivityDigest,
  describeManagerState,
  describeSessionMissingKind,
  MAX_ITEMS,
} from './digest.js';
import type { SessionMissingKind } from './manager.js';
import { createMemoryStores } from './testing.js';
import { usageDate } from './usage.js';

/**
 * `manager_list`（`tools.ts`）と digest の「マネージャー」節で同じ字面を出す
 * ための唯一の生成元。3値の意味は `manager.ts` の `ManagerSummary.live` の
 * doc と同じだが、ここでは `boolean | undefined` を受ける——省略（`undefined`）
 * を `true` に倒さない（`digest.ts` の doc）。
 */
describe('describeManagerState', () => {
  it('live: true は状態名だけ', () => {
    expect(describeManagerState('running', true)).toBe('running');
  });

  it('live: false は「/セッション切断」を足す', () => {
    expect(describeManagerState('running', false)).toBe('running/セッション切断');
  });

  it('live: undefined は「/セッション不明」——否定でも肯定でもない第三の値', () => {
    expect(describeManagerState('running', undefined)).toBe('running/セッション不明');
  });
});

/**
 * `describeSessionMissingKind`（#579）の字面を core 側で完全一致で固定する
 * （#619 の積み残し）。
 *
 * **直す前は、この生成元そのものを字面まで測る歯が `packages/core` に無かった。**
 * `tools.test.ts` は `manager_list` 経由の `toContain`（部分一致——生成元では
 * なく消費側を測っている）しか持たず、`apps/web/app/routes/managers.test.tsx`
 * の `describe('sessionMissingKind の字面が core と一致する（#579）')` は
 * `describeSessionMissingKindNote` と `describeSessionMissingKind` を `toBe`
 * で比べる**相対比較**——両側が同じ方向へずれても緑のまま通る。絶対の錨
 * （core 側の完全一致）がどこにも無かった。
 *
 * **倣ったのは `dropped-record.test.ts` の
 * `describe('帳面の字面（origin・0件の読み方・保持）', …)`。**
 * `describeDroppedTraceOrigin` が #623 で先に置いた形（`undefined` は空文字・
 * `Record` で全値を持つ・`toContain` と `toBe` の両方を持つ）を、ここでも
 * そのまま採る——`describeDroppedTraceOrigin` の doc 自身が「先例は
 * `describeSessionMissingKind`」と書いていた非対称を埋める。
 */
describe('describeSessionMissingKind の字面（#619 の積み残し。#623 の describeDroppedTraceOrigin に倣う）', () => {
  it('describeSessionMissingKind(undefined) は空文字（「不明」と書かない）', () => {
    // 理由は describeSessionMissingKind の doc の逐語:
    // 「由来を持たない印は、この欄が足される前の版のデーモンが立てたものだけ
    // である。そこへ新しい語を出すと、実際には2つしかない区別が3つに見える。」
    expect(describeSessionMissingKind(undefined)).toBe('');
  });

  /**
   * **`ALL_KINDS` を `Record` で持つのは、値が増えたときにここが型で
   * 落ちるため。** 配列だと3つ目が足されても素通りする（＝新しい値の字面が
   * 測られないまま増える）。これはビルド時の網羅性であって、実行時に測って
   * いるのは下の非空チェックだけである（`dropped-record.test.ts` の
   * `ALL_ORIGINS` / `managers.test.tsx` の `ALL_KINDS` と同じ形）。
   */
  it('SessionMissingKind の全ての値について、空でない文字列を返す', () => {
    const ALL_KINDS: Record<SessionMissingKind, true> = {
      'resume-failed': true,
      unlisted: true,
    };
    const kinds = Object.keys(ALL_KINDS) as SessionMissingKind[];
    // **空でないことを先に確かめる。** `Object.keys` が空なら下の forEach は
    // 1回も回らず、この歯は何も測らずに緑になる。
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeSessionMissingKind(kind)).not.toBe('');
    }
  });

  it('describeSessionMissingKind("resume-failed") は resume を試みて失敗した意味の文言を持つ', () => {
    expect(describeSessionMissingKind('resume-failed')).toContain('resume');
  });

  it('describeSessionMissingKind("unlisted") は名簿に載っていなかった意味の文言を持つ', () => {
    expect(describeSessionMissingKind('unlisted')).toContain('名簿');
  });

  /**
   * **上の2つの `toContain` だけでは足りない。** 文中の1文字を変えても
   * （末尾へ1文字足す等）どちらの部分文字列も壊れないので、変異が生き残る
   * （`dropped-record.test.ts` の同型の歯と同じ理由）。**全文の完全一致**を
   * 別に持つことで、1文字の変異でも赤くなるようにする。
   */
  it('describeSessionMissingKind は resume-failed / unlisted それぞれで文字列として完全一致する', () => {
    expect(describeSessionMissingKind('resume-failed')).toBe('resume でも入り直せなかった。');
    expect(describeSessionMissingKind('unlisted')).toBe(
      '名簿に載っていなかった。resume はまだ試していない。',
    );
  });

  /**
   * **片方の実装をもう片方へコピペで潰す変異**（`resume-failed` の分岐が
   * `unlisted` と同じ文字列を返すようになる、等）は、直上の完全一致2本の
   * どちらか一方が必ず赤くなるので、理屈のうえではこの歯が無くても捕まる。
   * それでも明示的に持つのは、完全一致2本を読む側が「この2つは意図的に
   * 違う字面である」と一目で分かるようにするためであって、検出できない
   * 変異の形を埋めるためではない（検出できない形は見つかっていない）。
   */
  it('resume-failed と unlisted の字面は異なる', () => {
    expect(describeSessionMissingKind('resume-failed')).not.toBe(
      describeSessionMissingKind('unlisted'),
    );
  });
});

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

  /**
   * `live`（＝いま話しかけられるか）が要約の側で潰れていた実害そのものを歯にする
   * （#5243d633）。
   *
   * 定期 tick でクローンへ渡る要約は `- ${job.id} [${job.status}]` としか出しておらず、
   * 「走行中」と「走行中だがセッションが切れている」が区別できなかった。実際に
   * クローンがこれで誤り、**終わった仕事へ3本目の委譲を出した**。ここで測るのは
   * 「片方が出る」ではなく「2本が互いに違う字面になる（区別される）」こと——
   * それが潰れていた性質そのものだからである。
   */
  it('走行中のマネージャー2本を liveness で分けると、要約の行が互いに違う字面になる（実害の歯）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-alive',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '生きている仕事',
      request: '生きている仕事',
    });
    await stores.jobs.putJob({
      id: 'mgr-dead',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: 'セッションが切れた仕事',
      request: 'セッションが切れた仕事',
    });
    const liveness = new Map([
      ['mgr-alive', true],
      ['mgr-dead', false],
    ]);

    const digest = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 60_000) },
      liveness,
    );

    const aliveLine = digest.split('\n').find((line) => line.includes('mgr-alive'));
    const deadLine = digest.split('\n').find((line) => line.includes('mgr-dead'));
    expect(aliveLine).toContain('[running]');
    expect(deadLine).toContain('[running/セッション切断]');
    // 「片方が出る」ではなく「2本が区別される」を測る——同じ status のまま
    // 字面が割れなければ、この歯が守ろうとしている性質そのものが崩れている。
    expect(aliveLine).not.toEqual(deadLine);
  });

  it('liveness に載っていない id は「セッション不明」になる（取れなかったことを黙らない）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-unknown',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '仕事',
      request: '仕事',
    });

    const digest = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 60_000) },
      new Map(),
    );

    const line = digest.split('\n').find((row) => row.includes('mgr-unknown'));
    expect(line).toContain('[running/セッション不明]');
  });

  /**
   * `liveness` 引数を省略したときの既定は「肯定（`true`）」ではなく「不明」で
   * ある。既定が肯定側にあると、呼び出し側が `liveness` を渡し忘れただけで
   * 「繋がっている」と黙って名乗ってしまう（`digest.ts` の `describeManagerState`
   * / `buildActivityDigest` の doc と同じ理由）。
   */
  it('liveness を省略すると「セッション不明」になる（既定が肯定側へ倒れていないことの歯）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-omitted',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '仕事',
      request: '仕事',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const line = digest.split('\n').find((row) => row.includes('mgr-omitted'));
    expect(line).toContain('[running/セッション不明]');
    expect(line).not.toContain('[running]');
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
    const total = MAX_ITEMS + 3;
    for (let i = 0; i < total; i += 1) {
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

    expect(digest).toContain(`マネージャーへの委譲（この期間に動いたもの）: ${total} 本`);
    expect(digest).toContain('…ほか 3 件');
    expect(digest).toContain('manager_list');
    // **drift の歯（#415 の隣の穴。omitted() 側）。** 「合図は在る」だけでは、
    // 出した件数が `MAX_ITEMS` から離れても（例えば `.slice(0, 5)` に変わって
    // も）気づけない——`omitted()` はいまは「実際に出した件数」から引くので、
    // 合図の数はどんな `shown` でも自動的に総数と整合してしまう。だから
    // 「実際に出した件数そのもの」を数えて `MAX_ITEMS` と比較する。
    // `mgr-${i} [` の形で数える（`mgr-1 [` は `mgr-10 [` の部分文字列にならない
    // ——次の文字が空白か `[` かで区切れる）。
    const shownIds = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(`mgr-${i} [`),
    );
    expect(shownIds).toHaveLength(MAX_ITEMS);
    expect(shownIds.length + 3).toBe(total);
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
    const total = MAX_ITEMS + 1;
    for (let i = 0; i < total; i += 1) {
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
    // **drift の歯。** 上のマネージャー節と同じ理由——`ap-${i}（` の形で数える
    // （`ap-1（` は `ap-10（` の部分文字列にならない）。
    const shownIds = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(`ap-${i}（`),
    );
    expect(shownIds).toHaveLength(MAX_ITEMS);
    expect(shownIds.length + 1).toBe(total);
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

  /**
   * 保持上限を超えて物理削除された片付き行の累計を digest の頭の集計に出す
   * （issue #416）。**この節は「この期間に片付けた仕事」の集計をそのまま読む
   * ものなので、fs 実装で歴史が `CLOSED_HISTORY_LIMIT` を超えた時点から古い
   * 期間の集計が静かに減っている、という Issue 本文の指摘をここで塞ぐ。**
   */
  it('物理削除された片付き行の累計を頭の集計に出す（issue #416）', async () => {
    const stores = createMemoryStores();
    // 本物の memory store は `trimmedClosed` を常に0で返す（`testing.ts` の
    // doc）ので、`list()` を差し替えて注入する。
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, trimmedClosed: 12 };
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('保持上限を超えて物理削除された片付き行');
    expect(digest).toContain('12 件');
  });

  it('物理削除された片付き行が0件でも、その旨の行は出す（他の集計行と同じ扱い）', async () => {
    const stores = createMemoryStores();
    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(
      '保持上限を超えて物理削除された片付き行（累計。この記憶ストアが最初から数えている分）: 0 件',
    );
  });

  // 日誌から作る節。**どれも同じ形で黙って切れていた**ので、節ごとに1本立てる
  // （1つのテストにまとめると、最初の1件で止まって残りが測れない）。
  // `label(i)` は、実際に出した件数を数えるための一意な部分文字列
  // （drift の歯。下の it.each の doc を見ること）。次の文字までを含めて
  // 境界を作る——`決めた 1` だけだと `決めた 10` の部分文字列として誤って
  // 一致するため（AGENTS.md「静かに失敗する道具」の複合語の取りこぼしと
  // 同じ形）。
  const journalSections = [
    {
      name: '聞かずに決めたこと',
      entry: (i: number) =>
        ({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' }) as const,
      types: 'types=["decision"]',
      label: (i: number) => `決めた ${i}（`,
    },
    {
      name: 'エスカレーション',
      entry: (i: number) =>
        ({ type: 'escalation', question: `聞いた ${i}`, approvalId: `ap-${i}` }) as const,
      types: 'types=["escalation"]',
      label: (i: number) => `聞いた ${i} →`,
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
      label: (i: number) => `直した ${i}\n`,
    },
    {
      name: '届いた外部イベント',
      entry: (i: number) =>
        ({ type: 'external_event', source: 'ci', summary: `届いた ${i}` }) as const,
      types: 'types=["external_event"]',
      label: (i: number) => `届いた ${i}\n`,
    },
  ];

  /**
   * **drift の歯。** 合図（「…ほか N 件」）が在ることだけを見るテストでは、
   * `.slice(0, MAX_ITEMS)` の件数が `MAX_ITEMS` から離れても気づけない——
   * `omitted()`（#415 の隣で直した）はいまは「実際に出した件数」から引くので、
   * 合図の数はどんな `shown` でも自動的に総数と整合してしまう（合図そのものが
   * 嘘になる形は直った。だが「常に `MAX_ITEMS` 件出す」という意図が崩れても、
   * 合図だけを見ている限り気づけない）。だから実際に出した件数そのものを
   * 数えて `MAX_ITEMS` と比較する。
   */
  it.each(journalSections)('$name 節', async ({ entry, types, label }) => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 2;
    for (let i = 0; i < total; i += 1) await stores.journal.append(entry(i));

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 2 件');
    // **行き先は「打ち切る道具」であることまで書く。** `journal_read` も予算で
    // 切るので、「全部見える」と書けば嘘になる。
    expect(digest).toContain(types);
    const shown = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(label(i)),
    );
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(shown.length + 2).toBe(total);
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
    // **切ったときに残る側が「高い順の上位」であることまで見る。** 合図が在る
    // かどうかだけを測ると、`top()` の並びが逆になっても通ってしまう——そのとき
    // 出力は「安い15件」になり、**合図は正しいまま中身が入れ替わる。** 読んだ側
    // からは、どちらの15件を見せられているのか区別が付かない。
    expect(digest).toContain('model-0 $100.00');
    expect(digest).not.toContain(`model-${MAX_ITEMS} `);
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
    // モデル別と同じ理由——残る側が高い順の上位であることを見る。
    expect(digest).toContain('mgr-0: $100.00');
    expect(digest).not.toContain(`mgr-${MAX_ITEMS}: `);
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

  /**
   * **出した件数と合図の件数が一致する。**
   *
   * 合図が在るかどうかだけを見る歯では、`top()` が切る件数が `MAX_ITEMS` から
   * 離れた日に「15 件出したと言いながら 5 件しか出していない」形を通してしまう
   * ——合図そのものは在るので、**読んだ側からは食い違いに気づけない。** 出した
   * 件数と省いた件数の両方を同じ行から数えて、和が総数に戻ることを見る。
   */
  it('出した件数と「…ほか N 件」の和が総数に戻る（合図の数が出した数から離れない）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    const total = MAX_ITEMS + 5;
    for (let i = 0; i < total; i += 1) {
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

    const line = digest.split('\n').find((l) => l.startsWith('- モデル別: '));
    expect(line).toBeDefined();
    const parts = (line ?? '').slice('- モデル別: '.length).split(' / ');
    const notice = parts.at(-1) ?? '';
    const shown = parts.slice(0, -1);
    // 出した件数そのもの（`top()` が切った数）。
    expect(shown).toHaveLength(MAX_ITEMS);
    // 省いた件数は「総数 − 出した件数」。両方をこの行から数えている。
    expect(notice).toContain(`…ほか ${total - shown.length} 件`);
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
   * **逆向きの歯（全節ぶん）。** 切っていない節が黙っていることを、ここで
   * まとめて測る。
   *
   * **なぜ要るか。** 他の歯は「超えたら言う」側だけを測っていて、この向きは
   * 使用量の4軸にしか歯が無かった——実際に、`omitted()` の `total <= shown`
   * の門を外す変異を当てても**どのテストも落ちなかった**（そのとき9節は
   * 「…ほか 0 件」を出し続ける）。**穴を塞いだのではなく向きを変えただけに
   * ならないよう、両向きを同じ入力で測る。**
   */
  it(`どの節も ${MAX_ITEMS} 件以下なら、合図（…ほか）が1つも出ない`, async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const at = new Date();
    // **全節を「上限ちょうど」で埋める。** 1件でも超えると、その節の合図が
    // 出るのが正しい挙動になり、この歯が測ろうとしているものが消える。
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.commitments.open({
        id: `q-open-${i}`,
        at: now,
        origin: 'human',
        body: `未了 ${i}`,
      });
      const closedId = `q-closed-${i}`;
      await stores.commitments.open({
        id: closedId,
        at: now,
        origin: 'human',
        body: `片付け ${i}`,
      });
      await stores.commitments.close(closedId, now, `理由 ${i}`, 'clone');
      await stores.schedules.put({
        kind: `q-kind-${i}`,
        spec: { type: 'daily', at: '09:00' },
        request: `継続 ${i}`,
        createdAt: now,
        updatedAt: now,
      });
      await stores.jobs.putJob({
        id: `q-mgr-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `依頼 ${i}`,
      });
      await stores.jobs.putApproval({ id: `q-ap-${i}`, createdAt: now, question: `確認 ${i}` });
      await stores.journal.append({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' });
      await stores.journal.append({
        type: 'escalation',
        question: `聞いた ${i}`,
        approvalId: `q-esc-${i}`,
      });
      await stores.journal.append({
        type: 'memory_update',
        slug: 'values',
        cause: 'clone',
        action: 'write',
        bytesBefore: i,
        bytesAfter: i + 1,
        summary: `直した ${i}`,
      });
      await stores.journal.append({ type: 'external_event', source: 'ci', summary: `届いた ${i}` });
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `q-usage-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`q-model-${i}`]: totals(10 - i / 100) } },
      });
    }
    // 読めない行も「上限ちょうど」で入れる（こちらの合図は別の経路である）。
    const unreadable = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      id: `q-unreadable-${i}`,
      at: now,
      reason: `壊れている ${i}`,
    }));
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    // まず、測る気でいた節が本当に出ていることを確かめる（空の digest を測って
    // 「合図が無い」と言う形を避ける)。
    for (const heading of DECLARED_SECTIONS) expect(digest).toContain(heading);
    // そのうえで、合図が1つも無いことを見る。
    expect(digest).not.toContain('…ほか');
  });
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
