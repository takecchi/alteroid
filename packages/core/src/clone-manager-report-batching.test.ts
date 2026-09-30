import { describe, it, expect } from 'vitest';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, lineStartingWith, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

/**
 * Issue #562 PR-2: `#mergedHumanBatch` は人間の発言しか束ねない。マネージャーから
 * 連続して届いた報告（`kind === 'report'`）は1件ずつ別のターンで読まれ、7本
 * `manager_stop` が届けば7ターン消費する（`manager.ts` の実測、逐語は
 * `grep -Fn -- 'きっかり7ターン' packages/core/src/manager.ts`）。
 *
 * ここは、同じ `managerId` の連続する `report` を1ターンにまとめて読む
 * `#mergedManagerReportBatch` / `#runManagerReportBatch` の歯である。
 *
 * **`manager_message` はどの起点よりも `#emit` が効かない。** `#conversationOf`
 * が `manager_message` に対して常に `null` を返すので（`#handle` の
 * `manager_message` 分岐は内部ターン）、`done` / `error` / `usage_limited` の
 * どれも chat の購読者には届かない（`#emit` は `conversationId === null` を
 * 即 return する）。**だからここでは `waitForEvents`/`waitForTerminal`（chat
 * ストリームを見る）を使わず、`s.calls[0].inputs`（実際に SDK へ渡った入力）を
 * ポーリングして待つ** —— 既存の「歯2: 中身を持つ合図・別の日のタイマーは
 * 畳まれず」ブロックが manager_message を混ぜるときと同じ形である。
 */
