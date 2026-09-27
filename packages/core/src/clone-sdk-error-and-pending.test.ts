import { describe, it, expect } from 'vitest';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import type { CloneHost } from './host.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, lineStartingWith, waitFor, waitForDone } from './clone-test-harness.js';
import type { Setup } from './clone-test-harness.js';

/**
 * **エラーが「応答」として保存される穴**（この改修の本体）。
 *
 * 実際に起きた壊れ方は、日報の本文が丸ごとこれになっていた、というものである。
 *
 * ```
 * You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message
 * ```
 *
 * 経路は3つ重なっていた（`sdk-failure.ts` の doc）。
 *
 * 1. `assistant.error`（SDK が「これは応答ではない」と付ける印）を1度も見ておらず、
 *    text ブロックを無条件に `turn.text` へ足していた
 * 2. `isSuccessResult` が `subtype === 'success'` だけを見ており、`is_error: true`
 *    を成功として通していた
 * 3. `#runTurn` の戻り値が `string` 一本で成否を運ばず、日報はそれを本文にした
 *
 * **さらに、失敗したときに書かれた1件が再試行を殺していた** — 上限の合図は保持
 * されて配り直されるのに、その1件があるせいで `#dailyReport` の早期 return と
 * `missingDailyReportDates` の両方が「もう書いた」と判断する。
 *
 * だからここで見るのは4つである。
 *
 * - エラーの文言が日報の本文にならないこと
 * - **枠で保持している回は日報の行を1つも書かないこと**（再試行を殺さない）
 * - 枠ではない失敗では `unavailable` の印付きで書き、印の行は「日報がある」と
 *   数えないこと
 * - `assistant.error` / `is_error` のどちらの経路でも、本文が応答にならないこと
 */
