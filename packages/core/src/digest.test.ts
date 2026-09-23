import { describe, expect, it } from 'vitest';

import {
  buildActivityDigest,
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
  DIGEST_JOURNAL_SCAN_LIMIT,
  DIGEST_RETAIN_LIMIT,
  DIGEST_SOURCE_TALLY_LIMIT,
  isManagerAwaitingJudgement,
  isManagerOutcomeUnobserved,
  MAX_ITEMS,
  type UnobservedOutcomeInput,
  type UnobservedReportState,
} from './digest.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { SessionMissingKind } from './manager.js';
import type { Stores } from './store.js';
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

  /**
   * 第3引数（#621 / #643）。**`status: 'done'` は「手が空いた」と「背景処理の
   * 完了を待って畳んだ」を潰している**——潰れたぶんを字面の側で戻す。
   * （`manager.ts` の `case 'report'` が `record.job.status = event.status;` を
   * 握り潰しの分岐より前に実行するので、`status` は必ず `'done'` になる。）
   */
  it('背景処理待ちのときは件数を足す（done が2つの状態を潰したままにしない）', () => {
    expect(describeManagerState('done', true, { tasks: 3 })).toBe('done/背景処理待ち×3');
  });

  /**
   * **2つは別の軸で、同時に立つ。** 片方がもう片方を隠さないことを固定する
   * ——隠すと、話しかけられないまま背景処理を待っている委譲が、どちらか一方
   * にしか見えなくなる。
   */
  it('セッション切断と背景処理待ちは両方並ぶ（片方が片方を隠さない）', () => {
    expect(describeManagerState('done', false, { tasks: 1 })).toBe(
      'done/セッション切断/背景処理待ち×1',
    );
    expect(describeManagerState('done', undefined, { tasks: 2 })).toBe(
      'done/セッション不明/背景処理待ち×2',
    );
  });

  /**
   * **`undefined` は「背景処理は無い」ではなく「そう名乗られていない」である。**
   * この欄を送らない古い runner が在るので、`undefined` に何かを言わせない——
   * この関数は**何も書き足さない**だけである（`live` の `undefined` を `true` へ
   * 倒さないのと同じ向き）。
   */
  it('第3引数を省略しても、直す前と1文字も変わらない', () => {
    expect(describeManagerState('done', true)).toBe('done');
    expect(describeManagerState('done', true, undefined)).toBe('done');
    expect(describeManagerState('done', false, undefined)).toBe('done/セッション切断');
    expect(describeManagerState('done', undefined, undefined)).toBe('done/セッション不明');
  });

  /**
   * **Issue #1104。`since` が在れば「（<時刻> から）」を添える。**
   *
   * **この関数に時計を渡して経過を計算させない**（doc）——だから足すのは
   * `since` の値そのものであって、経過時間（「N分前」等）ではない。経過を
   * 作るのは読む側（クローン）である。
   */
  it('since が在れば「（<時刻> から）」を tasks の直後に添える', () => {
    expect(
      describeManagerState('done', true, { tasks: 3, since: '2026-09-16T11:00:00.000Z' }),
    ).toBe('done/背景処理待ち×3（2026-09-16T11:00:00.000Z から）');
  });

  /**
   * **`since` 無しでは1バイトも変わらない（既存の呼び出し・テストの回帰）。**
   * `tools.ts` の `manager_list` / `runner_list` は「時刻で答えが変わるものを
   * 一覧に焼かない」ため、`since` を落として（`briefAwaitingBackground`）
   * この関数へ渡す——その経路の字面が変わっていないことをここで固定する。
   */
  it('since が undefined のときは、明示的に渡しても渡さなくても同じ字面のまま', () => {
    expect(describeManagerState('done', true, { tasks: 3 })).toBe('done/背景処理待ち×3');
    expect(describeManagerState('done', true, { tasks: 3, since: undefined })).toBe(
      'done/背景処理待ち×3',
    );
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
   * `job.lastFailure`（`{ code, via, at }`）が日報の文面に現れることの歯
   * （Issue #714 の3面目）。`manager_list` / `manager_report`（`tools.ts`）は
   * 既にこの欄を出しているが、直す前の `buildActivityDigest` は
   * `job.lastFailure` を1文字も読んでいなかった——失敗した委譲があっても
   * 日報の文面は健全な委譲と見分けが付かなかった。
   *
   * **定型の飾り文（「⚠ 直近のターンは失敗で終わっている」）だけを
   * `toContain` しない。** それだと実装が `lastFailure` を実際には読まずに
   * 固定文言だけ出しても緑になる（偽陽性）。ここでは `code` / `via` / `at` に
   * このテストだけが与えた値（他のどの fixture にも出てこない印）を使い、
   * それが digest の出力へ現れることを見る——**「関数が呼ばれた」ではなく
   * 「その理由が文面に現れる」を測る。**
   */
  it('直近のターンが失敗で終わっているとき、日報にその理由（code/via/at）が出る', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-failed-turn',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '仕事',
      request: '仕事',
      lastFailure: {
        code: 'sentinel-code-9f2a71',
        via: 'sentinel-via-7c1b44',
        at: '2026-09-01T00:00:00.000Z',
      },
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    // まずマネージャーの行そのものを切り出す（他の節に偶然同じ印が出ていない
    // ことを確かめる意図もある）。
    const start = digest.indexOf('mgr-failed-turn');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = digest.slice(start);
    expect(block).toContain('sentinel-code-9f2a71');
    expect(block).toContain('sentinel-via-7c1b44');
    expect(block).toContain('2026-09-01T00:00:00.000Z');
    // digest 全体でも印が1箇所にしか出ていないこと（他の節から漏れ入っていない）。
    expect(digest.split('sentinel-code-9f2a71')).toHaveLength(2);
  });

  /**
   * **直近のターンが健全（`lastFailure` が無い）なら、1文字も増えない**
   * （`describeLastFailureLine` の doc の約束そのもの）。
   *
   * **⚠️ 直す前はここを `expect(digest).not.toContain('直近のターンは失敗で
   * 終わっている')` という逐語一致で測っていた。** これは「静かに測らなくなる」
   * 歯である——`describeLastFailureLine` の飾り文（`⚠ 直近のターンは失敗で
   * 終わっている: …`）を書き換えると、この `not.toContain` は**赤くならずに、
   * ただ何も測らなくなる**（元から一致していないので、空振りのまま緑が続く）。
   * 飾り文の書き換えは実装として正当な変更でありうる——測る側がそれで壊れて
   * よい理由にはならない。
   *
   * **だから飾り文の字面に依存しない、構造そのものを見る形にする。** マネージャー
   * 節（ヘッダ + このジョブ1本）を丸ごと切り出し、行の本数と中身が「lastReport
   * までで終わっている」ことを `toEqual` で厳密に見る——`describeLastFailureLine`
   * が何を返そうと、健全な回で1文字でも足せばこの一致が崩れる。飾り文がどう
   * 変わっても、"何も足されていないこと" は文言に触れずに測れる。
   */
  it('直近のターンが報告で終わっている（lastFailure が無い）ときは、失敗の一行が出ない（構造で見る。飾り文の toContain には依存しない）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-healthy-turn',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '仕事',
      request: '仕事',
      lastReport: '完了した',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    // マネージャー節を切り出す。このテストではジョブが1本だけで MAX_ITEMS を
    // 超えないので、`omitted()` の断り書きは付かず、節の中身は
    // 「ヘッダ行 + このジョブのブロック」だけになるはずである。次の節
    // （空行区切りで始まる）の手前までを取り出す。
    const sectionStart = digest.indexOf('## マネージャー');
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const rest = digest.slice(sectionStart);
    const sectionEnd = rest.indexOf('\n\n');
    const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);

    // 行数・中身をちょうど一致で見る——`describeLastFailureLine` が健全な
    // 回で `''` 以外の何かを返せば、行が増えるか末尾の行が伸びるかのどちらか
    // で必ずこの一致が崩れる。飾り文そのものの字面には触れていない。
    expect(section.split('\n')).toEqual([
      '## マネージャー（走行中・返事待ちから先に出す）',
      '- mgr-healthy-turn [done/セッション不明] 仕事',
      '  直近の報告: 完了した',
    ]);
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
 * `## エスカレーション` 節が `approvalId` で束ねること。
 *
 * 日誌は追記専用なので、`ask_human` が積む未回答の行と `answerApproval` が
 * 積む回答済みの行（同じ `approvalId`、別の行）が同じ digest 期間に両方
 * 入ることがある。束ねずに行ごとに描くと、同じ問いが「未回答」と
 * 「回答あり」の両方として並ぶ——実際にクローンがこれで、既に答えを
 * もらっている件をもう一度聞くか、答えを無視して待ち続ける形の実害が出た。
 */
describe('## エスカレーション — approvalId で束ねる（同じ問いの二重表示を直す）', () => {
  const since = () => new Date(Date.now() - 60_000);

  /**
   * **これが直した実害そのものの再現。** 「聞いた」行（未回答）と「答えた」行
   * （回答済み）が同じ `approvalId` を持ち、同じ digest 期間に両方入る
   * ——実際の観測（2026-09-03、hub への issue 起票の可否）と同じ形。
   */
  it('同じ approvalId の「聞いた」行と「答えた」行は1行に束ね、「回答あり」だけを出す（二重表示にしない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-hub-issue',
      createdAt: new Date().toISOString(),
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      answeredAt: new Date().toISOString(),
      answer: '立てて良いです',
    });
    // 「聞いた」行（未回答のまま積まれた最初の行）。
    await stores.journal.append({
      type: 'escalation',
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      approvalId: 'ap-hub-issue',
    });
    // 「答えた」行（`answerApproval` が積む、別の行）。
    await stores.journal.append({
      type: 'escalation',
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      approvalId: 'ap-hub-issue',
      answeredAt: new Date().toISOString(),
      answer: '立てて良いです',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('エスカレーション: 1 件');
    const escalationLines = digest.split('\n').filter((line) => line.includes('virchamate の hub'));
    expect(escalationLines).toHaveLength(1);
    expect(escalationLines[0]).toContain('回答: 立てて良いです');
    expect(escalationLines[0]).not.toContain('未回答');
    // **エスカレーション行そのものに id が出る。** `digest.toContain(id)` は
    // 節をまたいで当たる（承認待ちキューの id が別の節に出ているだけでも
    // 緑になる）ので、取り出した行に対して直接 assert する。
    expect(escalationLines[0]).toContain('id: ap-hub-issue');
  });

  /**
   * #963: 取り下げも「聞いた」行と対の終端として同じ approvalId に積まれる
   * ——回答と同じ二重表示問題を持つので、同じ束ね方で防ぐ。
   */
  it('同じ approvalId の「聞いた」行と「取り下げた」行は1行に束ね、「取り下げ」だけを出す（未回答としては出さない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-withdrawn',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-withdrawn',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-withdrawn',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const escalationLines = digest
      .split('\n')
      .filter((line) => line.includes('本番へ流してよいか →'));
    expect(escalationLines).toHaveLength(1);
    expect(escalationLines[0]).toContain('取り下げ: 自分で答えを見つけた');
    expect(escalationLines[0]).not.toContain('未回答');
    expect(escalationLines[0]).toContain('id: ap-withdrawn');
  });

  it('この期間の日誌には取り下げ前の行しか無いが、キューでは既に取り下げ済み（この期間の外で取り下げられた）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-withdrawn-later',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか（後で取り下げ）',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '前提が消えた',
    });
    // 日誌にはこの期間の「聞いた」行しか無い（「取り下げた」行はこの digest
    // の窓の外に積まれた、という状況を模している）。
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか（後で取り下げ）',
      approvalId: 'ap-withdrawn-later',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('本番へ流してよいか（後で取り下げ） →'));
    expect(line).toContain('この期間の外で取り下げられた');
    expect(line).toContain('前提が消えた');
    // 「回答の本文が無い記録——台帳の破損の可能性がある」に落ちていないこと
    // （#963 で見つかった、取り下げを回答済みの破損として誤読する形）。
    expect(line).not.toContain('台帳の破損');
    expect(line).toContain('id: ap-withdrawn-later');
  });

  it('未回答で承認待ちキューに在る（次の一手: 待つ／催促する）。回答待ち節と同じ id が行そのものに出る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-pending',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-pending',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    const line = digest.split('\n').find((l) => l.includes('本番へ流してよいか →'));
    expect(line).toContain('承認待ちキューに在る');
    expect(line).not.toContain('回答あり');
    // **エスカレーション行そのものに id が出る**（依頼者の指摘: 直す前は
    // 「同じ id で出ている」と言いながら、その id をこの行から探せなかった）。
    // 取り出した行に対して直接 assert するので、この行から id を消せば赤に
    // なる（節をまたいで当たる `digest.toContain` では消しても緑のまま）。
    expect(line).toContain('id: ap-pending');
    // 「人間の回答待ち」節の対応する行も同じ id を持つ（突き合わせの確認）。
    const pendingLine = digest.split('\n').find((l) => l.startsWith('- ap-pending'));
    expect(pendingLine).toContain('本番へ流してよいか');
  });

  it('この期間の日誌には未回答の行しか無いが、キューでは既に回答済み（この期間の外で回答された）', async () => {
    const stores = createMemoryStores();
    // キュー（権威ある出所）は既に回答済み——digest の窓の外（この後）で
    // 回答されたことを模す。
    await stores.jobs.putApproval({
      id: 'ap-answered-later',
      createdAt: new Date().toISOString(),
      question: 'デプロイの時間帯を変えてよいか',
      answeredAt: new Date().toISOString(),
      answer: '良い、22時以降にして',
    });
    // 日誌にはこの期間のうち「聞いた」行しか無い（「答えた」行はこの期間の
    // 外＝この digest の窓の外に積まれた、という状況を模している）。
    await stores.journal.append({
      type: 'escalation',
      question: 'デプロイの時間帯を変えてよいか',
      approvalId: 'ap-answered-later',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('デプロイの時間帯を変えてよいか →'));
    expect(line).toContain('この期間の外で回答された');
    expect(line).toContain('良い、22時以降にして');
    // 「2」（未回答でキューに在る）とは次の一手が違うので、同じ文言にしない。
    expect(line).not.toContain('承認待ちキューに在る。下の');
    expect(line).toContain('id: ap-answered-later');
  });

  it('この期間の外で回答されたが、回答の本文が無い記録（answeredAt はあるが answer が欠けている）', async () => {
    const stores = createMemoryStores();
    // 通常経路（`answerApproval`）では answeredAt と answer は必ず対で
    // 積まれるが、schema 上はどちらも独立して optional——台帳の破損などで
    // answer だけ欠けた記録を模す。
    await stores.jobs.putApproval({
      id: 'ap-answer-missing',
      createdAt: new Date().toISOString(),
      question: '欠けた回答の確認',
      answeredAt: new Date().toISOString(),
    });
    await stores.journal.append({
      type: 'escalation',
      question: '欠けた回答の確認',
      approvalId: 'ap-answer-missing',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('欠けた回答の確認 →'));
    // 空で終わらない（「中身の無い回答をもらった」と読めてしまうのを避ける）。
    expect(line).toContain('台帳の破損の可能性がある');
    // 「回答された）: 」の直後が空文字のまま終わっていない
    // （`brief(undefined, 80)` を呼んで壊れる／空で終わる、のどちらでもない）。
    expect(line).not.toMatch(/回答された\):\s*（id:/);
    expect(line).toContain('id: ap-answer-missing');
  });

  it('キューに無く managerId が在る＝マネージャー発の確認。id は requestId であって承認待ちキューの id ではない', async () => {
    const stores = createMemoryStores();
    // マネージャー発の確認はキューへ積まれない（`manager.ts` の `case
    // \'ask\'` は `putApproval` を呼ばない）——`approvalId` は `requestId`。
    await stores.journal.append({
      type: 'escalation',
      question: 'この変更を manager がマージしてよいか',
      approvalId: 'req-1234',
      managerId: 'mgr-abcd',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest
      .split('\n')
      .find((l) => l.includes('この変更を manager がマージしてよいか →'));
    expect(line).toContain('マネージャー mgr-abcd 発の確認');
    expect(line).toContain('欠落ではない');
    // **id ではなく requestId として出る。** 承認待ちキューの id と読み手が
    // 混同しない形にする（依頼者の指摘）。「id: req-1234」という素の形は
    // 出ない——出れば承認待ちキューの id だと誤読される。
    expect(line).toContain(
      'requestId: req-1234（マネージャー mgr-abcd 発。承認待ちキューの id ではない）',
    );
    expect(line).not.toContain('id: req-1234）');
  });

  it('キューにも無く managerId も無い＝判定できない。黙ってどちらか（未回答/回答あり）へ倒さない', async () => {
    const stores = createMemoryStores();
    // 通常の経路（`ask_human`）では起こらない形——`putApproval` を経ずに
    // `escalation` 行だけが積まれた状態を模す（台帳の破損・移行前の古い行
    // などを想定）。
    await stores.journal.append({
      type: 'escalation',
      question: '出所不明の確認',
      approvalId: 'ap-orphan',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('出所不明の確認 →'));
    expect(line).toContain('判定できない');
    expect(line).not.toContain('未回答（承認待ちキューに在る');
    expect(line).not.toContain('回答:');
    // managerId が無いので requestId 扱いにはしない（素の id として出す）。
    expect(line).toContain('id: ap-orphan');
  });

  it('件数の行・回答待ちの一覧・エスカレーション欄の3つが食い違わない（1問=1件として揃う。id も突き合わせられる）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-a',
      createdAt: new Date().toISOString(),
      question: '質問A',
    });
    await stores.journal.append({ type: 'escalation', question: '質問A', approvalId: 'ap-a' });
    await stores.jobs.putApproval({
      id: 'ap-b',
      createdAt: new Date().toISOString(),
      question: '質問B',
      answeredAt: new Date().toISOString(),
      answer: '回答B',
    });
    await stores.journal.append({ type: 'escalation', question: '質問B', approvalId: 'ap-b' });
    await stores.journal.append({
      type: 'escalation',
      question: '質問B',
      approvalId: 'ap-b',
      answeredAt: new Date().toISOString(),
      answer: '回答B',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    // エスカレーション: 2件（質問A・質問B）——質問Bは日誌に2行あるが1件と数える。
    expect(digest).toContain('エスカレーション: 2 件');
    // 回答待ち: 1件（質問Aだけ。質問Bは回答済みなのでここには出ない）。
    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    const pendingSection = digest.slice(digest.indexOf('## 人間の回答待ち'));
    expect(pendingSection).toContain('ap-a');
    expect(pendingSection).not.toContain('ap-b');
    // エスカレーション欄の各行にも id が出て、回答待ち一覧と機械的に
    // 突き合わせられる（質問文の一致は brief() で切られると崩れるので、
    // id で揃える——依頼者の基準3）。
    const lineA = digest.split('\n').find((l) => l.includes('質問A →'));
    expect(lineA).toContain('id: ap-a');
    const lineB = digest.split('\n').find((l) => l.includes('質問B →'));
    expect(lineB).toContain('id: ap-b');
  });

  /**
   * 束ねた後の並び順（`EscalationGroup.at` の doc）。**新しい順**——他の節
   * （`managers` の並べ替え等）と同じ向き。
   *
   * **実物の `journal.list()`（既定 `order: 'desc'`）を素直に使うと、この
   * テストは `buildActivityDigest` 側の明示的な `.sort()` を消しても赤く
   * ならない。** `journal.list()` の新しい順の契約（3実装で保証。
   * `journal-order-with-contract.ts`）のおかげで、束ねる前の入力が既に
   * 新しい順であり、`groupEscalations` の Map 挿入順もその時点で
   * 既に正しい順になっているため（`EscalationGroup.at` の doc に証明の
   * 概要がある）。**だからここでは `journal.list` をあえて契約に反する
   * 順（古い順）で返す実装に差し替え**、`buildActivityDigest` 自身の
   * `.sort()` だけを切り出して測る（`stores.commitments.list` を差し替える
   * 他のテストと同じ足場のパターン）。
   */
  it('束ねた後は at の新しい順に並ぶ（journal.list が新しい順を返す契約に頼らない防御的な並べ替えを測る）', async () => {
    const stores = createMemoryStores();
    // 古い質問を先に積む。
    await stores.journal.append({ type: 'escalation', question: '古い質問', approvalId: 'ap-old' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stores.journal.append({
      type: 'escalation',
      question: '新しい質問',
      approvalId: 'ap-new',
    });

    // **契約に反して古い順で返す。** `journal.list()` の既定は新しい順が
    // 契約だが、ここではそれを守らない実装に差し替え、
    // `buildActivityDigest` 側の並べ替えだけを切り出す。
    const originalList = stores.journal.list.bind(stores.journal);
    stores.journal.list = async (query) => [...(await originalList(query))].reverse();

    const digest = await buildActivityDigest(stores, { since: since() });
    const section = digest.slice(
      digest.indexOf('## エスカレーション'),
      digest.indexOf('## 人間の回答待ち') === -1 ? undefined : digest.indexOf('## 人間の回答待ち'),
    );
    const oldIndex = section.indexOf('古い質問');
    const newIndex = section.indexOf('新しい質問');
    expect(oldIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(oldIndex);
  });

  /**
   * **承認待ちキューの行を消す口が無い**（`JobStore` は `listApprovals` /
   * `getApproval` / `putApproval` だけ）ので、このテーブルは運用のあいだ
   * 単調に増える。`describeEscalationState` が個別に引く
   * （`stores.jobs.getApproval`）回数は、束ねて表示する分（`MAX_ITEMS`
   * 件まで）に抑えられていること——問いの総数に比例して増えないこと——を
   * 測る。
   */
  it('承認待ちキューへの個別の問い合わせ（getApproval）は MAX_ITEMS 件で頭打ちになる（総数に比例しない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 5; // 20件。表示は15件までのはず。
    for (let i = 0; i < total; i += 1) {
      // 全件「この期間の外で回答された」形にする——pendingById（未回答分）に
      // ヒットしないので、`getApproval` を呼ぶケースを作る。
      await stores.jobs.putApproval({
        id: `ap-bound-${i}`,
        createdAt: new Date().toISOString(),
        question: `束ねる問い ${i}`,
        answeredAt: new Date().toISOString(),
        answer: `回答 ${i}`,
      });
      await stores.journal.append({
        type: 'escalation',
        question: `束ねる問い ${i}`,
        approvalId: `ap-bound-${i}`,
      });
    }

    let getApprovalCalls = 0;
    let listApprovalsCalls = 0;
    const originalGetApproval = stores.jobs.getApproval.bind(stores.jobs);
    const originalListApprovals = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs.getApproval = async (id) => {
      getApprovalCalls += 1;
      return originalGetApproval(id);
    };
    stores.jobs.listApprovals = async (options) => {
      listApprovalsCalls += 1;
      // **直す前の形（`pendingOnly` を外して全件取る）へ戻っていないこと。**
      // ここが `undefined` のまま（全件取得）で呼ばれたら、行数が問いの
      // 総数に比例して増える側に逆戻りしている。
      expect(options?.pendingOnly).toBe(true);
      return originalListApprovals(options);
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`エスカレーション: ${total} 件`);
    // `listApprovals` は1回だけ（`pending` を作る分）。
    expect(listApprovalsCalls).toBe(1);
    // `getApproval` は表示する分（MAX_ITEMS）までに抑えられる。
    expect(getApprovalCalls).toBeLessThanOrEqual(MAX_ITEMS);
    expect(getApprovalCalls).toBeGreaterThan(0);
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

/**
 * Issue #783: 「外部イベント: 15,047 件」は日誌の行数までしか言えず、どの発行元
 * （source）が何件かが分からないので原因へ降りる経路が無かった。
 *
 * ## 2つの母数を混ぜない
 *
 * `buildActivityDigest` は発行元別の内訳を**2つの別ブロック**で出す——
 * (1) `createSourceTally` による**正確な総数**（`externalsCount` と同じ母数。
 * ただし追跡する source の異なり数に `DIGEST_SOURCE_TALLY_LIMIT` の上限がある）
 * と、(2) `summarizeExternalSources` による**保持した標本**（`externals` =
 * `externalBucket.retained`。`DIGEST_RETAIN_LIMIT` で頭打ち）の中の「本文の
 * 種類・最頻件数」。ここで測るのは、この2つがそれぞれ正しいこと・既存の
 * 個別行と `omitted()` 行を消していないこと・**上限を2種類（表示件数の
 * `MAX_ITEMS`、追跡する発行元数の `DIGEST_SOURCE_TALLY_LIMIT`）とも正しく
 * 扱っていること**である。
 */
describe('届いた外部イベント — 発行元（source）別の内訳（#783）', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('同じ source の同じ summary が複数件あるとき、正確な件数（source tally）と本文の形（保持した標本）がそれぞれ正しい', async () => {
    const stores = createMemoryStores();
    // source=ci: 「落ちた」が3件、「直った」が1件 ⟹ 4件・本文2種・最頻3件。
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '直った' });
    // source=webhook: 1件・本文1種・最頻1件。
    await stores.journal.append({ type: 'external_event', source: 'webhook', summary: 'ping' });

    const digest = await buildActivityDigest(stores, { since: since() });

    // (1) 正確な総数（source tally ブロック）。
    expect(digest).toContain('- ci: 4 件');
    expect(digest).toContain('- webhook: 1 件');
    // (2) 保持した標本の中の「本文の形」（別ブロック。件数は含まない）。
    expect(digest).toContain('- ci: 同じ本文は 2 種。最も多い1種が 3 件');
    expect(digest).toContain('- webhook: 同じ本文は 1 種。最も多い1種が 1 件');
    // **既存の個別行が消えていないこと。**
    expect(digest).toContain('- ci: 落ちた');
    expect(digest).toContain('- webhook: ping');
  });

  it('発行元が MAX_ITEMS を超えたとき、個別行の省略と「本文の形」側の省略が両方出る', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 3; // 18種の発行元、各1件。
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: `source-${i}`,
        summary: `届いた ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    // **既存の個別行の省略と、「本文の形」側の省略が両方出る。** どちらも
    // total=18・shown=15 なので同じ「…ほか 3 件」という部分文字列が2回出る
    // （行の続きの文言は違う——`omitted()` の `where` 引数が違うので全文としては
    // 別の行である）。2回出ることそのものを測る。**正確な総数側（source
    // tally）は `omitted()` を使わず「その他: N 件（M の発行元）」という別の
    // 文言で畳むので、ここには数えない。**
    const occurrences = digest.split('…ほか 3 件').length - 1;
    expect(occurrences).toBe(2);
    // 正確な総数側は18発行元・各1件・MAX_ITEMS=15 なので、残り3発行元・3件が
    // 「その他」へ畳まれる。
    expect(digest).toContain('- その他: 3 件（3 の発行元）');
  });

  it('既存の個別行と「…ほか N 件」が消えていない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 2;
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: 'ci',
        summary: `届いた ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('## 届いた外部イベント');
    // journal.list() は新しい順（desc）で返すので、確実に残る（切られない）のは
    // 最後に append した最新の1件である。
    expect(digest).toContain(`- ci: 届いた ${total - 1}`);
    expect(digest).toContain('…ほか 2 件');
    expect(digest).toContain('発行元（source）別の件数');
  });

  it('内訳（source tally）の合計が、外部イベントの正確な総数（externalsCount）と一致する（上限に当たらない場合）', async () => {
    const stores = createMemoryStores();
    // 5発行元・件数 5,4,3,2,1（合計15）。DIGEST_SOURCE_TALLY_LIMIT にも
    // MAX_ITEMS にも当たらない。
    const counts = [5, 4, 3, 2, 1];
    for (const [i, count] of counts.entries()) {
      for (let j = 0; j < count; j += 1) {
        await stores.journal.append({
          type: 'external_event',
          source: `src-${i}`,
          summary: `evt-${i}-${j}`,
        });
      }
    }
    const total = counts.reduce((sum, count) => sum + count, 0);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    for (const [i, count] of counts.entries()) {
      expect(digest).toContain(`- src-${i}: ${count} 件`);
    }
    // **内訳の合計 == externalsCount。** 個々の行を上で確かめてあるので、
    // その合計を独立に計算して突き合わせる（実装の出力を鵜呑みにしない）。
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total);
    // 上限に当たっていないので、「その他」も上限超過も出ない。
    expect(digest).not.toContain('その他:');
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  /**
   * **直上の歯は弱い。** 合計15件・`DIGEST_RETAIN_LIMIT`（200）に遠く届かない
   * 入力だったので、`externals`（保持の上限で切られた側）から作る内訳
   * （#1322 が最初に main へ入れた設計）でも同じ答えを返せてしまう——実際に
   * 素朴合成した「#1322 のまま・再設計前」の digest.ts で回すと、この歯は
   * **緑のまま**だった（部分文字列一致でたまたま通っていた）。
   *
   * **この歯はそれを強くする。** `DIGEST_RETAIN_LIMIT`（200）を**複数
   * source に跨いで**大きく超える入力を積み、(1) 内訳の合計が
   * `externalsCount` と厳密に一致すること (2) 個々の発行元の件数が
   * `DIGEST_RETAIN_LIMIT` 単体の上限より大きい——つまり**保持配列
   * （最大 `DIGEST_RETAIN_LIMIT` 件）だけからは絶対に導出できない値**である
   * こと、の両方を当てる。(2) は具体的な interleave 順序に依存しない
   * ——1つの source の真の件数が保持の上限そのものを超えていれば、
   * どんな順序で日誌を積んでも保持配列（$\le$ `DIGEST_RETAIN_LIMIT` 件）
   * からその値を出すことは原理的にできない。
   */
  it('内訳（source tally）の合計が externalsCount と厳密に一致する（複数 source が DIGEST_RETAIN_LIMIT を跨ぐ場合。保持側だけでは出せない値であることも当てる）', async () => {
    const stores = createMemoryStores();
    // source-a: DIGEST_RETAIN_LIMIT より20多い件数——この1 source だけで
    // 保持配列の上限を超える（保持側からは絶対に導出できない値にする）。
    const countA = DIGEST_RETAIN_LIMIT + 20;
    // source-b: 別の90件。2 source の合計が DIGEST_RETAIN_LIMIT の1.5倍を
    // 超える（保持配列1本では2つの source の真の内訳を両方保持できない）。
    const countB = 90;
    for (let j = 0; j < countA; j += 1) {
      await stores.journal.append({ type: 'external_event', source: 'source-a', summary: `a${j}` });
    }
    for (let j = 0; j < countB; j += 1) {
      await stores.journal.append({ type: 'external_event', source: 'source-b', summary: `b${j}` });
    }
    const total = countA + countB;
    expect(countA).toBeGreaterThan(DIGEST_RETAIN_LIMIT); // 保持側では出せない値であることの前提
    expect(total).toBeGreaterThan(DIGEST_RETAIN_LIMIT); // 保持の上限を跨ぐことの前提

    const digest = await buildActivityDigest(stores, { since: since() });

    // 見出し（externalsCount）。
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    // 個々の発行元の件数——件数降順なので source-a が先。
    expect(digest).toContain(`- source-a: ${countA} 件`);
    expect(digest).toContain(`- source-b: ${countB} 件`);
    // **内訳の合計 == externalsCount。** 実装の出力を鵜呑みにせず、独立に
    // 計算した合計と突き合わせる。
    expect(countA + countB).toBe(total);
    // 2 source だけなので折り畳み・上限超過は出ない。
    expect(digest).not.toContain('その他:');
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  it('内訳（source tally）の件数は保持の上限（DIGEST_RETAIN_LIMIT）ではなく総数を数えている', async () => {
    const stores = createMemoryStores();
    // 1つの source に DIGEST_RETAIN_LIMIT の1.5倍ぶん積む——保持配列は
    // DIGEST_RETAIN_LIMIT で頭打ちになるが、source tally は保持の外で数える。
    const total = Math.floor(DIGEST_RETAIN_LIMIT * 1.5);
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({ type: 'external_event', source: 'ci', summary: `e${i}` });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(total).toBeGreaterThan(DIGEST_RETAIN_LIMIT);
    // **retained（200件）ではなく、総数（300件）を名乗る。**
    expect(digest).toContain(`- ci: ${total} 件`);
    expect(digest).not.toContain(`- ci: ${DIGEST_RETAIN_LIMIT} 件`);
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
  });

  it('表示上限（MAX_ITEMS）を超えた追跡済み発行元が「その他: N 件（M の発行元）」へ畳まれ、N と M が正しい（N ≠ M）', async () => {
    const stores = createMemoryStores();
    // MAX_ITEMS より5多い数の発行元。件数はランク付け（先頭が最多、末尾が1件）
    // ——「その他」に畳まれる件数（N）と発行元の数（M）が異なることを測るため、
    // 均等な件数（全部1件）は使わない。DIGEST_SOURCE_TALLY_LIMIT には当たらない
    // 数に留める（この it は表示上限だけを測る）。
    const sourceCount = MAX_ITEMS + 5;
    expect(sourceCount).toBeLessThan(DIGEST_SOURCE_TALLY_LIMIT); // 上限超過は起きない
    const counts = Array.from({ length: sourceCount }, (_, i) => sourceCount - i);
    for (const [i, count] of counts.entries()) {
      for (let j = 0; j < count; j += 1) {
        await stores.journal.append({
          type: 'external_event',
          source: `src-${String(i).padStart(2, '0')}`,
          summary: `e${i}-${j}`,
        });
      }
    }
    const total = counts.reduce((sum, count) => sum + count, 0);
    const shownCounts = counts.slice(0, MAX_ITEMS);
    const foldedCounts = counts.slice(MAX_ITEMS);
    const foldedTotal = foldedCounts.reduce((sum, count) => sum + count, 0);

    const digest = await buildActivityDigest(stores, { since: since() });

    // 上位 MAX_ITEMS 件は個別に出る。
    for (const [i, count] of shownCounts.entries()) {
      expect(digest).toContain(`- src-${String(i).padStart(2, '0')}: ${count} 件`);
    }
    // 残り（`foldedCounts.length` 発行元）が畳まれる。
    // N（畳んだ件数＝`foldedTotal`）と M（畳んだ発行元の数＝`foldedCounts.length`）
    // はランク付けの構成上、必ず異なる（N ≠ M であることが要点）。
    expect(foldedTotal).not.toBe(foldedCounts.length);
    expect(digest).toContain(`- その他: ${foldedTotal} 件（${foldedCounts.length} の発行元）`);
    // 不変条件: shown の合計 + foldedTotal + overflowCount(=0) === externalsCount。
    const shownTotal = shownCounts.reduce((sum, count) => sum + count, 0);
    expect(shownTotal + foldedTotal).toBe(total);
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  it('追跡する発行元数の上限（DIGEST_SOURCE_TALLY_LIMIT）を超えたとき、超過ぶんの件数が出力に現れ、内訳の合計＋その他＋上限超過が externalsCount と一致する', async () => {
    const stores = createMemoryStores();
    // DIGEST_SOURCE_TALLY_LIMIT より多い数の発行元、各1件。journal.list() は
    // push の逆順（新しい順）で走査するので、**後から append した発行元ほど
    // 先に scan される**——最初に scan される DIGEST_SOURCE_TALLY_LIMIT 個
    // （最後に append した分）が追跡され、それより前に append した分（
    // `overflowSourceCount` 個）が上限超過（overflow）になる。
    const overflowSourceCount = MAX_ITEMS - 1; // MAX_ITEMS と DIGEST_SOURCE_TALLY_LIMIT 両方に当てる
    const sourceCount = DIGEST_SOURCE_TALLY_LIMIT + overflowSourceCount;
    for (let i = 0; i < sourceCount; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: `src-${String(i).padStart(3, '0')}`,
        summary: `e${i}`,
      });
    }
    // 追跡される発行元（scan 順で先頭 DIGEST_SOURCE_TALLY_LIMIT 個 ＝ 最後に
    // append した分）は `overflowSourceCount` 〜 `sourceCount - 1`。件数は
    // 全部1件なので、source 名の昇順に並ぶ（`createSourceTally.rows` の
    // タイブレーク）。
    const trackedStart = overflowSourceCount;
    const trackedSources = Array.from(
      { length: DIGEST_SOURCE_TALLY_LIMIT },
      (_, i) => trackedStart + i,
    );
    const shownSources = trackedSources.slice(0, MAX_ITEMS);
    const foldedSources = trackedSources.slice(MAX_ITEMS);

    const digest = await buildActivityDigest(stores, { since: since() });

    for (const i of shownSources) {
      expect(digest).toContain(`- src-${String(i).padStart(3, '0')}: 1 件`);
    }
    // 追跡された残り（`foldedSources.length` 発行元、各1件）が「その他」へ畳まれる。
    expect(digest).toContain(
      `- その他: ${foldedSources.length} 件（${foldedSources.length} の発行元）`,
    );
    // 上限を超えて現れた発行元（`overflowSourceCount` 個）ぶんの件数は捨てず
    // 件数として出す——ただし発行元の数は数えない（原理的に出せない）。
    expect(digest).toContain(
      `- 上限（\`DIGEST_SOURCE_TALLY_LIMIT\`）を超えて現れた発行元: ${overflowSourceCount} 件（発行元の数は数えていない`,
    );
    // 不変条件: shown + folded + overflow === externalsCount。
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${sourceCount} 件`);
    expect(shownSources.length + foldedSources.length + overflowSourceCount).toBe(sourceCount);
  });
});

/**
 * **未了の節が「古い順で先頭 `MAX_ITEMS` 件」だと、今夜作った行が digest に
 * 1件も出ない。** 未了は `CommitmentStore.list()` の契約で `at` 昇順（古い順）
 * に来るので、先頭から切ると新しい行は常に切られた側に落ちる。⟹ 古い側と
 * 新しい側の**両端**を出すように直した——ただし合計は `MAX_ITEMS` のまま
 * （件数の床を上げない）。
 *
 * **③の要件（依頼者の指定）: 「古い側だけを測る歯では直さなくても通る」** ので、
 * ここは毎回「最古の行」と「最新の行」の**両方**が出ることを確かめる。加えて、
 * 真ん中の行が出ないこと（＝件数の床が上がっていないこと）と、重なり
 * （同じ id が2回出る）が無いことも測る。
 */
describe('引き受けたまま終わっていない仕事: 古い側と新しい側の両端を出す', () => {
  const since = () => new Date(Date.now() - 60_000);

  /** `at` を1件ずつ進め、古い→新しいの順を `i` の昇順に固定する。 */
  const seedCommitments = async (stores: ReturnType<typeof createMemoryStores>, count: number) => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < count; i += 1) {
      await stores.commitments.open({
        id: `cm-edge-${i}`,
        at: new Date(base + i * 1000).toISOString(),
        origin: 'human',
        body: `未了 ${i}`,
      });
    }
  };

  /** digest の中に `cm-edge-${i}（` が出ている `i` の一覧（`（` の直前で境界を作り、
   * `cm-edge-1` が `cm-edge-10` の部分文字列として誤って一致しないようにする）。 */
  const shownIndices = (digest: string, total: number) =>
    Array.from({ length: total }, (_, i) => i).filter((i) => digest.includes(`cm-edge-${i}（`));

  it('未了が MAX_ITEMS より十分多いとき、最古の行と最新の行が両方出る', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25; // 40件。
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('cm-edge-0（'); // 最古
    expect(digest).toContain(`cm-edge-${total - 1}（`); // 最新
  });

  it('真ん中の行は出ない（両端に絞れている＝件数の床が上がっていない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25; // 40件。真ん中は index 8〜32（25件）のはず。
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('cm-edge-20（');
  });

  it('出す件数は常に MAX_ITEMS のまま、かつ重なりが無い（同じ id が2回出ない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25; // 40件。
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    const shown = shownIndices(digest, total);
    expect(shown).toHaveLength(MAX_ITEMS);
    for (const i of shown) {
      const needle = `cm-edge-${i}（`;
      expect(digest.split(needle).length - 1).toBe(1);
    }
  });

  it('省略の断り書きが、省いた件数（真ん中の件数）を正しく言う', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25; // 40件 − 15件 = 25件を省く。
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 25 件');
    // **省いたのは末尾（新しい側の続き）ではなく真ん中であること**を文言で言う。
    expect(digest).toContain('真ん中を省いている');
    expect(digest).toContain('commitment_list');
  });

  it('境界: ちょうど MAX_ITEMS 件なら全件が出て、省略は1件も出ない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(shownIndices(digest, total)).toHaveLength(total);
    expect(digest).not.toContain('…ほか');
  });

  it('境界: MAX_ITEMS 未満なら全件が出て、省略は1件も出ない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS - 3;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(shownIndices(digest, total)).toHaveLength(total);
    expect(digest).not.toContain('…ほか');
  });

  it('境界: MAX_ITEMS + 1 件なら、両端は残り真ん中の1件だけが省かれる（重なりなし）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 1;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    const shown = shownIndices(digest, total);
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(shown.length + 1).toBe(total);
    expect(digest).toContain('cm-edge-0（');
    expect(digest).toContain(`cm-edge-${total - 1}（`);
    expect(digest).toContain('…ほか 1 件');
    for (const i of shown) {
      const needle = `cm-edge-${i}（`;
      expect(digest.split(needle).length - 1).toBe(1);
    }
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

    // マネージャー。**全件に `lastFailure` を持たせる**（Issue #714 3面目）。
    // これが無いと worst case が「日報が lastFailure を読んで1行足す」ぶんの
    // 伸びを測らないまま固定されてしまう——実際、この行を足す前は
    // `lastFailure` を1件もセットしておらず、`describeLastFailureLine`
    // （`digest.ts`）を足しただけではこの it は1文字も動かなかった。
    for (let i = 0; i < COUNT; i += 1) {
      await stores.jobs.putJob({
        id: `mgr-worst-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `依頼本文 ${i} ${long(300)}`,
        lastReport: `直近の報告 ${i} ${long(300)}`,
        lastFailure: {
          code: `billing_error-${i}-${long(20)}`,
          via: `stream_event-${i}-${long(20)}`,
          at: now,
        },
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
    '## 引き受けたまま終わっていない仕事' +
      '（古い側と新しい側の両端。入り切らない分は真ん中を省く。' +
      '片付いたら `commitment_close` で閉じる）',
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
   *
   * **2026-09-12 追記（Issue #714 3面目）。** マネージャー節の fixture に
   * `lastFailure` を足した（`digest.ts` の `describeLastFailureLine` が
   * 読むようになった欄——直す前は1件もセットしておらず、この歯が実際の
   * worst case を測れていなかった）。この追記後の実測は **45,389 文字**
   * （同じく `process.stderr.write` の生出力）で、47,000 の枠にはまだ収まる
   * （余裕 1,611 文字）。**予算そのものは上げていない**——収まっている間は
   * 上げる理由が無い（`prompt.ts` の `PROMPT_CHARACTER_BUDGET` との関係は
   * そちらのファイルを参照。今回の追記でこの digest 側の枠も
   * `PROMPT_CHARACTER_BUDGET` 側の枠も、どちらも超えていない）。
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

/**
 * Issue #857: `lost` / `failed` の警告に順位を付ける分類と、その字面。
 *
 * **直した穴**: `manager_list` は `lost` の行すべてに同じ注記を出していた。
 * ほぼ常に真なので順位が付かず、依頼者（クローン）は1本ずつ `gh` を叩いて
 * 成果の所在を測るしかなかった。
 *
 * ここで測るのは**純関数のふるまい**である（一覧に配線した結果は
 * `tools.test.ts` の同名の節が測る）。
 */
describe('#857: 終端していて誰も望んでいない終わり方（lost / failed）を分類する', () => {
  function input(over: Partial<UnobservedOutcomeInput> = {}): UnobservedOutcomeInput {
    return {
      status: 'lost',
      ...over,
    };
  }

  const FAILURE = {
    code: 'billing_error',
    via: 'assistant_error',
    at: '2026-09-12T01:00:00.000Z',
  } as const;

  describe('isManagerOutcomeUnobserved（述語）', () => {
    it('lost と failed だけが真である', () => {
      expect(isManagerOutcomeUnobserved('lost')).toBe(true);
      expect(isManagerOutcomeUnobserved('failed')).toBe(true);
    });

    /**
     * ⭐ **対象外の4値が偽であること。** これが無いと「常に真」を返す実装でも
     * 上の歯は緑になる（`describeManagerFailure` の「`null` は1文字も増やさない」
     * と同じ形の陰性側）。
     */
    it('⭐ running / waiting_human / done / stopped は偽である', () => {
      for (const status of ['running', 'waiting_human', 'done', 'stopped'] as const) {
        expect(isManagerOutcomeUnobserved(status), `${status} が対象に入っている`).toBe(false);
      }
    });

    /**
     * ⛔ **`isManagerAwaitingJudgement` を書き換えていないこと**（日報の #688 の
     * 判断を握っているので、`failed` を足すと群の境界が動く）。**新しい述語は
     * 別に足した**、を歯で固定する。
     */
    it('⛔ isManagerAwaitingJudgement は lost 1値のままである（failed を飲み込んでいない）', () => {
      expect(isManagerAwaitingJudgement('lost')).toBe(true);
      expect(isManagerAwaitingJudgement('failed')).toBe(false);
    });
  });

  describe('順位の芯: 依頼者に本文が届いているか', () => {
    it('lastReport が無ければ none（rank 0。最優先）', () => {
      const outcome = classifyUnobservedOutcome(input());
      expect(outcome?.reportState).toBe('none');
      expect(outcome?.rank).toBe(0);
    });

    it('lastReport が在り lastFailure も在れば failure-wrapped（rank 1）', () => {
      const outcome = classifyUnobservedOutcome(
        input({
          lastReport: '（このターンは応答を返さずに終わった: billing_error）',
          lastFailure: FAILURE,
        }),
      );
      expect(outcome?.reportState).toBe('failure-wrapped');
      expect(outcome?.rank).toBe(1);
    });

    it('lastReport が在り lastFailure が無ければ delivered（rank 2）', () => {
      const outcome = classifyUnobservedOutcome(input({ lastReport: '終わった' }));
      expect(outcome?.reportState).toBe('delivered');
      expect(outcome?.rank).toBe(2);
    });

    /**
     * ⭐ **空文字の `lastReport` は `none` ではない。** 判定は
     * `lastReport === undefined` であって「空かどうか」ではない——
     * `manager.ts` の `case 'report'` が書き込んだ事実そのものを見ている。
     */
    it('⭐ lastReport が空文字でも「届いていない」とは言わない（undefined とは別）', () => {
      expect(classifyUnobservedOutcome(input({ lastReport: '' }))?.reportState).toBe('delivered');
    });

    it('failed でも同じ3値が立つ（lost 専用の軸ではない）', () => {
      expect(classifyUnobservedOutcome(input({ status: 'failed' }))?.reportState).toBe('none');
      expect(
        classifyUnobservedOutcome(
          input({ status: 'failed', lastReport: 'x', lastFailure: FAILURE }),
        )?.reportState,
      ).toBe('failure-wrapped');
    });
  });

  /**
   * **対象外の委譲では `null`（＝字面は1文字も出ない）。** これが無いと
   * 「条件を外して常に出す」実装でも上の歯は全部緑になる
   * （`describeManagerFailure` の「`null` は1文字も増やさない」と同じ形）。
   */
  it('⭐ 対象外の委譲は null（分類も字面も出ない）', () => {
    for (const status of ['running', 'waiting_human', 'done', 'stopped'] as const) {
      expect(classifyUnobservedOutcome(input({ status })), status).toBeNull();
      expect(describeUnobservedOutcome(input({ status })), status).toBeNull();
    }
  });

  describe('字面（describeUnobservedOutcome）', () => {
    /**
     * ⭐ **3値それぞれで別の文が出る。** 「どれかの文が出る」ではなく
     * **互いに違う**ことを測る——同じ文を3つ返す実装を通さない。
     */
    it('⭐ 3値は互いに違う文になる', () => {
      const none = describeUnobservedOutcome(input());
      const wrapped = describeUnobservedOutcome(input({ lastReport: 'x', lastFailure: FAILURE }));
      const delivered = describeUnobservedOutcome(input({ lastReport: 'x' }));
      expect(new Set([none, wrapped, delivered]).size).toBe(3);
    });

    /**
     * ⭐ **入れ替えると赤くなる。** 各値に固有の語を名指しし、**他の2値では
     * その語が出ないこと**まで測る（片側だけだと、3つとも同じ語を含む実装が
     * 通る）。
     *
     * **行の選定に文言を使っていない**——`describeUnobservedOutcome` を値ごとに
     * 直接呼んでいるので、足場は測っている字面を1文字も含まない形で対象を
     * 特定している（AGENTS.md「対象をスコープして特定する」）。
     */
    it('⭐ 3値に固有の語が在り、他の2値には出ない（入れ替えると赤くなる）', () => {
      const texts: Record<UnobservedReportState, string> = {
        none: describeUnobservedOutcome(input())!,
        'failure-wrapped': describeUnobservedOutcome(
          input({ lastReport: 'x', lastFailure: FAILURE }),
        )!,
        delivered: describeUnobservedOutcome(input({ lastReport: 'x' }))!,
      };
      const signature: Record<UnobservedReportState, string> = {
        none: '終端までに本文が1文字も届いていない',
        'failure-wrapped': '包んだエラー文であって報告ではない',
        delivered: '完遂した報告とは限らない',
      };
      for (const [state, word] of Object.entries(signature) as [UnobservedReportState, string][]) {
        expect(texts[state], `${state} に固有の語が無い`).toContain(word);
        for (const other of Object.keys(signature) as UnobservedReportState[]) {
          if (other === state) continue;
          expect(texts[other], `${other} に ${state} の語が漏れている`).not.toContain(word);
        }
      }
    });

    /**
     * 🔴 **どの枝でも「成果が無い」と断定しない。** 3値（`none` /
     * `failure-wrapped` / `delivered`）全部を通す——1つの枝だけ直した実装を
     * 通さない。
     */
    it('🔴 どの枝でも「成果が無い」と断定する語を出さない', () => {
      const reports: Partial<UnobservedOutcomeInput>[] = [
        {},
        { lastReport: 'x', lastFailure: FAILURE },
        { lastReport: 'x' },
      ];
      for (const report of reports) {
        const text = describeUnobservedOutcome(input(report))!;
        expect(text, `${JSON.stringify(report)}`).not.toBeNull();
        for (const forbidden of ['成果が無い', '成果は無い', '成果なし', '成果が無かった']) {
          expect(text, `断定の語（${forbidden}）が出ている`).not.toContain(forbidden);
        }
      }
    });
  });
});

/**
 * OOM の本体を直す（issue #1283）。`buildActivityDigest` の `stores.journal.list()`
 * は、直す前は `limit` を渡さずに窓の全行を1クエリでヒープへ載せていた——pg 実装は
 * `limit` 省略時に `Number.MAX_SAFE_INTEGER` を渡す
 * （`grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）
 * ので、窓の中身が多い日（実測: ある1日で約247万行・約1.4GB）にそれを1クエリで
 * 読もうとして落ちる。
 *
 * **⛔「`limit` を渡している」を見るだけの歯にしない。** `createSyntheticJournalStore`
 * （`journal-scan.test-support.ts`）は、有限の `limit` が渡らないと**その場で
 * 例外を投げる**——本番の穴と同じ形を再現させない偽物である。それに加えて、
 * この偽物が**実際に返した行の総数**（`totalReturned`）を数えることで、
 * 「窓に大量の行が在るときにヒープへ載る量が抑えられているか」を直接測る。
 */
describe('OOM の本体を直す（issue #1283）— 日誌走査をページ単位に有界化する', () => {
  /**
   * `journal` 以外（`jobs` / `schedules` / `commitments` / `persona` /
   * `usage` 等）は、この依頼で触っていない口——本物の in-memory 実装のまま
   * （空の状態）でよい。
   */
  function storesWithSyntheticJournal(journal: Stores['journal']): Stores {
    return { ...createMemoryStores(), journal };
  }

  it('⭐ 窓に大量の tool_use 行があっても、渡した limit は常に有限で、渡ってきた総件数が上限で頭打ちになる（ヒープが有界であることの代理指標）', async () => {
    // **`total` は固定の数値リテラルにする（`DIGEST_JOURNAL_SCAN_LIMIT` から
    // 掛け算で作らない）。** 変異試験でこの定数を `Number.MAX_SAFE_INTEGER`
    // へ変えたとき、`定数 * 3` は `Infinity` になり、`createSyntheticJournalStore`
    // の `total` が `Infinity` になって偽ストアの走査が終わらなくなる
    // （実測 2026-09-23——変異試験の実走行でこの歯そのものが無限に近い時間
    // 止まり、テストの生存/検出のどちらでもない「壊れた計測」を作った）。
    // **本番の窓のサイズ（=実際の日誌の行数）は、この digest 側の定数を
    // 見ているわけではない**ので、テストの規模を定数から独立させても
    // 実態との乖離は無い——`DIGEST_JOURNAL_SCAN_LIMIT` を変えても
    // `total` は動かないほうが、むしろ定数の値そのものを変異させたときの
    // 挙動の違いを素直に測れる（下のアサーションを参照）。
    const total = 150_000;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: () => ({ type: 'tool_use', actor: 'manager:mgr-oom', tool: 'Bash', input: {} }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    // **渡した総件数（＝ヒープへ載りうる量の代理指標）が、実装の上限＋
    // 1ページぶんで頭打ちになる。** `total`（上限の3倍）までは伸びない——
    // 直す前は `journal.list()` が窓の全行（この偽物では `total` 件）を
    // 1回で読もうとし、まず「limit は有限でなければならない」という
    // この偽物自身の検算にすら引っかかって落ちる。
    expect(fake.totalReturned).toBeLessThanOrEqual(
      DIGEST_JOURNAL_SCAN_LIMIT + JOURNAL_SCAN_PAGE_SIZE,
    );
    expect(fake.totalReturned).toBeLessThan(total);

    // **全呼び出しが有限の limit を持つ。** `undefined` にも
    // `Number.MAX_SAFE_INTEGER` にもならない——pg 実装の穴と同じ形を
    // この呼び出し側が再現していないことの直接の検算。
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(Number.isFinite(call.limit)).toBe(true);
      expect(call.limit).toBeGreaterThan(0);
    }

    // **往復の回数も有界。** 「起動時に数千クエリが走る」形になっていない
    // ことを、往復の本数そのもので確かめる。
    expect(fake.calls.length).toBeLessThan(250);

    // **打ち切ったことを名乗る。** 定数の名前で指す（値をここへ焼き込まない
    // ——AGENTS.md「件数・版・sha などの数を生成物へ焼き込まない」）。
    expect(digest).toContain('DIGEST_JOURNAL_SCAN_LIMIT');

    // **打ち切っても、走査した範囲の件数は正確——保持した配列の `.length` を
    // 読んでいない。** 全部 `manager:` アクター（delegated）で作ってあるので、
    // そのカウンタは走査した総件数とちょうど一致する。
    expect(digest).toContain(`マネージャー・作業者のツール実行: ${DIGEST_JOURNAL_SCAN_LIMIT} 件`);
  });

  it('打ち切っていない普通の窓では、件数が正確で、打ち切りの名乗りが出力に無い', async () => {
    const total = 12;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => {
        if (index % 4 === 0) {
          return { type: 'decision', decision: `decision-${index}`, grounds: 'g' };
        }
        if (index % 4 === 1) {
          return {
            type: 'memory_update',
            slug: 'values',
            cause: 'clone',
            summary: `memo-${index}`,
          };
        }
        if (index % 4 === 2) {
          return { type: 'external_event', source: 'ci', summary: `event-${index}` };
        }
        return { type: 'tool_use', actor: 'clone', tool: 'Bash', input: {} };
      },
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 3 件');
    expect(digest).toContain('記憶の更新: 3 件');
    expect(digest).toContain('外部イベント（日誌 external_event の行数）: 3 件');
    expect(digest).toContain('あなた自身が手を動かした回数（委譲せずに使った道具）: 3 件');
  });

  it('保持の上限（DIGEST_RETAIN_LIMIT）を超えた種別があっても、走査そのものは打ち切っておらず、件数はカウンタの値で正確なまま（保持した配列の .length から取っていない）', async () => {
    // decision だけを DIGEST_RETAIN_LIMIT の1.5倍ぶん積む。走査全体の上限
    // （DIGEST_JOURNAL_SCAN_LIMIT）よりずっと少ないので、走査は打ち切らない
    // ——保持の上限（詳細一覧を残す配列の大きさ）にだけ当たる。件数を
    // `decisions.length`（保持した配列の長さ＝ DIGEST_RETAIN_LIMIT で頭打ち）
    // から取っていれば、この件数は少なく出る。
    const total = Math.floor(DIGEST_RETAIN_LIMIT * 1.5);
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({ type: 'decision', decision: `decision-${index}`, grounds: 'g' }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');
    expect(digest).toContain(`自分で決めたこと（日誌の decision）: ${total} 件`);
    // 一覧側は MAX_ITEMS 件のまま（保持の上限に当たっていても、新しい側
    // MAX_ITEMS 件は変わらない）。
    const shown = digest.split('\n').filter((row) => row.includes('decision-')).length;
    expect(shown).toBe(MAX_ITEMS);
    // 省いた件数の断りも、保持した配列の長さではなく正確な件数から引く
    // （`omitted()` へ渡す `total` が `decisionsCount` であることの検算）。
    expect(digest).toContain(`…ほか ${total - MAX_ITEMS} 件`);
  });

  it('exchange の走査は with: ["human"] をストア側へ渡す（人間以外の往復が limit の予算を食わない。issue #418 と同じ形の再発を防ぐ歯）', async () => {
    // 最新（index 0）から大量の with:'manager' の exchange で埋め、
    // いちばん古い1件だけ with:'human', role:'inbound' にする。`with` を
    // クエリ側で渡さず `types: ['exchange']` だけで引いていたら、この
    // 人間の発言に辿り着く前に走査の上限へ当たって0件のまま終わる——
    // issue #418 が直した穴と同じ形を、この digest の走査で再発させない
    // ための歯である。
    // **`total` は固定の数値リテラル**（上の歯の doc と同じ理由——
    // `DIGEST_JOURNAL_SCAN_LIMIT` から掛け算で作ると、変異試験でその定数を
    // 変えたときに `total` が `Infinity` になり、偽ストアの走査が終わらなく
    // なる）。
    const total = 150_001;
    const humanIndex = total - 1;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) =>
        index === humanIndex
          ? { type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' }
          : { type: 'exchange', with: 'manager', role: 'outbound', text: 'ノイズ' },
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    // **クエリそのものを検算する。** カウントの一致だけでは「たまたま」を
    // 否定できない——実際に `with: ['human']` が渡っていることを直接見る。
    const exchangeCalls = fake.calls.filter((call) => call.types?.includes('exchange'));
    expect(exchangeCalls.length).toBeGreaterThan(0);
    for (const call of exchangeCalls) {
      expect(call.with).toEqual(['human']);
    }

    // **その結果として、人間の発言が正しく1件と数えられる。** `with` が
    // クエリ側に無ければ、`total` 件の大半（with:'manager'）が走査の
    // 予算を食い、この発言が窓の外へ落ちて 0 件になる。
    expect(digest).toContain('人間からの発言: 1 件');
  });

  it('escalation の保持上限に当たったときは、件数の行に「束ねた元の行を全部は読んでいない」という注記が付く', async () => {
    const total = DIGEST_RETAIN_LIMIT + 50;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({
        type: 'escalation',
        question: `question-${index}`,
        approvalId: `ap-${index}`,
      }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    // この窓の走査そのものは打ち切っていない（`total` は
    // `DIGEST_JOURNAL_SCAN_LIMIT` よりずっと小さい）——escalation 特有の
    // 「保持の上限」と、走査全体の「打ち切り」は別の事情であることの確認。
    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');

    const line = digest.split('\n').find((row) => row.startsWith('- エスカレーション:'));
    expect(line).toBeDefined();
    expect(line).toContain('束ねた元の行を全部は読んでいない');
  });

  it('escalation の保持上限に当たっていないときは、件数の行に注記が付かない（既存の文面を1文字も変えない）', async () => {
    const fake = createSyntheticJournalStore({
      total: 3,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({
        type: 'escalation',
        question: `question-${index}`,
        approvalId: `ap-${index}`,
      }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    const line = digest.split('\n').find((row) => row.startsWith('- エスカレーション:'));
    expect(line).toBe('- エスカレーション: 3 件');
  });
});
