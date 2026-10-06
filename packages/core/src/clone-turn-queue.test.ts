import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone, humanTurnText } from './clone.js';
import type { HumanMessage } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, wireEvents, waitFor } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

describe('humanTurnText（ターン本文の組み立て）', () => {
  const message = (text: string, at: string): HumanMessage => ({
    type: 'human_message',
    id: `evt-${text}`,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('1件なら本文そのまま（1文字も足さない）', () => {
    expect(humanTurnText([message('やあ', '2026-08-20T10:00:00.000Z')])).toBe('やあ');
  });

  /**
   * issue #955: 機械由来の束（`managerReportBatchPrompt`）には文字数の予算を
   * 掛けたが、**人間の発言には掛けていない**（意図的）。人間の言葉を機械が
   * 黙って切ると north_star 禁止1（人間にできることがこの層でできないなら
   * バグ）に当たる——人間は Web UI で全文を送っているのに、クローンだけが
   * 黙って切られた版を受け取る形になるため。この歯は、その決定が今後も
   * 保たれることを確かめる（大きな発言を切らずに1文字も削らずに通す）。
   */
  it('issue #955: 巨大な人間の発言（10万字）も1文字も切らずに通す（切ってはいけない）', () => {
    const huge = '先頭' + 'x'.repeat(100_000) + '末尾';
    expect(humanTurnText([message(huge, '2026-08-20T10:00:00.000Z')])).toBe(huge);
  });

  it('複数件は全文を届いた順に並べ、各件の時刻を添える', () => {
    const text = humanTurnText([
      message('AAA', '2026-08-20T10:00:00.000Z'),
      message('BBB', '2026-08-20T10:00:09.000Z'),
    ]);

    // issue #783 の続き：「N件が届いた」ではなく「N件をまとめて渡す」（束の
    // 件数であって届いた総数ではないため、上限で切っても偽にならない言い方）。
    expect(text).toContain('続けて **2 件** まとめて渡す');
    expect(text).toContain('AAA');
    expect(text).toContain('BBB');
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('BBB'));
    // 「3分空けて言い直した」と「続けて3行打った」を読み分ける材料はクローンへ渡す
    expect(text).toContain('2026-08-20T10:00:00.000Z');
    expect(text).toContain('2026-08-20T10:00:09.000Z');
  });

  it('1件も無ければ空文字（呼び出し側が先頭を仮定しない）', () => {
    expect(humanTurnText([])).toBe('');
  });

  it('supersedes が無ければ、priorTexts を渡していても1文字も足さない', () => {
    const event = message('やあ', '2026-08-20T10:00:00.000Z');
    const priorTexts = new Map([[event.id, '無関係な本文']]);
    expect(humanTurnText([event], priorTexts)).toBe('やあ');
  });

  it('supersedes があれば、編集である合図を前置きする（issue「チャットの送信済みメッセージを編集する」）', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const text = humanTurnText([event]);
    // 合図そのもの（旧本文が引けなくても、編集である事実は失わない）
    expect(text).toContain('これは既出発言（id=evt-old）の編集である');
    expect(text).toContain('編集前の本文は引けなかった');
    // 新しい本文も届く
    expect(text).toContain('直した本文');
  });

  it('supersedes があり priorTexts が引けていれば、編集前の本文も渡す', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const priorTexts = new Map([[event.id, '元の本文']]);
    const text = humanTurnText([event], priorTexts);
    expect(text).toContain('これは既出発言（id=evt-old）の編集である');
    expect(text).toContain('元の本文');
    expect(text).toContain('直した本文');
    // 編集前の本文が先、新しい本文が後
    expect(text.indexOf('元の本文')).toBeLessThan(text.indexOf('直した本文'));
  });

  it('複数件のうち1件だけが編集でも、バッチの文面でどれが編集かが分かる', () => {
    const plain = message('ふつうの発言', '2026-08-20T10:00:00.000Z');
    const edited: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:00:09.000Z'),
      supersedes: 'evt-old',
    };
    const priorTexts = new Map([[edited.id, '元の本文']]);
    const text = humanTurnText([plain, edited], priorTexts);
    expect(text).toContain('ふつうの発言');
    expect(text).toContain('（既出発言の編集）');
    expect(text).toContain('元の本文');
    expect(text).toContain('直した本文');
    // 編集ではない (1) 件目には合図が付かない
    const firstBlockEnd = text.indexOf('(2)');
    expect(text.slice(0, firstBlockEnd)).not.toContain('編集である');
  });

  it('副作用を巻き戻す指示は一切足さない（制約(B)）', () => {
    const event: HumanMessage = {
      ...message('直した本文', '2026-08-20T10:05:00.000Z'),
      supersedes: 'evt-old',
    };
    const text = humanTurnText([event], new Map([[event.id, '元の本文']]));
    // 「取り消す」「巻き戻す」「キャンセル」の類を一切書かない
    expect(text).not.toMatch(/取り消|巻き戻|キャンセル/);
  });
});

