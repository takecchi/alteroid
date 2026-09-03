import { describe, expect, it } from 'vitest';

import { buildActivityDigest, describeManagerState, MAX_ITEMS } from './digest.js';
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