describe('クローン — SDK のエラーを応答として扱わない（日報がエラー文になる穴）', () => {
  /** 実機で観測された文言そのまま（`USAGE_LIMIT_ERROR_PREFIXES` の1つめに当たる）。 */
  const orgSpendLimit =
    "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

  function postDailyReport(clone: CloneHost, date: string): void {
    clone.post({
      type: 'timer',
      id: `evt-timer-${date}`,
      at: new Date().toISOString(),
      kind: 'daily_report',
      target: date,
    });
  }

  const reportsOf = async (stores: Stores) =>
    (await stores.journal.list({ types: ['daily_report'] })) as {
      type: 'daily_report';
      date: string;
      body: string;
      unavailable?: string;
    }[];

  it('assistant.error が付いた本文は日報にならず、枠で保持している回は日報の行を1つも書かない', async () => {
    // 実機の形: 上限の文言は `assistant` メッセージとして届き、`error` が付く。
    // `result` は `subtype: 'success'` で返る（`is_error` も立たない）ので、
    // **印を見ないと成功と区別が付かない**回である。
    const s = setup(() => 'ここは日報の本文になってはいけない', createMemoryStores(), {
      assistantErrorAt: () => ({ error: 'billing_error', text: orgSpendLimit }),
    });

    postDailyReport(s.clone, '2026-08-19');

    // ターンが畳まれたことを、失敗の記録で確かめる（`#reportFailure` の内部ターン側）。
    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, '日報のターンが失敗として記録される');

    // **枠で保持しているので、日報の行は1件も無い。** ここに印だけでも書くと、
    // 配り直しで走り直したときに早期 return して本物が永久に書かれない。
    expect(await reportsOf(s.stores)).toHaveLength(0);

    // 失敗の記録には SDK の文言がそのまま残る（人間が検索できる形）。
    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
    );
    expect(failures[0]?.text).toContain(orgSpendLimit);
    expect(failures[0]?.text).toContain('billing_error');
    // どの印で分かったかも残す（次に掘り始める位置が違う）。
    expect(failures[0]?.text).toContain('assistant_error');

    // 上限として分類され、保持へ切り替わっている（枠の知らせが日誌にある）。
    const notices = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) => entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}利用上限に当たった`));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(orgSpendLimit);

    await s.clone.stop();
  });

  it('subtype:success でも is_error が立っていれば応答として扱わない', async () => {
    // `isSuccessResult`（台帳の問い）は `subtype === 'success'` だけを見るので、
    // この回を成功として通す。**応答の問いは `isAnsweredResult` が答える。**
    const s = setup(() => 'これも日報の本文になってはいけない', createMemoryStores(), {
      resultFor: () => ({ subtype: 'success', text: orgSpendLimit, isError: true }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, '日報のターンが失敗として記録される');

    // 枠として分類されるので保持側。日報は書かれない。
    expect(await reportsOf(s.stores)).toHaveLength(0);

    const failures = (
      (await s.stores.journal.list({ types: ['exchange'] })) as { with: string; text: string }[]
    ).filter((entry) =>
      entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
    );
    // `subtype` が `success` のまま失敗した回だと分かる形で残っていること。
    expect(failures[0]?.text).toContain('result_is_error');

    await s.clone.stop();
  });

  it('枠ではない失敗では unavailable の印付きで書き、印の行は「日報がある」と数えない', async () => {
    const stores = createMemoryStores();
    const s = setup(() => '部分的に出ていた本文', stores, {
      // 枠ではない失敗（`classifyUsageNotice` に当たらない文言）。**保持しない**
      // ので、日報が無い日を作らないために印付きの行を書く側になる。
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });

    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(stores)).length === 1, '印付きの行が書かれる');
    const placeholder = (await reportsOf(stores))[0];
    // **本文がエラー文そのものになっていない**（ここが直った点）。
    expect(placeholder?.body).not.toBe('内部で何かが壊れた');
    expect(placeholder?.body).toContain('作れなかった');
    // 理由は落とさない（人間が掘るときの手がかり）。
    expect(placeholder?.unavailable).toContain('内部で何かが壊れた');
    await s.clone.stop();

    // 同じ日をもう一度締める。**印の行は「日報がある」と数えないので、本物が書ける。**
    const again = setup(() => '今日はログイン周りを直した。保留は無い。', stores);
    postDailyReport(again.clone, '2026-08-19');
    await waitFor(async () => {
      const reports = await reportsOf(stores);
      return reports.some((entry) => entry.unavailable === undefined);
    }, '後から本物の日報が書ける');

    const written = (await reportsOf(stores)).filter((entry) => entry.unavailable === undefined);
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toContain('ログイン周り');
    await again.clone.stop();
  });

  it('本物の日報が既にある日は、失敗しても印の行を足さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'daily_report',
      date: '2026-08-19',
      body: 'クローンが道具で書いた日報',
    });

    // 道具で書いた**後に**ターンが失敗した回（`daily_report_write` は成功した
    // のに result が失敗で返る、はありうる）。印を足すと、人間が読む唯一の層に
    // 「作れなかった」が並んで見える。
    const s = setup(() => '書いておいた', stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => {
      const exchanges = (await stores.journal.list({ types: ['exchange'] })) as {
        with: string;
        text: string;
      }[];
      return exchanges.some(
        (entry) =>
          entry.with === 'self' &&
          entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}内部ターンが失敗した`),
      );
    }, 'ターンが失敗として記録される');

    const reports = await reportsOf(stores);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.unavailable).toBeUndefined();
    await s.clone.stop();
  });

  it('成功したターンでは印を付けない（この機構が普段の日報を壊していないこと）', async () => {
    const s = setup(() => '今日はログイン周りを直した。保留は無い。');
    postDailyReport(s.clone, '2026-08-19');

    await waitFor(async () => (await reportsOf(s.stores)).length === 1, '日報が書かれる');
    const report = (await reportsOf(s.stores))[0];
    expect(report?.unavailable).toBeUndefined();
    expect(report?.body).toContain('ログイン周り');
    await s.clone.stop();
  });

  it('組織方針で止められた回も日誌に残る（待たないが、記録はする）', async () => {
    // `ORG_POLICY_LIMIT_PREFIXES` の文言。**利用上限とは別**で、待っても直らない。
    // 直す前はここで早期 return していたので、日誌に1行も残らなかった。
    const orgPolicy = 'This service is disabled for your organization';
    const s = setup(() => 'なにか', createMemoryStores(), {
      resultFor: () => ({ subtype: 'error_during_execution', text: orgPolicy }),
    });

    s.clone.post(humanMessage('一件目'));

    await waitFor(async () => {
      const exchanges = (await s.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      return exchanges.some((entry) =>
        entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}組織の方針で止められている`),
      );
    }, '組織方針の知らせが日誌に残る');

    // **待たない**（保持しない）ことは変えていない。枠として保持していたら、
    // 人間の発言が未読のまま溜まり続ける。
    const notices = s.events.filter((event) => event.type === 'usage_limited');
    expect(notices).toHaveLength(0);

    await s.clone.stop();
  });
});

/**
 * 人間は返事を待っているあいだも喋る。
 *
 * **ここで守っているのは「まとめること」ではなく「まとめても失われないこと」である。**
 * 1件ずつ別ターンで読む形は、後で言い直された最初の一言に本気で答えてから、次の
 * ターンでその仕事をやり直す（費用も二重に払う）。だからまとめる — ただし全文・
 * 順序・器の未読・台帳の id のどれか1つでも落ちたら、それは「畳んで捨てた」に
 * なる。この describe はその4つを1本ずつ見ている。
 */
describe('クローン — 処理待ちのあいだに積み上がった発言', () => {
  /** 先客のターンが実際に走り始めるまで待つ（積んだ時点で「処理待ち」だと言えるようにする）。 */
  const waitForFirstTurn = (s: Setup): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

  /** 積んだ最後の発言が、どのターンかは問わず SDK へ渡るまで待つ。 */
  const waitForDelivered = (s: Setup, text: string): Promise<void> =>
    waitFor(() => (s.calls[0]?.inputs ?? []).join('\n').includes(text), `${text} が渡る`);

  /**
   * まとめた／まとめないの判定は**ターンの本数**で出る。本数を `waitFor` で待つと、
   * 期待どおりにならない世界（＝変異させた世界）でタイムアウトになり、
   * **タイムアウトは歯があった証拠にならない**（AGENTS.md）。だから
   * 「最後の発言が届いた」まで待ってから少し置き、本数は等値で比べる。
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

  it('処理待ちに積み上がった発言は1ターンにまとめて渡る（全文が届いた順に載る）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 250 });

    s.clone.post(humanMessage('一件目'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('二件目'));
    s.clone.post(humanMessage('三件目'));

    await waitForDelivered(s, '三件目');
    await settle();

    // 先客の1本 + 積み上がった2件をまとめた1本 = 2本。**3本ではない**
    expect(s.calls[0]?.inputs).toHaveLength(2);

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('二件目');
    expect(merged).toContain('三件目');
    // issue #783 の続き：「N件が届いた」ではなく「N件をまとめて渡す」
    // （束の件数であって届いた総数ではないため、上限で切っても偽にならない）。
    expect(merged).toContain('続けて **2 件** まとめて渡す');
    // 届いた順のまま渡す（言い直しを先に読ませない）
    expect(merged.indexOf('二件目')).toBeLessThan(merged.indexOf('三件目'));

    await s.clone.stop();
  }, 15_000);

  it('1件だけのときは本文に断り書きを足さない（普通の一往復を重くしない）', async () => {
    const s = setup(() => 'わかった');

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const input = s.calls[0]?.inputs[0] ?? '';
    expect(input).toContain('やあ');
    expect(input).not.toContain('の発言が届いた');
    expect(input).not.toContain('まとめて1つの応答で答えよ');

    await s.clone.stop();
  });

  it('会話が違う発言はまとめない（別の端末で話している相手の画面に応答を流さない）', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客', 'conv-1'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('こちら1', 'conv-1'));
    s.clone.post(humanMessage('あちら', 'conv-2'));
    s.clone.post(humanMessage('こちら2', 'conv-1'));

    await waitForDelivered(s, 'こちら2');
    await settle();

    // 4件が4本のまま走る（会話をまたいで束ねない）
    expect(s.calls[0]?.inputs).toHaveLength(4);
    const second = s.calls[0]?.inputs[1] ?? '';
    expect(second).toContain('こちら1');
    expect(second).not.toContain('あちら');
    expect(second).not.toContain('こちら2');

    await s.clone.stop();
  }, 15_000);

  // **この歯はかつて「間に別の起点が挟まったら飛び越えない（受信箱の順序を
  // 並べ替えない）」という名前で、飛び越えないことを保証していた。** 人間から
  // 「優先度を人間 > マネージャーにできますか？ 割り込んでもいいので人間への
  // 回答を優先するようにしてほしい」（2026-08-22 JST、逐語）という要望を受け、
  // `CLONE_HUMAN_PRIORITY_ENV_KEY`（既定で有効）により**人間の発言だけ**が
  // 待ち行列上で人間以外を飛び越すようになった。飛び越すのは人間どうしの中で
  // 最後尾へ、であって人間以外は互いに追い越さない — この歯はいま真になった
  // その形（人間以外どうしの非喪失・順序保存）を測る。人間が飛び越す場面は
  // 上の `describe('クローン — 人間が待っている合図を待ち行列の先頭側へ入れる', ...)`
  // が別に測っている。
  it('人間以外どうしは、間に別の起点が挟まっても飛び越えない', async () => {
    const s = setup(() => 'わかった', createMemoryStores(), { delayMs: 150 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('挟まる前'));
    s.clone.post({
      type: 'external',
      id: 'evt-ext',
      at: new Date().toISOString(),
      source: 'webhook',
      payload: '先に届いた外部イベント',
    });
    s.clone.post(humanMessage('挟まった後'));

    await waitForDelivered(s, '挟まった後');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    // **実測で決めた期待値（2026-08-22 観測）。** 「挟まった後」は待ち行列上、
    // 到着順ではなく人間の最後尾（＝「挟まる前」の直後）へ入り直すので、external
    // を飛び越えて「挟まる前」に連続する。連続した人間の発言2件は
    // `#mergedHumanBatch` により1ターンにまとめられる（まとめられること自体は
    // 依頼者が受け入れ済み）。だから本数は「先客」＋「人間2件の合流ターン」＋
    // 「external」の3本になる（4本ではない）。
    expect(inputs).toHaveLength(3);
    // 人間2件が1ターンにまとまる。
    expect(inputs[1]).toContain('挟まる前');
    expect(inputs[1]).toContain('挟まった後');
    // まとめても本文中の順序は到着順のまま（言い直しを先に読ませない）。
    const merged = inputs[1] ?? '';
    expect(merged.indexOf('挟まる前')).toBeLessThan(merged.indexOf('挟まった後'));
    // 外部イベントが人間の発言に追い越されない
    // だった。いまは人間が飛び越す（人間の決定。逐語は `CLONE_HUMAN_PRIORITY_ENV_KEY`）。
    // その結果、external は人間2件がまとまった後（3本目）に置かれる。
    expect(inputs[2]).toContain('先に届いた外部イベント');

    await s.clone.stop();
  }, 15_000);

  it('まとめた分は1件も器に残らない（起動のたびに配り直される形を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    // まとめて読んだ2件のどちらも未読から消えている（1件でも残れば次の起動で配り直される）
    expect(await stores.inbox.claimPending()).toEqual([]);

    await s.clone.stop();
  }, 15_000);

  it('まとめた件数ぶんの未了 id が断り書きに載る（閉じ方を渡さない未了を作らない）', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    s.clone.post(humanMessage('続き1'));
    s.clone.post(humanMessage('続き2'));

    await waitForDelivered(s, '続き2');
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain('2 件も台帳に載せた');
    // 台帳の id は合図の id そのもの（`commitmentFor`）。2件とも渡す
    expect(merged).toContain('evt-続き1');
    expect(merged).toContain('evt-続き2');
    expect(merged).toContain('閉じるのは id ごとである');

    await s.clone.stop();
  }, 15_000);

  /**
   * **未了 id の列挙にも上限が要る（#409）。** `idList` はまとめて届いた件数
   * ぶん伸びる列挙で、`.map().join()` に上限も合図も無かった。大量にまとめて
   * 届くと、切っていない実装ではこの1行だけで数百文字になる——ここでは
   * 抜粋の合図（`excerptLine` の「省略」）が出て、伸び続けないことを見る。
   */
  it('まとめて届いた未了が大量でも、id の列挙は抜粋の合図で締まる', async () => {
    const stores = createMemoryStores();
    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    s.clone.post(humanMessage('先客'));
    await waitForFirstTurn(s);
    const count = 50;
    for (let index = 0; index < count; index += 1) {
      s.clone.post(humanMessage(`続き${index}`));
    }

    await waitForDelivered(s, `続き${count - 1}`);
    await settle();

    const merged = s.calls[0]?.inputs[1] ?? '';
    expect(merged).toContain(`${count} 件も台帳に載せた`);
    const line = merged.split('\n').find((entry) => entry.includes('台帳に載せた（id:'));
    expect(line).toBeDefined();
    // 50件の生の id をそのまま出せば数百文字になる。ここでは合図が出て、
    // 際限なく伸びていないことを見る。
    expect(line!.length).toBeLessThan(600);
    expect(line).toMatch(/省略/);

    await s.clone.stop();
  }, 15_000);

  /**
   * **⚠️ issue #783 で期待値を反転した（名前は歴史として残す）。** 以前は
   * `#mergeable` が配り直し（`#redelivered`）を無条件で外していたので、この
   * 2件は必ず別々のターンで読まれ、断り書きも1件ごとの文言だった
   * （かつての期待値）:
   *   expect(inputs).toHaveLength(2);
   *   expect(inputs[0]).toContain('配り直しである');
   *   expect(inputs[0]).toContain('未読1');
   *   expect(inputs[0]).not.toContain('未読2');
   * **いまは配り直しも束ねる対象になった**（`#mergedHumanBatch` が同じ
   * `conversationId` の連続する `human_message` をまとめる。`#mergeable` の
   * doc）ので、この2件は隣接して1つの束になる。**「何が二度目なのか言えなく
   * なる」は起きていない** —— 束の行（`#redeliveryNoticeFor`）が「束 2 件の
   * うち 2 件が配り直し」と件数を、本文側（`humanTurnText`）が「未読1」
   * 「未読2」の両方の全文を、それぞれ渡す。
   */
  it('配り直しの合図はまとめる（束の行が件数を言うので、何が二度目かは言える。issue #783）', async () => {
    // 前の器が処理を終えられなかった2件。起動時に拾い直される（`#restoreUnread`）
    const stores = createMemoryStores();
    await stores.inbox.put(humanMessage('未読1'), '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(humanMessage('未読2'), '2026-08-20T10:00:01.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '未読2');
    await settle();

    const inputs = s.calls[0]?.inputs ?? [];
    // 1本の束にまとまる（先客が居ないので合流ターンがそのまま1本目）。
    expect(inputs).toHaveLength(1);
    const merged = inputs[0] ?? '';
    // **束の行を1行として取り出し、全文一致で測る**（`toContain` は同じ語が
    // 別の行に在ると節ごと消しても緑のままになる。`lineStartingWith` の doc）。
    // 件数・最大配達回数・最古時刻の3つを、1行の中で同時に固定する。
    const noticeLine = lineStartingWith(merged, '[system] **これは配り直しの束である');
    expect(noticeLine).toBe(
      '[system] **これは配り直しの束である（束 2 件のうち 2 件が配り直し、最大 1 回の配達、' +
        '最も古いものは 2026-08-20T10:00:00.000Z に受け取った）。**' +
        '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    );
    // 全文は1文字も捨てない —— 2件とも本文に現れる。
    expect(merged).toContain('未読1');
    expect(merged).toContain('未読2');

    await s.clone.stop();
  }, 15_000);

  /**
   * **`#restoreUnread` の配り直しも `post()` と同じ人間優先を効かせる。** `post()`
   * は `Inbox#push` へ `insertAfterLast`（人間なら `isHumanOriginated`）を渡して
   * 人間の発言を待ち行列の人間の最後尾へ入れるが、`#restoreUnread` はこれまで
   * 第2引数を渡さずに `this.#inbox.push(record.event)` と呼んでいた（`post` を
   * 通さない理由は tick の畳み込みで落ちた行が残り続けるためであり、それとは
   * 別に人間優先まで一緒に落ちていた）。
   *
   * **先頭の1件だけでは測れない。** `#pump` は `#restoreUnread` を `void` で
   * 起こしてから直後に `for await (const event of this.#inbox)` を張るので、
   * 待ち手（`Inbox` の `#waiters`）は `claimPending` が返る前から既に登録
   * 済みである。claim 順で**最初に配り直される1件は、待ち行列を経由せず
   * 待ち手へ直接渡って即座に走行中のターンになる**（`insertAfterLast` は
   * 「待ち手が居れば素通し」なので、ここには一切効かない —
   * `Inbox#push` の doc「待ち手が居るときは順序の話にならない」）。実測
   * （2026-08-27）: `[非人間, human, 非人間]` の3件だけで claim 順を
   * `human` が中間に来るよう仕込んでも、直した実装を当てても当てなくても
   * ターンの並びは1文字も変わらなかった——先頭の非人間が即座に走行中の
   * ターンを奪い、残り2件（human・非人間）が積まれる先の待ち行列は
   * 常に空で、`insertAfterLast` に飛び越す相手が居ないため。
   *
   * だからここでは**先頭に「奪われ役」の非人間を1件多く置く**：
   * `非人間A`（claim 順で最初、走行中のターンを奪う）→ `非人間C`（待ち行列に
   * 積まれて残る）→ `human`（`非人間C` を飛び越せるかが本題）→ `非人間B`
   * （human より後なので、直しても飛び越されない）。飛び越す本題は
   * `human` 対 `非人間C` の1組で足りる。
   */
  it('起動直後の配り直しでも、人間の発言は待ち行列に残っていた非人間より先に読まれる（#restoreUnread の人間優先）', async () => {
    const stores = createMemoryStores();
    const nonHumanA: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-a',
      at: '2026-08-20T10:00:00.000Z',
      source: 'webhook-a',
      payload: '非人間A（claim順で最初・走行中のターンを奪う）',
    };
    const nonHumanC: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-c',
      at: '2026-08-20T10:00:01.000Z',
      source: 'webhook-c',
      payload: '非人間C（待ち行列に積まれて残る）',
    };
    const human = humanMessage('人間の発言だ');
    const nonHumanB: InboxEvent = {
      type: 'external',
      id: 'evt-nonhuman-b',
      at: '2026-08-20T10:00:03.000Z',
      source: 'webhook-b',
      payload: '非人間B（human より後・飛び越されない）',
    };

    // claim 順（＝ `put` の第2引数。`stores.inbox.claimPending` が並べ替えに
    // 使うのはこちらで、`event.at` ではない）で
    // [非人間A, 非人間C, human, 非人間B] に並ぶよう仕込む。`humanMessage()` は
    // `event.at` に呼び出し時の実時刻を積むので、`event.at` をそのまま claim
    // 順へ使うと（今日の日付が2026-08-20より後になり）human が最後尾に落ちる
    // ——claim 順は明示的に別で渡す。
    await stores.inbox.put(nonHumanA, '2026-08-20T10:00:00.000Z');
    await stores.inbox.put(nonHumanC, '2026-08-20T10:00:01.000Z');
    await stores.inbox.put(human, '2026-08-20T10:00:02.000Z');
    await stores.inbox.put(nonHumanB, '2026-08-20T10:00:03.000Z');

    const s = setup(() => 'わかった', stores, { delayMs: 200 });

    await waitForDelivered(s, '非人間B（human より後・飛び越されない）');
    await settle();

    const joined = (s.calls[0]?.inputs ?? []).join('\n');
    const idxA = joined.indexOf('非人間A（claim順で最初・走行中のターンを奪う）');
    const idxC = joined.indexOf('非人間C（待ち行列に積まれて残る）');
    const idxHuman = joined.indexOf('人間の発言だ');
    const idxB = joined.indexOf('非人間B（human より後・飛び越されない）');

    // 4件とも実際に届いている（見つからない＝-1 を「先」と誤読しない）
    expect(idxA).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(-1);
    expect(idxHuman).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    // 本題: 待ち行列に積まれて残っていた非人間Cより、human が先に読まれる
    expect(idxHuman).toBeLessThan(idxC);

    // 非人間は1件も消えず、非人間どうしの到着順（A → C → B）は保たれる
    expect(idxA).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxB);

    // human より後に claim された非人間Bは、human を追い越さない
    expect(idxHuman).toBeLessThan(idxB);

    await s.clone.stop();
  }, 15_000);
});