/**
 * 編集ターン（`supersedes`）の配線 — `Clone#record` と `#runHumanTurn` /
 * `#resolvePriorTexts`（issue「チャットの送信済みメッセージを編集する」）。
 *
 * `humanTurnText` 単体のテスト（上の describe）は合図の文面だけを見ている。
 * ここは「受信箱の `human_message.supersedes` が日誌の `exchange.supersedes`
 * まで通るか」と「`#runHumanTurn` が実際に旧エントリを引いてターン入力へ
 * 渡すか・引けなくても落ちないか」を、クローンのループ全体を通して確かめる。
 */
describe('編集ターン（supersedes）—— #record と #runHumanTurn の配線', () => {
  function setupClone(reply?: (input: string) => string) {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(reply);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, stores, calls };
  }

  it('#record は human_message の supersedes を日誌の exchange へそのまま通す', async () => {
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文',
      conversationId: 'conv-record',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-record',
      at: new Date().toISOString(),
      text: '直した本文',
      conversationId: 'conv-record',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const written = entries.find(
      (entry) => entry.type === 'exchange' && entry.text === '直した本文',
    );
    expect(written).toBeDefined();
    expect(written).toMatchObject({ supersedes: original.id, conversationId: 'conv-record' });
  });

  it('supersedes が無ければ、日誌の exchange に supersedes は付かない（取れない軸に値を作らない）', async () => {
    const { clone, stores, calls } = setupClone();
    clone.post({
      type: 'human_message',
      id: 'evt-plain-record',
      at: new Date().toISOString(),
      text: 'ふつうの発言',
      conversationId: 'conv-plain-record',
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const entries = await stores.journal.list({ types: ['exchange'] });
    const written = entries.find(
      (entry) => entry.type === 'exchange' && entry.text === 'ふつうの発言',
    );
    expect(written).toBeDefined();
    expect(written).not.toHaveProperty('supersedes');
  });

  it('#runHumanTurn は旧エントリの本文を引いてターン入力へ渡す', async () => {
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文がここにある',
      conversationId: 'conv-turn',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-turn',
      at: new Date().toISOString(),
      text: '直した本文がここにある',
      conversationId: 'conv-turn',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const input = calls[0]?.inputs[0] ?? '';
    expect(input).toContain(`これは既出発言（id=${original.id}）の編集である`);
    expect(input).toContain('元の本文がここにある');
    expect(input).toContain('直した本文がここにある');
  });

  it('旧エントリが引けなくても落ちない（編集である事実だけは伝える）', async () => {
    const { clone, calls } = setupClone();

    clone.post({
      type: 'human_message',
      id: 'evt-edit-missing',
      at: new Date().toISOString(),
      text: '直した本文（旧本文は無い）',
      conversationId: 'conv-missing',
      supersedes: 'evt-does-not-exist',
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと（落ちずにターンが進む）');
    clone.stop();

    const input = calls[0]?.inputs[0] ?? '';
    expect(input).toContain('これは既出発言（id=evt-does-not-exist）の編集である');
    expect(input).toContain('編集前の本文は引けなかった');
    expect(input).toContain('直した本文（旧本文は無い）');
  });

  it('副作用（承認待ち等）は編集後も巻き戻されない（制約(B)）', async () => {
    // 編集前のターンで積まれた記録（例として日誌へ直接1件積む）が、編集後の
    // ターンを流しても1件も消えない・書き換わらないことを確かめる。
    const { clone, stores, calls } = setupClone();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の本文',
      conversationId: 'conv-side-effect',
    });
    await stores.commitments.open({
      id: 'commit-untouched',
      at: new Date().toISOString(),
      origin: 'human',
      body: '編集前のターンが開いた依頼',
    });

    clone.post({
      type: 'human_message',
      id: 'evt-edit-side-effect',
      at: new Date().toISOString(),
      text: '直した本文',
      conversationId: 'conv-side-effect',
      supersedes: original.id,
    });

    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    const commitment = await stores.commitments.get('commit-untouched');
    expect(commitment).not.toBeNull();
    expect(commitment?.closedAt).toBeUndefined();
    // 旧発言の journal エントリ自体も1件も書き換わらない・消えない
    const stillThere = await stores.journal.get(original.id);
    expect(stillThere?.type).toBe('exchange');
    expect(stillThere && stillThere.type === 'exchange' ? stillThere.text : undefined).toBe(
      '元の本文',
    );
  });
});

describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', () => {
  /**
   * `setup()`（`Setup`）は `CloneOptions.humanPriority` を渡す口を持たないので、
   * ここでは `createClone` を直接呼ぶ（`setupCapturing` などファイル内の既存の
   * 特設セットアップと同じ形）。`humanPriority` は環境変数を経由せず直渡しする
   * （`permissionMode` の直渡し実測は無いが、コンストラクタは
   * `humanPriority ?? resolveCloneHumanPriority(envSource)` で `false` を
   * nullish coalescing が通すので、直渡しした `false` がそのまま効く）。
   */
  function setupWithHumanPriority(
    humanPriority: boolean,
    reply: (input: string) => string = () => 'わかった',
    sdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ): Setup {
    const stores = createMemoryStores();
    const { fn, calls } = fakeSdk(reply, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      humanPriority,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return { clone, stores, calls, events, waitForEvents };
  }

  /** 先客のターンが実際に走り始めるまで待つ（積んだ時点で「処理待ち」だと言えるようにする）。 */
  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  /**
   * 渡した目印が全部、実際にモデルへ渡った入力のどこかに現れるまで待つ。
   *
   * **順序では待たない。** 「N番目に来た」を条件にすると、割り込みが起きない
   * 壊れ方（＝人間が最後に読まれる）でもタイムアウトせずに済んでしまい、歯が
   * 「揃って届いたこと」しか測らなくなる（測りたいのは順序そのもの）。ここでは
   * 「全部届いたか」だけを見て、届いた順序はテスト本体が `findIndex` で確かめる。
   */
  const waitForAllDelivered = (s: Setup, markers: readonly string[]): Promise<void> =>
    waitFor(
      () => markers.every((marker) => (s.calls[0]?.inputs ?? []).join('\n').includes(marker)),
      `${markers.join(' / ')} が全部届く`,
    );

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  const managerMessage = (id: string, managerId: string, text: string): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });

  const timerEvent = (id: string, kind: string): InboxEvent => ({
    type: 'timer',
    id,
    at: new Date().toISOString(),
    kind,
  });

  // --- 目印（マーカー）の作り方 -------------------------------------------
  //
  // **単純な部分文字列一致だと誤検出する。** タイマー・発意 tick のターンは
  // `#recentDigest` を積むので、**まだ実際には読まれていない、他の待ち行列上の
  // 合図の本文（`text`）まで、そのターンの中に「引き受けたまま終わっていない
  // 仕事」の一覧としてそのまま引用される**（`commitment_list` と同じ台帳を見る
  // ため）。実測: `manager_message` C を投げる前に `timer` B のターンが走ると、
  // B のターンの digest 節に C の `text` がそのまま載り、`text.includes(...)`
  // で C の目印を探すと**C 自身のターンより前に**当たってしまい、順序の検証が
  // 壊れる（本当は正しい実装なのに歯が誤って落ちる／誤って通る）。
  //
  // 対策は、**そのイベント自身が処理されているときにしか現れない複合文字列**を
  // 目印にすること。
  // - `manager_message`: 本物のターンは `managerPrompt` の
  //   `マネージャー ${managerId} から届いた。（報告）\n\n${text}` という並びで
  //   しか現れない。digest の引用は `- evt-x（... / manager / ...）\n  [report]
  //   ${text}` という別の並びなので、「から届いた」を含めれば衝突しない。
  // - `timer`: `定期ジョブ ${kind} の時刻になった` は、そのタイマー自身が
  //   処理されたときにしか現れない（**タイマーは台帳に開かないので、他の
  //   ターンの digest にタイマーが載ることはそもそも無い** — `commitFor` の
  //   doc）。
  // - `human_message`（単発）: 本物のターンの本文は `humanTurnText([event])`
  //   ＝ `text` そのもので、直前には `#notices` の `commitment` の区切り `\n\n---\n`
  //   が必ず付く（合図を1件でも受理していれば起こる）。digest の引用は
  //   `\n  ${text}`（2スペース区切り）であって `---\n` ではないので、
  //   `---\n${text}` を目印にすれば衝突しない。
  const managerMarker = (managerId: string, text: string): string =>
    `マネージャー ${managerId} から届いた。（報告）\n\n${text}`;
  const timerMarker = (kind: string): string => `定期ジョブ ${kind} の時刻になった`;
  const humanMarker = (text: string): string => `---\n${text}`;

  /**
   * 蒸留ターンの目印（`buildDistillPrompt` が書く固定の呼びかけ）。`reason` が
   * `conversation_end` でも `shutdown` でも同じ文面へ写る（`clone.ts` の
   * `#handle` の `'distill'` 分岐）ので、この目印だけでは reason を区別できない
   * ——以下の歯はどれも1テストにつき蒸留を1回しか起こさないので、それで足りる。
   */
  const DISTILL_MARKER = '記憶へ移すべきものがあるか確認せよ';

  it('人間の発言は、先に積まれていた人間以外を追い越して先に読まれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    // クローンがターンを回している最中（先客）に、待ち行列へ積む。
    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    // 全部実際に届いている（見つからない＝-1 を「先」と誤読しない）
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // 待ち行列に積まれていた3件の人間以外より、人間の発言が先に読まれる
    expect(idxHuman).toBeLessThan(idxMgrA);
    expect(idxHuman).toBeLessThan(idxMgrB);
    expect(idxHuman).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  it('人間を挟んでも、人間以外は1件も消えず、人間以外どうしの到着順も保たれる', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間以外A → 人間以外B → （人間を挟む）→ 人間以外C
    s.clone.post(managerMessage('evt-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-b', '非人間B'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('evt-c', 'mgr-c', '非人間C'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');
    const markerC = managerMarker('mgr-c', '非人間C');
    const markerHuman = humanMarker('割り込む人間');

    await waitForAllDelivered(s, [markerA, markerB, markerC, markerHuman]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxC = inputs.findIndex((text) => text.includes(markerC));
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));

    // (a) 人間以外は3件とも処理される（1件も消えない）
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    // (b) 人間以外どうしの到着順（A → B → C）は保たれる
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // (c) 人間の発言はそれらより先に読まれる
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxHuman).toBeLessThan(idxA);

    await s.clone.stop();
  }, 15_000);

  it('切ると純粋な先入れ先出しに戻る', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 歯1と同じ並びで post する（人間以外2件 + timer 1件 → 人間の発言）
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', 'マネージャーAの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-b', 'マネージャーBの報告'));
    s.clone.post(timerEvent('evt-timer-c', 'timer-c-kind'));
    s.clone.post(humanMessage('人間の発言だ'));

    const markerHuman = humanMarker('人間の発言だ');
    const markerMgrA = managerMarker('mgr-a', 'マネージャーAの報告');
    const markerMgrB = managerMarker('mgr-b', 'マネージャーBの報告');
    const markerTimer = timerMarker('timer-c-kind');

    await waitForAllDelivered(s, [markerHuman, markerMgrA, markerMgrB, markerTimer]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxMgrA = inputs.findIndex((text) => text.includes(markerMgrA));
    const idxMgrB = inputs.findIndex((text) => text.includes(markerMgrB));
    const idxTimer = inputs.findIndex((text) => text.includes(markerTimer));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxMgrA).toBeGreaterThan(-1);
    expect(idxMgrB).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // 切ってあるので到着順のまま。人間の発言は最後に読まれる（追い越さない）
    expect(idxMgrA).toBeLessThan(idxMgrB);
    expect(idxMgrB).toBeLessThan(idxTimer);
    expect(idxTimer).toBeLessThan(idxHuman);

    await s.clone.stop();
  }, 15_000);

  /**
   * **人間どうしは送信順のまま。追い越さない。** 割り込むのは「人間 対 それ以外」の
   * 1段だけで、人間の発言の中では送った順が保たれる（`Inbox#push` の
   * `insertAfterLast` が「最後に一致した要素の**直後**」へ入れるため）。
   *
   * **人間優先が壊しうるものの中で、これは壊してはいけない側である。**
   *
   * **人間が名指しで聞いた性質である**（2026-08-22 JST、逐語）:
   *
   * > 人間が4回割り込んだ際には、**ちゃんと送信順**（当たり前だが、早い方が優先
   * > される）**に割り込まれるようになっていますか？**
   *
   * **だから4件で、しかもクローン全体を通して測る**（`post` から流して、実際に
   * SDK へ渡った並びを見る）。`Inbox` を直接動かす測定では「並べ替えの機構は
   * 送信順を保つ」までしか言えず、**人間が聞いているのは自分の体験のほう**である。
   *
   * **この歯が無いと、実装を「常に先頭へ入れる」に変えても誰も気づかない。**
   * 実測（変異試験 N2、2026-08-22）: `insertAfterLast` の探索を捨てて常に先頭へ
   * 入れる変異を当てたとき、**順序の歯3本はどれも落ちなかった。** 人間が人間以外
   * より前に出ることは変わらないので素通りする。**落ちたのは無関係な既存テスト
   * 1本だけだった。** ＝ **設計としては保たれていたが、測る歯は1本も無かった。**
   */
  it('人間が続けて割り込んでも、人間どうしは送信順のまま（早い方が先）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間4件のあいだに人間以外を挟む（挟まっても人間どうしの順は変わらない）。
    s.clone.post(humanMessage('人間1'));
    s.clone.post(managerMessage('evt-mgr', 'mgr-x', 'マネージャーの報告'));
    s.clone.post(humanMessage('人間2'));
    s.clone.post(humanMessage('人間3'));
    s.clone.post(timerEvent('evt-timer', 'timer-kind'));
    s.clone.post(humanMessage('人間4'));

    const markerMgr = managerMarker('mgr-x', 'マネージャーの報告');
    const markerTimer = timerMarker('timer-kind');
    await waitForAllDelivered(s, ['人間1', '人間4', markerMgr, markerTimer]);
    await settle();

    // **4件は隣り合うので1ターンにまとめられる**（`#mergedHumanBatch`）。
    // まとまっても、まとまらなくても、**本文の並びで送信順を見る**。
    //
    // **目印は本文にしか現れない形にする。** 生の `人間1` で探すと、台帳の断り書き
    // に載る id 一覧に当たる。**あの一覧は実際の並び順と無関係に安定した順で出るので、
    // 順序を壊しても検出できない** — 実測（2026-08-22）: 変異 N2「常に先頭へ入れる」
    // を当てたとき、生の目印だとこの歯は**緑のまま通り**、本文だけを見る形に直したら
    // `expected 897 to be less than 858` で落ちた。まとめた本文は `humanTurnText` が
    // `` **(n) <at>**\n\n<text> `` の形で並べるので、`**\n\n` を前置きにする。
    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxOf = (text: string): number => joined.indexOf(`**\n\n${text}`);
    const i1 = idxOf('人間1');
    const i2 = idxOf('人間2');
    const i3 = idxOf('人間3');
    const i4 = idxOf('人間4');
    const idxMgr = joined.indexOf(markerMgr);
    const idxTimer = joined.indexOf(markerTimer);

    expect(i1, '人間1 が本文に見つからない').toBeGreaterThan(-1);
    expect(i2, '人間2 が本文に見つからない').toBeGreaterThan(-1);
    expect(i3, '人間3 が本文に見つからない').toBeGreaterThan(-1);
    expect(i4, '人間4 が本文に見つからない').toBeGreaterThan(-1);
    expect(idxMgr).toBeGreaterThan(-1);
    expect(idxTimer).toBeGreaterThan(-1);

    // **送信順（1 → 2 → 3 → 4）。ここが「常に先頭へ入れる」で反転する。**
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
    // そのうえで、4件とも人間以外より前に出ている。
    expect(i4).toBeLessThan(idxMgr);
    expect(i4).toBeLessThan(idxTimer);

    await s.clone.stop();
  }, 15_000);

  /**
   * **会話をまたいでも人間どうしは送信順で、まとめは会話の中だけ。** 上の
   * 「送信順のまま」は会話が1つの場合を測っている。ここは**会話が複数ある場合**を
   * 測る — Web UI は会話を別々に作れ（`/chat/<conversationId>`）、人間は複数の
   * 会話を並行して開く。
   *
   * **人間が名指しで聞いた形である**（2026-08-22 JST、逐語）:
   *
   * > 処理待機中→マネージャーAから発言→マネージャーBから発言→ユーザーが新規会話
   * > (会話ID:H)→ユーザーが新規会話(会話ID:I)→ユーザーが追加発言(会話ID:H)→
   * > マネージャーCから発言
   * >
   * > この処理順を教えてほしい
   *
   * **並びが2つの規則の交点で決まるので、片方だけ見ても答えが出ない。**
   *
   * 1. `Inbox#push` の `insertAfterLast(isHumanOriginated)` は**会話 id を見ない**
   *    ので、人間の中は純粋な送信順（H → I → H）。**会話 H の2件目は、先に届いた
   *    会話 I を追い越さない**
   * 2. `#mergedHumanBatch` は「**先頭から連続していて、かつ同じ `conversationId`**」
   *    しか束ねない（`drainWhile`）ので、あいだに会話 I が挟まった会話 H の2件は
   *    **まとまらず、別々のターンで読まれる**
   *
   * **1と2は逆を向いている。** 1は「会話をまたいで1列に並べる」、2は「会話の中
   * でしか束ねない」。**どちらかを変えると、もう一方が黙って変わる** — 会話 H の
   * 2件を束ねるには待ち行列全体から掻き集めるしかなく、その瞬間に会話 I が1ターン
   * 後ろへ下がって規則1（会話をまたぐ送信順）が崩れる。**人間はこの交換を提示された
   * うえで「会話をまたぐと送信順を守るでいい」と決めた**（同日、逐語）。だから
   * **ここで固定しているのは実装の都合ではなく、人間が選んだ側である。**
   *
   * **実装は1文字も変えずにこの歯を足している。** 挙動は #177 の時点で既にこう
   * なっていたが、**測る歯が1本も無かった** — 人間が聞くまで誰も測っていなかった、
   * という #177 と同じ形である（あちらは「人間どうしの送信順」）。
   *
   * **本数（7）まで assert するのは、まとめの有無が本数にしか現れないからである。**
   * 順序（`findIndex`）だけを見ると、会話 H の2件が1ターンに束ねられても
   * 「H1 が I1 より前」は真のまま通る。**規則2が壊れても順序の assert は緑になる。**
   */
  it('会話をまたいでも人間どうしは送信順で、あいだに別の会話が挟まればまとめない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    // 「処理待機中」＝ 先客のターンが走っている最中。ここへ6件が積み上がる。
    // **走行中のターンは止まらない**（人間優先が縮めるのは待ち行列で待つ時間だけ）。
    s.clone.post(humanMessage('先客', 'conv-0'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-A', 'Aの報告'));
    s.clone.post(managerMessage('evt-mgr-b', 'mgr-B', 'Bの報告'));
    s.clone.post(humanMessage('会話Hの1件目', 'conv-H'));
    s.clone.post(humanMessage('会話Iの1件目', 'conv-I'));
    s.clone.post(humanMessage('会話Hの2件目', 'conv-H'));
    s.clone.post(managerMessage('evt-mgr-c', 'mgr-C', 'Cの報告'));

    const markerA = managerMarker('mgr-A', 'Aの報告');
    const markerB = managerMarker('mgr-B', 'Bの報告');
    const markerC = managerMarker('mgr-C', 'Cの報告');
    // **最後に読まれるはずのものが届くまで待つ。** 順序では待たない
    // （`waitForAllDelivered` の doc）。
    await waitForAllDelivered(s, [markerC]);
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];

    // **本数で、まとめが1件も起きていないことを見る。** 先客 ＋ 人間3件 ＋
    // マネージャー3件 ＝ 7本。会話 H の2件が束ねられれば6本になる。
    expect(inputs).toHaveLength(7);

    // **目印は単発ターンの形（`---\n<本文>`）で探す。** 生の本文で探すと、他の
    // ターンの digest に引用された「まだ読まれていない合図」に当たる
    // （`humanMarker` の doc）。まとめられた場合はこの形にならないので、
    // 束ねられた瞬間にここが -1 になって落ちる（本数の assert と二重に効く）。
    const joined = inputs.join('\n');
    const idxH1 = joined.indexOf(humanMarker('会話Hの1件目'));
    const idxI1 = joined.indexOf(humanMarker('会話Iの1件目'));
    const idxH2 = joined.indexOf(humanMarker('会話Hの2件目'));
    const idxA = joined.indexOf(markerA);
    const idxB = joined.indexOf(markerB);
    const idxC = joined.indexOf(markerC);

    expect(idxH1, '会話Hの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxI1, '会話Iの1件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxH2, '会話Hの2件目 が単発ターンとして見つからない').toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);

    // **人間の中は送信順。会話 H の2件目は、先に届いた会話 I を追い越さない。**
    // ここが「同じ会話を待ち行列全体から掻き集める」実装で反転する。
    expect(idxH1).toBeLessThan(idxI1);
    expect(idxI1).toBeLessThan(idxH2);

    // **人間3件は、先に積まれていたマネージャー2件を全部飛び越す。**
    expect(idxH2).toBeLessThan(idxA);

    // **人間以外どうしは到着順のまま。後から届いた C も末尾のままで、餓死しない。**
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);

    // 会話 H の2件が別々のターンで読まれている（同じターンに同居していない）。
    // **本数の assert とは別の壊れ方を捕まえる** — 片方が落ちて片方が残る形
    // （例: 束ねずに1件を捨てる）だと本数は7のままになりうる。
    const turnOfH1 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの1件目')));
    const turnOfH2 = inputs.findIndex((text) => text.includes(humanMarker('会話Hの2件目')));
    expect(turnOfH1).not.toBe(turnOfH2);

    await s.clone.stop();
  }, 20_000);

  /**
   * Issue #43: 「会話を終える」を押した人間が、非人間のイベント全部の後ろで
   * 待たされていた窓を塞ぐ歯。
   *
   * `endConversation`（`POST /chat/:conversationId/end`。route の doc に
   * 「CLI が chat を抜けるときに叩く」と逐語がある）は `#postAndWait` で
   * `reason: 'conversation_end'` の蒸留を積み、HTTP ハンドラ（`apps/daemon/src/app.ts`）
   * がその完了を `await` してから応答を返す ＝ **人間が画面の前で待っている**。
   * それなのに `#postAndWait` はこれまで常に末尾へ積んでいたので、先に待ち行列に
   * 積まれていた非人間（`timer` / `manager_message` 等）を全部読み終えるまで
   * 人間が待たされていた。
   *
   * **`isHumanOriginated` は広げない。** 型を人間起点にすると
   * `stop()` が投げる `reason: 'shutdown'`（プロセス終了時。誰も待っていない）
   * まで人間起点になり、有界性の根拠（`isHumanOriginated` の doc「割り込みは
   * 人間の速さでしか来ない」）が壊れる。直しは呼び出し側 —— `endConversation`
   * だけが `#postAndWait` へ割り込みを頼む形にする。
   */
  it('endConversation の蒸留は、待ち行列にある非人間より先に読まれ、非人間は1件も消えず到着順も保たれる（Issue #43）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 非人間A → 非人間B が先に積まれた状態で、人間が「会話を終える」を押す。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [DISTILL_MARKER, markerA, markerB]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // 待っている人間（HTTP の await）の蒸留が、先に積まれていた非人間2件を追い越す。
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);

    // 非人間は1件も消えず、到着順（A → B）も保たれる。
    expect(idxA).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);

  it('endConversation の蒸留は、待ち行列にある人間の発言を追い越さない', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間の発言が先に積まれている状態で、同じ会話が終わる。
    s.clone.post(humanMessage('待っている人間'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerHuman = humanMarker('待っている人間');
    await waitForAllDelivered(s, [markerHuman, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 先に並んでいた人間の発言を、あとから来た蒸留（人間の待ちであっても）は追い越さない。
    expect(idxHuman).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);

  it('stop() の shutdown 蒸留は割り込む（非人間は1件も消えないまま、先に読まれる）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // プロセス終了時と同じ形 —— stop() を呼ぶ時点で、非人間が先に積まれている。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    const stopPromise = s.clone.stop();
    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await stopPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // **かつてここは逆を期待していた**（#43。逐語で残す）——
    //
    //   「プロセス終了で誰も待っていない shutdown 蒸留は、先に積まれていた非人間を
    //     追い越さない（末尾のまま）。endConversation とここが分かれることが本丸。」
    //
    // **Issue #564 (a) で反転した。** 根拠は2つある。
    //
    // 1. **この期待は設計判断の記録ではなかった。** PR #558 の本文自身が逐語で
    //    「旧実装がそもそも『常に末尾』だったので、これらの観点は赤を取れていない
    //    —— 直したことで守られ続けている、という確認に留まる」と書いている。
    //    ⟹ ここが固定していたのは「旧実装がそうだった」であって、「そうあるべき」ではない
    // 2. **「誰も待っていない」は待ち時間の根拠であって、完了性の根拠ではない。**
    //    `apps/daemon/src/index.ts` が
    //    `setTimeout(() => process.exit(0), FORCED_EXIT_MS)`（`FORCED_EXIT_MS` は
    //    `SHUTDOWN_GRACE_MS - 5_000` = 55_000）を張っているので、行列の後ろで待つ蒸留は
    //    「順番が遅い」のではなく**切られる**（#564 の観測 —— 会話が1区間まるごと失われた）
    //
    // **この歯が本当に守っているものは反転していない。** 上の
    // `waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER])` が
    // 「非人間が1件も消えない」を押さえており、そこは1文字も変えていない。**変えたのは
    // 順序の向きだけで、アサーションは1つも消していない。**
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  /**
   * Issue #564 (a): `stop()` の shutdown 蒸留も割り込ませる（A-1）。
   *
   * すぐ上の歯（#43 で入れたもの）は `waitForAllDelivered` で「非人間が1件も
   * 消えない」を押さえたうえで順序を見る。**#564 (a) でその順序の向きを反転した**
   * （経緯はそちらのコメントに逐語で残してある）。**ここから下の3本は、反転だけでは
   * 押さえきれない面を足すものである。**
   *
   * - 1本目は反転した上の歯と重なる（順序）。**重複させたまま残す** —— 上は
   *   `waitForAllDelivered` で待ってから順序を見るのに対し、こちらは待たずに
   *   `stop()` の戻りだけを見る。**測っている時点が違う。**
   * - 2本目は「`stop()` から戻った時点で全部が渡っている」と「器に未読が残らない」
   *   —— 割り込ませただけで読み切りを足さないと、ここが落ちる（`clone.ts` の
   *   `await this.#pumpLoop` のコメント）
   * - 3本目は「人間は追い越されない」の見張り
   *
   * 旧挙動の根拠は「誰も画面の前で待っていない」だったが、#564 が現物で示した
   * とおり、それは**待ち時間**の根拠であって**完了性**の根拠ではない。強制終了の
   * 期限（`apps/daemon/src/index.ts` の `setTimeout(() => process.exit(0),
   * FORCED_EXIT_MS)`）が在る以上、行列の後ろで待つ蒸留は「順番が遅い」ではなく
   * **切られる**。
   */
  it('stop() の shutdown 蒸留は、待ち行列にある非人間より先に読まれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // プロセス終了時と同じ形 —— stop() を呼ぶ時点で、非人間が先に積まれている。
    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // shutdown の蒸留が、先に積まれていた非人間2件を追い越す。
    expect(idxDistill).toBeLessThan(idxA);
    expect(idxDistill).toBeLessThan(idxB);
  }, 15_000);

  /**
   * **割り込ませただけでは持ち越しの穴が開く。**
   *
   * `#postAndWait(..., true)` を渡すだけにすると、蒸留は先に読まれるが、待ち行列に
   * 残っていた非人間は**1件もモデルへ届かなくなる**（捨てているのは
   * `#inbox.close()` ではなく `this.#query?.close()` のほう。`Inbox#close()` は
   * 待ち行列を捨てず、`next()` は `#queue.shift()` を先に見る）。だから A-1 は
   * `#pump()` の Promise を保持して、閉じる前に**読み切る**。
   *
   * ここは `waitForAllDelivered` を**使わない。** 使うと「いつかは届く」しか
   * 測れず、`stop()` が読み切ってから戻ることを測れない —— **`stop()` から戻った
   * 時点で**全部が SDK へ渡っていることが、この歯の主張である。
   */
  it('stop() の shutdown 蒸留が割り込んでも、非人間は1件も消えず到着順も保たれる（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    // 蒸留は割り込んでいる（この歯が測りたい状況であることの前提）。
    expect(idxDistill).toBeGreaterThan(-1);
    expect(idxDistill).toBeLessThan(idxA);

    // それでも非人間は1件も消えず、到着順（A → B）も保たれる。
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);

    // 器の側にも未読は残らない（読み切ってから畳んだ ＝ 後始末まで通した）。
    expect((await s.stores.inbox.pending()).count).toBe(0);
  }, 15_000);

  it('待ち行列に人間の発言が先に居るとき、stop() の shutdown 蒸留はそれを追い越さない（Issue #564）', async () => {
    const s = setupWithHumanPriority(true, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    // 人間の発言が先に積まれている状態でプロセスが畳まれる。
    s.clone.post(humanMessage('待っている人間'));

    const markerHuman = humanMarker('待っている人間');

    await s.clone.stop();

    const inputs = s.calls[0]?.inputs ?? [];
    const idxHuman = inputs.findIndex((text) => text.includes(markerHuman));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 割り込みの述語は `isHumanOriginated(queued) ||` を含むので、先に並んでいた
    // 人間の発言は shutdown の蒸留に追い越されない。
    expect(idxHuman).toBeLessThan(idxDistill);
  }, 15_000);

  it('humanPriority: false のときは endConversation の蒸留も割り込まない', async () => {
    const s = setupWithHumanPriority(false, () => 'わかった', { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);

    s.clone.post(managerMessage('evt-mgr-a', 'mgr-a', '非人間A'));
    s.clone.post(timerEvent('evt-timer-b', '非人間B'));
    const endPromise = s.clone.endConversation('conv-1');

    const markerA = managerMarker('mgr-a', '非人間A');
    const markerB = timerMarker('非人間B');

    await waitForAllDelivered(s, [markerA, markerB, DISTILL_MARKER]);
    await settle();
    await endPromise;

    const inputs = s.calls[0]?.inputs ?? [];
    const idxA = inputs.findIndex((text) => text.includes(markerA));
    const idxB = inputs.findIndex((text) => text.includes(markerB));
    const idxDistill = inputs.findIndex((text) => text.includes(DISTILL_MARKER));

    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxDistill).toBeGreaterThan(-1);

    // 切ってあるので純粋な FIFO のまま。蒸留は非人間2件より後ろで読まれる。
    expect(idxA).toBeLessThan(idxDistill);
    expect(idxB).toBeLessThan(idxDistill);

    await s.clone.stop();
  }, 15_000);
});

describe('humanTurnText（添付だけの発言）', () => {
  const event = (text: string, supersedes?: string) => ({
    type: 'human_message' as const,
    id: 'e1',
    at: '2026-10-06T00:00:00.000Z',
    text,
    conversationId: 'c',
    ...(supersedes === undefined ? {} : { supersedes }),
  });

  it('本文が空なら通知行だけが本文になる（空行を前置きしない）', () => {
    expect(humanTurnText([event('')], new Map(), new Map([['e1', '[添付] id=a']]))).toBe(
      '[添付] id=a',
    );
    expect(humanTurnText([event('こんにちは')], new Map(), new Map([['e1', '[添付] id=a']]))).toBe(
      'こんにちは\n\n[添付] id=a',
    );
  });

  it('本文が空の編集は、区切りの後ろに何も置かない', () => {
    const text = humanTurnText([event('', 'old')], new Map([['e1', '元']]), new Map());
    expect(text.endsWith('編集前の本文:\n\n元')).toBe(true);
    expect(text).not.toContain('---');
  });
});