describe('クローン — 同じマネージャーの連続する report をまとめて読む（#562）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  /** 既定は `kind: 'report'`。question/permission の境界を確かめる歯だけ渡す。 */
  const managerMessage = (
    id: string,
    managerId: string,
    text: string,
    kind: 'report' | 'question' | 'permission' = 'report',
    requestId?: string,
  ): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind,
    text,
    ...(requestId === undefined ? {} : { requestId }),
  });

  /** 直後の書き込み・後続ターンの発火が無いことを確かめるための、短い据え置き。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('同じマネージャーの連続する report 3件が1ターンにまとめて読まれ、全文が届く', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-batch', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-batch', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-batch', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告3本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // **モデル呼び出しは先客 + まとめた1本の計2回。** 3件を別々に読めば4回になる。
    expect(inputs).toHaveLength(2);

    const merged = inputs[1] ?? '';
    expect(merged).toContain('報告1本目');
    expect(merged).toContain('報告2本目');
    expect(merged).toContain('報告3本目');
    // 全文が届いた順に並ぶ（要約していない）。
    expect(merged.indexOf('報告1本目')).toBeLessThan(merged.indexOf('報告2本目'));
    expect(merged.indexOf('報告2本目')).toBeLessThan(merged.indexOf('報告3本目'));

    // **後始末も3件ぶん通る。** 1件でも取りこぼせば器に未読のまま残り続ける
    // （`#forget` の doc）。
    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '3件とも消し込まれる',
    );

    // **日誌への追記も3件ぶん行われる**（1回にまとめて握り潰していない）。
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const managerExchanges = exchanges.filter((entry) => entry.with === 'manager');
    expect(managerExchanges.filter((entry) => entry.text.includes('報告1本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告2本目'))).toHaveLength(1);
    expect(managerExchanges.filter((entry) => entry.text.includes('報告3本目'))).toHaveLength(1);

    await s.clone.stop();
  }, 15_000);

  /**
   * issue #955: 巨大な報告が束になると、束のターン入力そのものが文脈窓を
   * 溢れさせうる（`MERGED_BATCH_SIZE_LIMIT` は件数しか締めていなかった）。
   *
   * **歯が測るのは3つ**——(a) 束のターン入力が予算に収まる (b) 切ったことと
   * 全文の取り方（`journal_read`）を名乗る (c) その取り方が実際に全文を返す
   * （`#journalIncomingBody` が束の全件を個別に日誌へ書いているので、
   * `journal_read` 相当の条件で引き直せば見つかるはずである——「取り方が
   * 分かる体裁のまま実際には取れない」を作っていないことを検算する）。
   */
  it(
    '巨大な報告5件（各1.5万字。件ごとは予算未満だが合計は予算超過）の束は予算に収まり、' +
      '切った件数と journal_read での取り方を名乗る。省いた分の全文は journal_read で実際に引ける（issue #955）',
    async () => {
      const s = setup();

      s.clone.post(humanMessage('先客'));
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

      // **1件は予算（47,500）未満だが、5件の合計（約7.5万字）は予算を超える**
      // ように選んだ大きさ——「最新1件だけでも予算を超える」ケースは
      // `renderListingFromEnd` 自身の歯が別に持っているので、ここでは
      // 「複数件の合計が締まる」ほうを測る。
      const huge = (label: string): string => `${label}先頭` + 'x'.repeat(15_000) + `${label}末尾`;
      for (let i = 1; i <= 5; i += 1) {
        s.clone.post(managerMessage(`huge${i}`, 'mgr-huge', huge(`報告${i}`)));
      }

      const batchHeadline = 'マネージャー mgr-huge から届いた報告を、処理待ちのあいだに続けて';
      await waitFor(
        () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(batchHeadline)),
        'まとめたターンが投げられる',
      );
      await settle();

      const inputs = (s.calls[0] as FakeCall).inputs;
      // **束ねられたターンを内容で探す**（固定 index を使わない）。ほかの
      // 周期処理（`引き受けたまま終わっていない仕事は…` 等）が同じターンの
      // 中に前置されることがあるため（`composeTurnInputText` は commitment /
      // situation の断り書きを body の前に連結する）、見出し（`batchHeadline`）
      // はこの束の本文にしか出ない逐語なので、これで検索すれば取り違えない。
      const merged = inputs.find((input) => input.includes(batchHeadline)) ?? '';
      expect(merged).not.toBe('');

      // (a) 5件 × 1.5万字強（合計約7.5万字）を束ねているのに、束のターン入力
      // （前置される commitment/situation の断り書きを含む）は
      // 予算（MANAGER_REPORT_BATCH_BODY_BUDGET=47,500）＋構造の分にとどまる。
      expect(merged.length).toBeLessThan(60_000);

      // **末尾（最新）が優先して残る。** 「後の報告が前の報告を補足・訂正して
      // いる」ため、最新の報告5本目は全文が残っているはずである。
      expect(merged).toContain(huge('報告5'));
      // 最も古い報告1本目は本文ごと省かれている（全文は含まれない）。
      expect(merged).not.toContain(huge('報告1'));

      // (b) 切ったことと、全文の取り方（journal_read）を名乗る。
      const noticeLine = lineStartingWith(merged, '⚠ 本文の合計が文字数の予算');
      expect(noticeLine).toContain('journal_read');
      expect(noticeLine).toContain('types: ["exchange"]');
      expect(noticeLine).toMatch(
        /古い \d+ 件（5 件中、新しい \d+ 件だけを本文つきで出した）は本文を省いた/,
      );

      // `since` に埋め込まれた時刻を取り出す。
      const sinceMatch = /since: "([^"]+)"/.exec(noticeLine);
      expect(sinceMatch).not.toBeNull();
      const since = sinceMatch?.[1] ?? '';

      // (c) その取り方で、実際に省かれた報告1本目の全文が引けることを検算する。
      const exchanges = (await s.stores.journal.list({
        types: ['exchange'],
        with: ['manager'],
        since,
        limit: 200,
      })) as { text: string }[];
      expect(exchanges.some((entry) => entry.text.includes(huge('報告1')))).toBe(true);
      expect(exchanges.some((entry) => entry.text.includes(huge('報告5')))).toBe(true);

      await s.clone.stop();
    },
    20_000,
  );

  /**
   * issue #955: **単発の報告**（`managerPrompt`）も、新しいセッションの最初の
   * ターンに載れば束と同じ形で文脈窓を越えうる。束だけ締めて単発を素通しに
   * すると、同じ穴が1件ぶん残る。
   */
  it('巨大な単発の報告（6万字）は予算で切り、全文の取り方を名乗る。その取り方で全文が引ける（issue #955）', async () => {
    const s = setup();
    const huge = '単発先頭' + 'y'.repeat(60_000) + '単発末尾';
    s.clone.post(managerMessage('huge-single', 'mgr-single', huge));
    await waitFor(
      () =>
        (s.calls[0]?.inputs ?? []).some((input) =>
          input.includes('マネージャー mgr-single から届いた。（報告）'),
        ),
      '単発の報告のターンが投げられる',
    );
    await settle();
    const input =
      (s.calls[0] as FakeCall).inputs.find((text) =>
        text.includes('マネージャー mgr-single から届いた。（報告）'),
      ) ?? '';

    expect(input.length).toBeLessThan(60_000);
    expect(input).toContain('単発先頭');
    expect(input).not.toContain('単発末尾');
    const notice = lineStartingWith(input, '⚠ 本文が文字数の予算');
    expect(notice).toContain('journal_read');
    const since = /since: "([^"]+)"/.exec(notice)?.[1] ?? '';
    expect(since).not.toBe('');
    const exchanges = (await s.stores.journal.list({
      types: ['exchange'],
      with: ['manager'],
      since,
      limit: 200,
    })) as { text: string }[];
    expect(exchanges.some((entry) => entry.text.includes(huge))).toBe(true);

    await s.clone.stop();
  }, 20_000);

  it('予算に収まる単発の報告は1文字も変えず、予算の断りも出さない（issue #955）', async () => {
    const s = setup();
    s.clone.post(managerMessage('small-single', 'mgr-small', '小さな報告の本文'));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('小さな報告の本文')),
      '単発の報告のターンが投げられる',
    );
    const input =
      (s.calls[0] as FakeCall).inputs.find((text) => text.includes('小さな報告の本文')) ?? '';
    expect(input).not.toContain('文字数の予算');
    await s.clone.stop();
  });

  it('束の最新1件だけで予算を超える回も、全文の取り方を名乗る（issue #955）', async () => {
    const s = setup();
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    s.clone.post(managerMessage('small-1', 'mgr-mix', '小さい報告'));
    s.clone.post(
      managerMessage('huge-last', 'mgr-mix', '最新先頭' + 'z'.repeat(60_000) + '最新末尾'),
    );
    const batchHeadline = 'マネージャー mgr-mix から届いた報告を、処理待ちのあいだに続けて';
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes(batchHeadline)),
      'まとめたターンが投げられる',
    );
    await settle();
    const merged =
      (s.calls[0] as FakeCall).inputs.find((input) => input.includes(batchHeadline)) ?? '';
    expect(merged.length).toBeLessThan(60_000);
    expect(merged).toContain('最新先頭');
    expect(merged).not.toContain('最新末尾');
    // 最新の1件で予算が埋まるので、古い側は落ちて省略の1行が出る。
    const notice = lineStartingWith(merged, '⚠ 本文の合計が文字数の予算');
    expect(notice).toContain('journal_read');
    expect(merged).not.toContain('小さい報告');
    await s.clone.stop();
  }, 20_000);

  // **束ねられる報告は、定義上いちばん長く待った報告である。** 単発の経路
  // （`managerPrompt`）にだけ「受け取ってからの経過」が載って、こちらに載らないと、
  // **待った証拠がいちばん要る場所でだけ消える**（#562 PR-1 が入れたもの）。
  it('まとめた本文にも、1件ごとに受け取ってからの経過が載る', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('age1', 'mgr-age', '報告1本目'));
    s.clone.post(managerMessage('age2', 'mgr-age', '報告2本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('報告2本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    // 2件ぶん、それぞれに経過の行が付く（1つに畳んでいない）。
    expect(merged.split('受け取ってから').length - 1).toBe(2);
    // 丸めた値だけでなく、受け取った時刻そのものも併記される
    // （他のタイムスタンプと突き合わせられるように。`describeReportAge` の doc）。
    expect(merged).toContain('受け取った時刻:');

    await s.clone.stop();
  }, 15_000);

  it('間に別のマネージャーの報告が挟まったら、そこで止まる（飛び越えない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(managerMessage('b1', 'mgr-B', 'B1本目'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [A1+A2まとめ] + B1 + A3 = 4本。A1〜A3を1本に飛び越して束ねれば3本になる。
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('B1本目');
    expect(inputs[1] ?? '').not.toContain('A3本目');

    expect(inputs[2] ?? '').toContain('B1本目');
    expect(inputs[2] ?? '').not.toContain('A1本目');
    expect(inputs[2] ?? '').not.toContain('A3本目');

    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('B1本目');

    await s.clone.stop();
  }, 15_000);

  it('連続する report の途中に人間の発言が挟まったら、そこで止まる（人間優先を切って純粋な到着順で確かめる）', async () => {
    // 人間優先を切る理由: 既定だと `insertAfterLast` が人間の発言を待ち行列の
    // 先頭側へ入れ直すので、「呼んだ順」と「並んだ順」がずれる（`Inbox#push` の
    // doc）。ここで確かめたいのは「並んだ順で見て、間に別の起点が挟まったら
    // `drainWhile` が止まる」ことなので、並びを呼んだ順のまま固定する。
    //
    // **A1・A2 は連続していて同じマネージャーなのでまとめ読みの対象になる —
    // それでも間の人間の発言より後ろの A3 まで飛び越して拾ってはいけない。**
    // A1 単独 + human 単独 + A2 単独（3件とも別々のまま）だと、まとめ読みが
    // 無い旧実装でも同じ本数になってしまい、赤にならない。A1+A2 を隣り合わせに
    // 置くことで、「まとめる」と「人間の手前で止める」の両方を同時に測る。
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_CLONE_HUMAN_PRIORITY: '0' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('a1', 'mgr-A', 'A1本目'));
    s.clone.post(managerMessage('a2', 'mgr-A', 'A2本目'));
    s.clone.post(humanMessage('割り込む人間'));
    s.clone.post(managerMessage('a3', 'mgr-A', 'A3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[3]?.includes('A3本目') ?? false,
      '4本目（A3単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [A1+A2まとめ] + 人間 + A3 = 4本。
    // まとめ読みが無ければ 先客+A1+A2+人間+A3 の5本になる（＝この本数で赤が見える）。
    expect(inputs).toHaveLength(4);

    expect(inputs[1] ?? '').toContain('A1本目');
    expect(inputs[1] ?? '').toContain('A2本目');
    expect(inputs[1] ?? '').not.toContain('割り込む人間');
    expect(inputs[1] ?? '').not.toContain('A3本目');
    expect(inputs[2] ?? '').toContain('割り込む人間');
    expect(inputs[3] ?? '').toContain('A3本目');
    expect(inputs[3] ?? '').not.toContain('A1本目');
    expect(inputs[3] ?? '').not.toContain('A2本目');

    await s.clone.stop();
  }, 15_000);

  it('question / permission はまとめられない（同じマネージャーの report のすぐ後ろでも止まる）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Q', '報告1本目'));
    s.clone.post(managerMessage('r2', 'mgr-Q', '報告2本目'));
    s.clone.post(managerMessage('q1', 'mgr-Q', '質問1本目', 'question', 'req-1'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('質問1本目') ?? false,
      '3本目（question単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [report×2まとめ] + question = 3本。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').toContain('報告2本目');
    expect(inputs[1] ?? '').not.toContain('質問1本目');
    expect(inputs[2] ?? '').toContain('質問1本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');
    expect(inputs[2] ?? '').not.toContain('報告2本目');
    // question は答え方の経路も示される（既存の `managerPrompt` 分岐がそのまま
    // 通っていることの確認 —— まとめ読みの追加で壊れていないか）。
    expect(inputs[2]).toContain('manager_send');

    await s.clone.stop();
  }, 15_000);

  /**
   * **⚠️ issue #783 で期待値を反転した（名前・タイトルは歴史として残す）。**
   * 以前は `#mergeable` が配り直し（`#redelivered`）を無条件で外していたので、
   * この2件は必ず別々のターンで読まれた（かつての期待値）:
   *   expect(inputs).toHaveLength(2);
   *   expect(inputs[0] ?? '').toContain('前回届いた報告1');
   *   expect(inputs[0] ?? '').toContain('これは配り直しである');
   *   expect(inputs[0] ?? '').not.toContain('前回届いた報告2');
   *   expect(inputs[1] ?? '').toContain('前回届いた報告2');
   *   expect(inputs[1] ?? '').toContain('これは配り直しである');
   *   expect(inputs[1] ?? '').not.toContain('前回届いた報告1');
   * **いまは配り直しも束ねる対象になる**（同じ `managerId` の連続する
   * `report`。`#mergeable` の doc）——issue #783 の実物そのもの（同じマネー
   * ジャーから369件の配り直しが369ターンを消費した）を、2件の縮小版で確かめる。
   */
  it('#redelivered に載っている報告はまとめられる（issue #783: 配り直しの束）', async () => {
    const stores = createMemoryStores();
    const r1 = managerMessage('r1', 'mgr-X', '前回届いた報告1');
    const r2 = managerMessage('r2', 'mgr-X', '前回届いた報告2');
    // 前のプロセスが死んで未読のまま残っていた状況を直接作る（`#restoreUnread` が拾う）。
    await stores.inbox.put(r1, new Date(0).toISOString());
    await stores.inbox.put(r2, new Date(1).toISOString());

    const s = setup(undefined, stores);

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('前回届いた報告2'),
      '報告2が渡る',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 1本の束にまとまる（先客が居ないので合流ターンがそのまま1本目）。
    expect(inputs).toHaveLength(1);
    const merged = inputs[0] ?? '';
    // **束の行を1行として取り出し、全文一致で測る**（`lineStartingWith` の doc）。
    const noticeLine = lineStartingWith(merged, '[system] **これは配り直しの束である');
    expect(noticeLine).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    // 全文は1文字も捨てない —— 2件とも本文に現れる。
    expect(merged).toContain('前回届いた報告1');
    expect(merged).toContain('前回届いた報告2');

    await s.clone.stop();
  }, 15_000);

  /**
   * **束の上限（issue #783）は表示の単位を切るだけで、取りこぼしを作らない。**
   * `ALTEROID_MERGED_BATCH_SIZE_LIMIT` を小さく設定し、5件を一度に届けて、
   * 上限（2件）で束が複数に割れることと、割れた分が次の反復でそのまま処理
   * されることを確かめる（`#drainMergeableWithinLimit` の doc）。
   */
  it('束の上限に当たっても、外れた分は次の反復でそのまま処理される（1件も失われない。issue #783）', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      {},
      {
        ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2',
      },
    );

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    for (let i = 1; i <= 5; i += 1) {
      s.clone.post(managerMessage(`lim${i}`, 'mgr-limit', `上限テスト報告${i}`));
    }

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('上限テスト報告5'),
      '5件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [1+2] + [3+4] + [5] = 4本。上限を入れなければ先客+[1..5まとめ]の2本になる。
    expect(inputs).toHaveLength(4);
    expect(inputs[1] ?? '').toContain('上限テスト報告1');
    expect(inputs[1] ?? '').toContain('上限テスト報告2');
    expect(inputs[1] ?? '').not.toContain('上限テスト報告3');
    expect(inputs[2] ?? '').toContain('上限テスト報告3');
    expect(inputs[2] ?? '').toContain('上限テスト報告4');
    expect(inputs[2] ?? '').not.toContain('上限テスト報告5');
    expect(inputs[3] ?? '').toContain('上限テスト報告5');

    // **取りこぼしを撃つ歯。** 1〜5件全部の本文がどこかのターンに現れる。
    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain(`上限テスト報告${i}`);
    }

    // 消し込み・台帳も件数ぶん通る（1件も器に残らない）。
    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );
    const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
      with: string;
      text: string;
    }[];
    const managerExchanges = exchanges.filter((entry) => entry.with === 'manager');
    for (let i = 1; i <= 5; i += 1) {
      expect(
        managerExchanges.filter((entry) => entry.text.includes(`上限テスト報告${i}`)),
      ).toHaveLength(1);
    }

    await s.clone.stop();
  }, 15_000);

  /**
   * **配り直しが上限を超えても、外れた分は同じ理由で次の反復に残る。** 束の行
   * （`#redeliveryNoticeFor`）が言う件数・最大配達回数・最古時刻は束ごとに
   * 別々の値になる——1つの束の言い分が、外れた分の存在を隠さない。
   */
  it('配り直しが上限を超えても束が複数に割れ、1件も失われない（issue #783）', async () => {
    const stores = createMemoryStores();
    for (let i = 1; i <= 5; i += 1) {
      await stores.inbox.put(
        managerMessage(`red${i}`, 'mgr-redlimit', `配り直しテスト${i}`),
        new Date(i - 1).toISOString(),
      );
    }

    const s = setup(undefined, stores, {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).join('\n').includes('配り直しテスト5'),
      '5件目が渡る',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 上限2件で [1+2] / [3+4] / [5単独] の3本に割れる（実測）。
    expect(inputs).toHaveLength(3);
    // **束ごとに、件数・最大配達回数・最古時刻が別々の値になることを1行で測る**
    // （`lineStartingWith` の doc）。外れた分（3〜5件目）が次の反復で処理される
    // だけでなく、**その束自身の言い分も正しい**ことを確かめる。
    expect(lineStartingWith(inputs[0] ?? '', '[system] **これは配り直しの束である')).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(inputs[0] ?? '').toContain('配り直しテスト1');
    expect(inputs[0] ?? '').toContain('配り直しテスト2');
    expect(lineStartingWith(inputs[1] ?? '', '[system] **これは配り直しの束である')).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 1970-01-01T00:00:00.002Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    expect(inputs[1] ?? '').toContain('配り直しテスト3');
    expect(inputs[1] ?? '').toContain('配り直しテスト4');
    // 5件目は束から外れて単独になる——単独用の1件専用の文言（`batch.length === 1`）。
    expect(inputs[2] ?? '').toContain('これは配り直しである');
    expect(inputs[2] ?? '').toContain('配り直しテスト5');

    // **取りこぼしを撃つ歯。** 1〜5件全部の本文がどこかのターンに現れる。
    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain(`配り直しテスト${i}`);
    }

    // 消し込みも件数ぶん通る（1件も器に残らない）。
    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);

  it('枠で保持した report はまとめ読みの対象から外れる（#heldForUsage）', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    s.clone.post(managerMessage('r1', 'mgr-Y', '報告1本目')); // turn0: 失敗 → 保持
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '一件目のターンが投げられる');
    await waitFor(async () => {
      const pending = await s.stores.inbox.claimPending();
      return pending.some((p) => p.event.id === 'r1');
    }, '一件目が未読として保持される');

    s.clone.post(managerMessage('r2', 'mgr-Y', '報告2本目'));
    s.clone.post(managerMessage('r3', 'mgr-Y', '報告3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('報告3本目') ?? false,
      '2件目・3件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // turn0(失敗) + turn1(r1単独の再試行) + turn2(r2+r3まとめ) = 3本。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('報告1本目');
    expect(inputs[1] ?? '').not.toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告2本目');
    expect(inputs[2] ?? '').toContain('報告3本目');
    expect(inputs[2] ?? '').not.toContain('報告1本目');

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは従来どおりの本文のまま（断り書きが載らない）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-Z', '単独の報告'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('単独の報告') ?? false,
      '2本目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    const solo = inputs[1] ?? '';
    // **`managerPrompt` が出す1件の形をそのまま通していることを見る。**
    // ⚠️ 逐語の完全一致では固定しない ── 本文には #562 PR-1 が入れた「受け取って
    // からの経過」が挟まり、その値は時刻に依存する。ここで見たいのは**まとめ読みの
    // 前置きを足していないこと**なので、単発の経路が持つべき要素の有無で固定する。
    expect(solo).toContain('[system] マネージャー mgr-Z から届いた。（報告）');
    expect(solo).toContain('単独の報告');
    // 単発の経路にも経過は載る（PR-1。まとめた側だけの性質にしない）。
    expect(solo).toContain('受け取ってから');
    expect(solo).toContain(
      '続きが要るなら `manager_send` で指示を出し、要らないなら何もしなくてよい。',
    );
    expect(solo).toContain('学びや判断の基準になったことがあれば記憶へ移すこと。');
    // まとめ読みの前置き（「続けて」「まとめて読んでから」等）が1文字も載らない。
    expect(solo).not.toContain('続けて');
    expect(solo).not.toContain('まとめて読んでから');
    expect(solo).not.toContain('**(1)**');

    await s.clone.stop();
  }, 15_000);

  /**
   * **上限で切ったという事実が、いまはクローンから見える（issue #783 の続き）。**
   * PR #836 が足した上限（`MERGED_BATCH_SIZE_LIMIT` / `#drainMergeableWithinLimit`）は、
   * 切っても跡を1文字も残さなかった —— この節はその欠陥の直しを撃つ。
   *
   * **境界の両側と、残り件数の1・2の両方を1本ずつに分けて撃つ**（オフバイワンを
   * 殺すため）。**断り書きの行は改行で割って1本に特定し、`toBe` で全文一致させる**
   * （AGENTS.md「語ではなくデータで測る」— PR #822 / #826 の教訓）。
   */
  it('上限ちょうど（切らない）: 断り書きが1文字も載らない', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // ちょうど上限（2件）だけ届け、他には何も残さない——上限に当たっても
    // 「同じ束に入るはずの分」が待ち行列に無いので、切ったことにはならない。
    s.clone.post(managerMessage('exact1', 'mgr-exact', 'ちょうど上限1本目'));
    s.clone.post(managerMessage('exact2', 'mgr-exact', 'ちょうど上限2本目'));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('ちょうど上限2本目') ?? false,
      'まとめたターンが投げられる',
    );
    await settle();

    const merged = (s.calls[0] as FakeCall).inputs[1] ?? '';
    expect(merged).toContain('ちょうど上限1本目');
    expect(merged).toContain('ちょうど上限2本目');
    // **いちばん多い経路（切っていない）の出力を1文字も変えない。**
    expect(merged).not.toContain('このターンへ束ねる合図は、上限');
    expect(merged).not.toContain('1件も失われていない');

    await s.clone.stop();
  }, 15_000);

  it('上限+1（切る・残り1件）: 断り書きが1行、値は限度2・束2・残り1', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-plus1', '上限+1テスト1本目'));
    s.clone.post(managerMessage('r2', 'mgr-plus1', '上限+1テスト2本目'));
    s.clone.post(managerMessage('r3', 'mgr-plus1', '上限+1テスト3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('上限+1テスト3本目') ?? false,
      '3本目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [1+2まとめ・切った束] + [3単独] = 3本。
    expect(inputs).toHaveLength(3);

    const truncated = inputs[1] ?? '';
    expect(truncated).toContain('上限+1テスト1本目');
    expect(truncated).toContain('上限+1テスト2本目');
    expect(truncated).not.toContain('上限+1テスト3本目');
    // **いつ数えた値かを名乗る（#960）**: `remainingHead` は呼び出した瞬間の値なので
    // `HH:MM:SSZ` の時刻ラベルが必ず載る（`readAtLabel` と同じ形）。
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );
    expect(truncated).toContain(
      '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
    );

    // 3件目（単独）には切った断り書きが載らない——待ち行列に何も残っていない。
    const solo = inputs[2] ?? '';
    expect(solo).toContain('上限+1テスト3本目');
    expect(solo).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('上限+2（切る・残り2件）: 続く束はちょうど上限で切っていない', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(managerMessage('r1', 'mgr-plus2', '上限+2テスト1本目'));
    s.clone.post(managerMessage('r2', 'mgr-plus2', '上限+2テスト2本目'));
    s.clone.post(managerMessage('r3', 'mgr-plus2', '上限+2テスト3本目'));
    s.clone.post(managerMessage('r4', 'mgr-plus2', '上限+2テスト4本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('上限+2テスト4本目') ?? false,
      '2本目の束（3+4）ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [1+2まとめ・切った束、残り2] + [3+4まとめ・ちょうど上限、切っていない] = 3本。
    expect(inputs).toHaveLength(3);

    const firstBatch = inputs[1] ?? '';
    expect(firstBatch).toContain('上限+2テスト1本目');
    expect(firstBatch).toContain('上限+2テスト2本目');
    expect(lineStartingWith(firstBatch, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 2 件連続して残っている。$/,
    );

    // 2本目の束は、それ自身がちょうど上限（2件）だが、後ろに何も残っていない
    // ので切ったことにはならない——断り書きが載らない。
    const secondBatch = inputs[2] ?? '';
    expect(secondBatch).toContain('上限+2テスト3本目');
    expect(secondBatch).toContain('上限+2テスト4本目');
    expect(secondBatch).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('人間の発言でも同じ断り書きが載る（`#mergedHumanBatch` 経由でも共有の実装を通る）', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(humanMessage('人間1本目'));
    s.clone.post(humanMessage('人間2本目'));
    s.clone.post(humanMessage('人間3本目'));

    await waitFor(
      () => s.calls[0]?.inputs[2]?.includes('人間3本目') ?? false,
      '3本目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    const truncated = inputs[1] ?? '';
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );

    await s.clone.stop();
  }, 15_000);
});

/**
 * Issue #841: `external`（ほぼ全部 `token-pool`）が受信箱の76.6%を占め、
 * `#mergedHumanBatch` / `#mergedManagerReportBatch` のどちらの述語にも当たらず
 * 1件1ターンを消費していた（issue #783 の親issue）。ここは `#mergedExternalBatch`
 * / `#runExternalBatch` の歯である。
 *
 * **`#mergedManagerReportBatch` と違い、束ねてよいのは中身（`source` と
 * `payload`）が完全に一致するものだけ**——`source` だけの一致では足りない
 * （issue #841 が名指しした危険:「重要な1件が同じ出所の重複の中に埋もれる」）。
 * **「束ねない」側の歯がこの PR の本体である。判定は必ずターン数（`s.calls[0]`
 * の `inputs` の本数）で測る**——本文の文字列一致だけで測ると、束ねてしまって
 * いるのに文言が違うだけで緑になりうる形が残る。
 */
describe('クローン — 中身の同じ external をまとめて読む（#841）', () => {
  const externalEvent = (id: string, source: string, payload: unknown, at: string): InboxEvent => ({
    type: 'external',
    id,
    at,
    source,
    payload,
  });

  const managerMessage = (id: string, managerId: string, text: string): InboxEvent => ({
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text,
  });

  /** 直後の書き込み・後続ターンの発火が無いことを確かめるための、短い据え置き。 */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('中身（source・payload）が完全に同じ external が3件連続で届くと、1ターンへ束ねられ、本文に件数と全件の届いた時刻が載る', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(
      externalEvent('e2', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:01.000Z'),
    );
    s.clone.post(
      externalEvent('e3', 'token-pool', { text: '枠が開いた' }, '2026-09-01T00:00:02.000Z'),
    );

    await waitFor(
      () =>
        (s.calls[0]?.inputs ?? []).some((input) =>
          input.includes('同じ中身の合図を続けて **3 件** まとめて渡す'),
        ),
      'まとめたターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // **束ねられたことをターン数で測る。** 先客 + まとめた1本 = 2回。
    // 3件を別々に読めば4回になる。
    expect(inputs).toHaveLength(2);

    const merged = inputs[1] ?? '';
    // **束の本文そのものが件数を言っていることを、行ごと逐語で固定する。**
    // `toContain('3 件')` だけでは足りない —— 台帳の断り書き（`#commitmentNoticeFor`
    // の「いま届いたこの 3 件も台帳に載せた（id: ...）」）が同じ部分文字列を
    // 満たすので、`externalBatchPrompt` から件数を丸ごと落としても緑のままになる。
    // **変異試験で実測した**（変異 `m3-drop-batch-count`: 件数の行を落としても
    // 赤くなった歯が0本だった）。Issue #841 の受け入れ基準「束ねるときは
    // 『N 件を畳んだ』を必ず本文に出すこと」は、この行でだけ固定されている。
    expect(lineStartingWith(merged, '処理待ちのあいだに、同じ中身の合図を続けて')).toBe(
      '処理待ちのあいだに、同じ中身の合図を続けて **3 件** まとめて渡す' +
        '（本文は1回だけ。全件で `source` と中身が一致している）。',
    );
    expect(merged).toContain('2026-09-01T00:00:00.000Z');
    expect(merged).toContain('2026-09-01T00:00:01.000Z');
    expect(merged).toContain('2026-09-01T00:00:02.000Z');
    // 本文（renderPayload）は1回だけ載る——2回目以降を出しても情報は増えない。
    expect(merged.split('枠が開いた').length - 1).toBe(1);

    // 後始末（#settleInboxEvent）は3件ぶん通る——器に未読が残らない。
    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '3件とも消し込まれる',
    );

    // 日誌への追記も3件ぶん行われる（1回にまとめて握り潰していない）。
    const externals = (await s.stores.journal.list({ types: ['external_event'] })) as {
      source: string;
    }[];
    expect(externals.filter((entry) => entry.source === 'token-pool')).toHaveLength(3);

    await s.clone.stop();
  }, 15_000);

  it('🔴 source が違えば payload が同じでも束ねない（2ターンのまま）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(
      externalEvent('e2', 'runner-registry', { text: '同じ中身' }, '2026-09-01T00:00:01.000Z'),
    );

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('runner-registry')),
      '2件目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // **束ねなかったことをターン数で測る。** 先客 + e1単独 + e2単独 = 3回。
    // 束ねれば先客 + まとめた1本 = 2回になってしまう。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('source: token-pool');
    expect(inputs[1] ?? '').not.toContain('runner-registry');
    expect(inputs[2] ?? '').toContain('source: runner-registry');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('🔴 source が同じでも payload が違えば束ねない（2ターンのまま）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(externalEvent('e1', 'token-pool', { text: '中身A' }, '2026-09-01T00:00:00.000Z'));
    s.clone.post(externalEvent('e2', 'token-pool', { text: '中身B' }, '2026-09-01T00:00:01.000Z'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('中身B')),
      '2件目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('中身A');
    expect(inputs[1] ?? '').not.toContain('中身B');
    expect(inputs[2] ?? '').toContain('中身B');
    expect(inputs[2] ?? '').not.toContain('中身A');

    await s.clone.stop();
  }, 15_000);

  it('🔴 external と human_message が混在すると束ねない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(humanMessage('割り込む人間'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('割り込む人間')),
      '人間の発言のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + external単独 + human単独 = 3回。束ねれば2回になる。
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('token-pool');
    expect(inputs[1] ?? '').not.toContain('割り込む人間');
    expect(inputs[2] ?? '').toContain('割り込む人間');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('🔴 external と manager_message（report）が混在すると束ねない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      externalEvent('e1', 'token-pool', { text: '同じ中身' }, '2026-09-01T00:00:00.000Z'),
    );
    s.clone.post(managerMessage('r1', 'mgr-mix', '報告本文'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('報告本文')),
      'マネージャーの報告のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(3);
    expect(inputs[1] ?? '').toContain('token-pool');
    expect(inputs[1] ?? '').not.toContain('報告本文');
    expect(inputs[2] ?? '').toContain('報告本文');
    expect(inputs[2] ?? '').not.toContain('token-pool');

    await s.clone.stop();
  }, 15_000);

  it('束の上限に当たっても、外れた分は次の反復でそのまま処理される（1件も失われない。issue #783 と同じ機構）', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // **`source` は `'ci'`（束ねの挙動だけを測るための任意値）。** かつては
    // `'token-pool'` を使っていたが、#852 で `commitmentFor` がその文字列を
    // 台帳を開かない合図として特別扱いするようになったため、この歯が待っている
    // 「台帳に載せた」の断り書き（下）が出なくなっていた——束ねそのものは
    // `source` の値に依らないので、予約語と衝突しない値へ変えてある。
    for (let i = 1; i <= 5; i += 1) {
      s.clone.post(
        externalEvent(`lim${i}`, 'ci', { text: '同じ中身' }, `2026-09-01T00:00:0${i}.000Z`),
      );
    }

    // **5件目は束から外れて単独になる**（上限2件で [1+2] / [3+4] / [5単独] に
    // 割れる）。単発の経路（`buildExternalEventPrompt`）は `at` を本文に出さない
    // （非回帰——単発の見た目を変えない）ので、5件目が届いたことは台帳の断り書き
    // （台帳へ載せた id の一覧）で待つ。
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('id: `lim5`')),
      '5件目ぶんの入力が投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [1+2] + [3+4] + [5単独] = 4本。上限を入れなければ先客+[1..5まとめ]の2本になる。
    expect(inputs).toHaveLength(4);
    expect(inputs[1] ?? '').toContain('2 件');
    expect(inputs[2] ?? '').toContain('2 件');
    expect(inputs[3] ?? '').not.toContain('まとめて渡す');

    // **取りこぼしを撃つ歯。** 1〜5件全部が、どこかのターンの台帳の断り書き
    // （「いま届いたこの◯件も台帳に載せた（id: ...）」）に必ず現れる——
    // payload の中身は5件とも同一なので、本文の文字列だけでは数えられない。
    // id は `#journalIncomingBody` / 台帳判定を通じて件ごとに必ず記録される
    // ものなので、取りこぼしがあればここが最初に崩れる。
    const joined = inputs.join('\n');
    for (let i = 1; i <= 5; i += 1) {
      expect(joined).toContain('`lim' + String(i) + '`');
    }

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '5件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);

  /**
   * issue #849（issue #783 の続き）: 上限で束を切ったという事実は
   * `#drainMergeableWithinLimit` が `#notices` の `mergedBatchTruncation`
   * （`clone-notices.ts` の `CloneNotices`）へ集約して残し、`#runTurn` の入力
   * 組み立てが誰の呼び出しにも自動で乗せる。
   * `#mergedExternalBatch` もこの共有関数を経由する（`#mergedManagerReportBatch`
   * / `#mergedHumanBatch` と同じ）ので、`external` の束が切れたときも
   * 断り書きが載るはずである——ここはその歯（このファイルの「人間の発言
   * でも同じ断り書きが載る」と同型。旧 `clone.test.ts`、#1744 で分割済み）。
   *
   * **この歯が無いと、`#pump` で `const mergedExternal = ...` を
   * `this.#notices.set('mergedBatchTruncation', '')` より上に置く事故を誰も
   * 検出できない**（置くと `#mergedExternalBatch` が立てた印を、直後の
   * リセットが即座に拭き取り、`external` の束でだけ断り書きが黙って消える）。
   */
  it('external の束が上限で切れたときも、まとめ読みの断り書き（`CloneNotices` の `mergedBatchTruncation`）が載る', async () => {
    const s = setup(undefined, createMemoryStores(), {}, { ALTEROID_MERGED_BATCH_SIZE_LIMIT: '2' });

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    // `source` は `'ci'`（直前の歯と同じ理由——#852 で `'token-pool'` は台帳を
    // 開かなくなったので、待ち条件が使う「台帳に載せた」の断り書きが出ない）。
    s.clone.post(externalEvent('trunc1', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:01.000Z'));
    s.clone.post(externalEvent('trunc2', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:02.000Z'));
    s.clone.post(externalEvent('trunc3', 'ci', { text: '同じ中身' }, '2026-09-01T00:00:03.000Z'));

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('id: `trunc3`')),
      '3件目（単独）のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 先客 + [trunc1+trunc2まとめ・切った束] + [trunc3単独] = 3本。
    expect(inputs).toHaveLength(3);

    const truncated = inputs[1] ?? '';
    expect(lineStartingWith(truncated, '[system] **このターンへ束ねる合図は、上限')).toMatch(
      /^\[system\] \*\*このターンへ束ねる合図は、上限（2 件）で切った束である（この束は 2 件。\d{2}:\d{2}:\d{2}Z 時点）。\*\*同じ束に入るはずの合図が、待ち行列の先頭にあと 1 件連続して残っている。$/,
    );
    expect(truncated).toContain(
      '**1件も失われていない** —— 上限で止めただけで、外れた分は次のターンで同じ形でまた束ね直される。',
    );

    // 3件目（単独）には切った断り書きが載らない——待ち行列に何も残っていない。
    const solo = inputs[2] ?? '';
    expect(solo).not.toContain('このターンへ束ねる合図は、上限');

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは既存の buildExternalEventPrompt の本文がそのまま出る（単発経路の非回帰）', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(externalEvent('solo', 'ci', { status: 'failure' }, new Date().toISOString()));

    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('failure') ?? false,
      '2本目のターンが投げられる',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    expect(inputs).toHaveLength(2);
    const solo = inputs[1] ?? '';
    expect(solo).toContain(
      '[system] 外部から出来事が届いた（source: ci）。人間はこれを見ていない。',
    );
    // まとめ読みの前置き（件数の表示）が載らない。
    expect(solo).not.toContain('まとめて渡す');

    await s.clone.stop();
  }, 15_000);

  /**
   * **鍵が作れない（`JSON.stringify` が投げる循環参照）場合は「束ねない」へ
   * 倒す。** `#mergedExternalBatch` は `#pump` の `try` の外で呼ばれるので、
   * ここで例外を漏らせば受信箱のループそのものが死ぬ——それを撃つ歯である。
   * 循環参照2件の後に正常な external をもう1件続け、**そちらも処理される
   * こと**（＝ループが生きていること）を確かめる。
   */
  it('鍵が作れない payload（循環参照）でも束ねず、受信箱のループは死なない', async () => {
    const s = setup();

    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    const circular: Record<string, unknown> = { text: '循環参照' };
    circular.self = circular;

    s.clone.post(externalEvent('circ1', 'token-pool', circular, '2026-09-01T00:00:00.000Z'));
    s.clone.post(externalEvent('circ2', 'token-pool', circular, '2026-09-01T00:00:01.000Z'));
    // ループが生きていることを確かめるため、正常な合図をもう1件続ける。
    s.clone.post(
      externalEvent('normal', 'token-pool', { text: '正常' }, '2026-09-01T00:00:02.000Z'),
    );

    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('正常')),
      '循環参照の後も処理が続く',
    );
    await settle();

    const inputs = (s.calls[0] as FakeCall).inputs;
    // 鍵が作れないので束ねない ⟹ 先客 + circ1単独 + circ2単独 + normal単独 = 4本。
    expect(inputs).toHaveLength(4);

    await waitFor(
      async () => (await s.stores.inbox.claimPending()).length === 0,
      '4件とも消し込まれる',
    );

    await s.clone.stop();
  }, 15_000);
});
