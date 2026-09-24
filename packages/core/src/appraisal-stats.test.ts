import { describe, expect, it } from 'vitest';

import {
  computeAppraisalJournalStats,
  computeAppraisalReconciliation,
  computeJobAppraisalCoverage,
  describeAppraisalStats,
  isTerminalJobStatus,
  tallyAppraisalDecisions,
  type AppraisalReconciliationStats,
} from './appraisal-stats.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import {
  COMMITMENT_APPRAISAL_CLONE_GROUNDS,
  COMMITMENT_APPRAISAL_DECISION_PREFIX,
  COMMITMENT_APPRAISAL_HUMAN_GROUNDS,
  formatAppraisalDecision,
  inferAppraisedByFromGrounds,
  JOB_APPRAISAL_CLONE_GROUNDS,
  JOB_APPRAISAL_DECISION_PREFIX,
  JOB_APPRAISAL_HUMAN_GROUNDS,
  parseAppraisalDecisionId,
  parseAppraisalDecisionValue,
  type Job,
  type JobStatus,
  type JournalEntry,
  type JournalEntryInput,
} from './schema.js';
import { createMemoryStores } from './testing.js';

/** {@link describeAppraisalStats} のテスト向け——対の食い違いが無い、空の reconciliation。 */
function emptyReconciliation(): AppraisalReconciliationStats {
  const empty = { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 };
  return { commitments: { ...empty }, jobs: { ...empty } };
}

const T1 = '2026-08-01T00:00:00.000Z';

/** `decision` 行を1件組み立てる。 */
function decisionEntry(
  id: string,
  decision: string,
  overrides: Partial<JournalEntry> = {},
): JournalEntry {
  return { type: 'decision', id, at: T1, decision, grounds: '', ...overrides } as JournalEntry;
}

/** 委譲の1本を組み立てる（`appraisal.test.ts` の `job` ヘルパと同じ形）。 */
function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: T1,
    updatedAt: T1,
    status: 'done',
    summary: '委譲の要旨',
    ...overrides,
  };
}

describe('formatAppraisalDecision / parseAppraisalDecisionValue — 書式の組み立てと読み解きの往復（#1278）', () => {
  it('reason も previous も無いとき、値がそのまま読み取れる', () => {
    const decision = formatAppraisalDecision({
      prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      id: 'c1',
      value: 'good',
      reason: undefined,
      previous: null,
    });
    expect(decision).toBe(`${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c1）: good`);
    expect(parseAppraisalDecisionValue(decision, COMMITMENT_APPRAISAL_DECISION_PREFIX)).toBe(
      'good',
    );
  });

  it('reason も previous も在るとき（区切りに空白が無い形）でも値が読み取れる', () => {
    // **ここが罠になりうる箇所である。** reason が無いと `${value}（前: …）` の
    // ように value と次の要素のあいだに空白が無い——`\S+` のような素朴な正規表現で
    // 切ると「good（前:」まで1語として拾ってしまう。
    const decision = formatAppraisalDecision({
      prefix: JOB_APPRAISAL_DECISION_PREFIX,
      id: 'm1',
      value: 'bad',
      reason: undefined,
      previous: '評定: うまくいった（good）',
    });
    expect(decision).toBe(
      `${JOB_APPRAISAL_DECISION_PREFIX}（m1）: bad（前: 評定: うまくいった（good））`,
    );
    expect(parseAppraisalDecisionValue(decision, JOB_APPRAISAL_DECISION_PREFIX)).toBe('bad');
  });

  it('reason 在り・previous 無しでも読み取れる', () => {
    const decision = formatAppraisalDecision({
      prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      id: 'c2',
      value: 'unclear',
      reason: '材料が足りない',
      previous: null,
    });
    expect(decision).toBe(
      `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c2）: unclear — 材料が足りない`,
    );
    expect(parseAppraisalDecisionValue(decision, COMMITMENT_APPRAISAL_DECISION_PREFIX)).toBe(
      'unclear',
    );
  });

  it('prefix で始まらない decision は undefined（印が違う）', () => {
    expect(
      parseAppraisalDecisionValue('無関係な行', COMMITMENT_APPRAISAL_DECISION_PREFIX),
    ).toBeUndefined();
  });

  it('prefix で始まるが、区切り「）: 」が無い壊れた行は other', () => {
    expect(
      parseAppraisalDecisionValue(
        `${COMMITMENT_APPRAISAL_DECISION_PREFIX}壊れている`,
        COMMITMENT_APPRAISAL_DECISION_PREFIX,
      ),
    ).toBe('other');
  });

  it('既知の3値のどれでもない値は other として読める（未知の値を落とさない）', () => {
    const decision = `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c3）: brilliant`;
    expect(parseAppraisalDecisionValue(decision, COMMITMENT_APPRAISAL_DECISION_PREFIX)).toBe(
      'other',
    );
  });

  it('2つの印を取り違えると undefined になる（混ぜて数えられない構造そのものの確認）', () => {
    const decision = formatAppraisalDecision({
      prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      id: 'c4',
      value: 'good',
      reason: undefined,
      previous: null,
    });
    expect(parseAppraisalDecisionValue(decision, JOB_APPRAISAL_DECISION_PREFIX)).toBeUndefined();
  });
});

describe('tallyAppraisalDecisions — 日誌のエントリ群から先頭一致で数える（純関数）', () => {
  it('good/bad/unclear/other を正しく振り分け、無関係な行・別の印・別の種別は数えない', () => {
    const entries: JournalEntry[] = [
      decisionEntry('1', `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（a）: good`),
      decisionEntry('2', `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（b）: bad — うまくいかなかった`),
      decisionEntry('3', `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c）: unclear`),
      decisionEntry('4', `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（d）: weird`),
      decisionEntry('5', `${JOB_APPRAISAL_DECISION_PREFIX}（e）: good`), // 別の印——数えない
      decisionEntry('6', '無関係な decision 行'),
      {
        type: 'tool_use',
        id: '7',
        at: T1,
        actor: 'clone',
        tool: 'commitment_list',
      } as JournalEntry, // decision 以外の種別
    ];

    const tally = tallyAppraisalDecisions(entries, COMMITMENT_APPRAISAL_DECISION_PREFIX);
    expect(tally).toEqual({ good: 1, bad: 1, unclear: 1, other: 1, total: 4 });
  });

  it('0件でも total=0 のオブジェクトを返す（「無い」が判定できる形で返る）', () => {
    expect(tallyAppraisalDecisions([], COMMITMENT_APPRAISAL_DECISION_PREFIX)).toEqual({
      good: 0,
      bad: 0,
      unclear: 0,
      other: 0,
      total: 0,
    });
  });

  it('200件を超える decision 行でも全件数える（journal_read の limit=200 には縛られないことの確認）', () => {
    // #1278 本文の実測: journal_read は limit の上限 200 に当たって総数 263 の
    // 側が切れた。この歯が確かめるのは「**この純関数が、渡された配列の件数に
    // 上限を持たない**」ことである——境界値のすぐ外側（201件）ではなく、実測に
    // 近い263件で作る。
    //
    // ⚠️ **ここは「limit を渡していないこと」を測っていない。**
    // `tallyAppraisalDecisions` は純関数で、ストアを1度も呼ばない——`limit` を
    // 渡す／渡さないという主語がそもそも無い。以前ここにそう書いてあったが、
    // それは書いた時点から誤りだった（#1342 で直した。有界化とは独立の訂正）。
    const entries: JournalEntry[] = Array.from({ length: 263 }, (_, i) =>
      decisionEntry(`c${i}`, `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（id-${i}）: good`),
    );
    const tally = tallyAppraisalDecisions(entries, COMMITMENT_APPRAISAL_DECISION_PREFIX);
    expect(tally.total).toBe(263);
    expect(tally.good).toBe(263);
  });
});

describe('computeAppraisalJournalStats — ストアをページ送りで読み、2つの印を数える（I/O あり）', () => {
  it('総数200件超でもストア経由で全件返る（1ページに収まる母集団での結合確認）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 210; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c${i}）: good`,
        grounds: '',
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `${JOB_APPRAISAL_DECISION_PREFIX}（m${i}）: bad`,
        grounds: '',
      });
    }

    const stats = await computeAppraisalJournalStats(stores.journal, {
      commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
    });
    // journal_read（MCP の道具）を同じ条件で引けば limit=200 に当たって切れる
    // ——ここでは道具を経由していないので、210件全部が数えられていることを見る。
    //
    // **この歯が守っているのは「全件が数えられること」であって「`limit` を
    // 渡していないこと」ではない**（#1342）。210件は1ページ
    // （`JOURNAL_SCAN_PAGE_SIZE` ＝ 500）に収まるので、ページ送りが実際に回る
    // 側は直下の歯が測る——**この歯だけでは、ページ送りが1度も回らない。**
    expect(stats.commitments.total).toBe(210);
    expect(stats.commitments.good).toBe(210);
    expect(stats.jobs.total).toBe(5);
    expect(stats.jobs.bad).toBe(5);
  });

  /**
   * **#1342 —— 日誌走査の契約が repo の中で矛盾していた件の、当て直した歯。**
   *
   * 直前の歯（210件）は「全件が数えられること」を守っているが、210 は1ページ
   * （`JOURNAL_SCAN_PAGE_SIZE` ＝ 500）に収まるので**ページ送りが1度も回らない**。
   * ここは母集団を1ページより大きく取り、2つを同時に測る:
   *
   * 1. **全件が数えられる** —— #1278 が求めた「全期間の総数」。ページ送りが途中で
   *    打ち切れば `total` が減るので落ちる
   * 2. **ストアへ `limit` 無指定の読みを1本も出さない** —— #1283 系の OOM の形
   *    そのもの。`createSyntheticJournalStore` は `limit` が有限の正の数でなければ
   *    その場で例外を投げる（`journal-scan.test-support.ts` の doc）ので、
   *    **ページ送りを外して無制限へ戻すと、この歯は落ちる**
   *
   * ⟹ **1 だけでも 2 だけでも足りない。** 1 だけなら「無制限に読んで全件返す」
   * （＝直す前の形）が緑で通り、2 だけなら「有限の `limit` を1回渡して途中で
   * やめる」が緑で通る。**両方を同じ歯に置いてあるのは、どちらの向きの退行も
   * ここ1本で赤くするためである。**
   */
  it('1ページを超える母集団でも全件数え、ストアへは毎回 有限の limit が渡る（#1342）', async () => {
    const total = 1234; // 500 の倍数から外してある——最後の半端なページも通る形で測る
    const commitmentRows = 700;
    const jobRows = 200;
    const synthetic = createSyntheticJournalStore({
      total,
      entryAt: (index) => {
        const decision =
          index < commitmentRows
            ? `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c${index}）: good`
            : index < commitmentRows + jobRows
              ? `${JOB_APPRAISAL_DECISION_PREFIX}（m${index}）: bad — 差し戻し`
              : `どちらの印でもない decision 行（${index}）`;
        return { type: 'decision', decision, grounds: '' } as Omit<JournalEntry, 'id' | 'at'>;
      },
    });

    const stats = await computeAppraisalJournalStats(synthetic.store, {
      commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
    });

    // (1) 全件——1ページに収まらない母集団でも取りこぼさない。
    expect(stats.commitments.total).toBe(commitmentRows);
    expect(stats.commitments.good).toBe(commitmentRows);
    expect(stats.jobs.total).toBe(jobRows);
    expect(stats.jobs.bad).toBe(jobRows);
    // どちらの印でもない decision 行は、どちらの束にも入らない（走査した母集団の
    // 分母と、内訳の分母を混ぜない）。
    expect(synthetic.totalReturned).toBe(total);

    // (2) 有限の limit——`limit` 無指定・無限大・非正の読みが1本も無い。
    // **ページ送りが実際に回ったことを先に見る**（1回で終わっていたら、この
    // for ループは何も測っていないのと同じになる）。
    expect(synthetic.calls.length).toBeGreaterThan(1);
    for (const call of synthetic.calls) {
      expect(Number.isInteger(call.limit)).toBe(true);
      expect(call.limit ?? 0).toBeGreaterThan(0);
      expect(call.limit ?? 0).toBeLessThanOrEqual(JOURNAL_SCAN_PAGE_SIZE);
    }
  });

  it('2つの印を混ぜない（一方だけ書いたら、もう一方は0のまま）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c1）: good`,
      grounds: '',
    });
    const stats = await computeAppraisalJournalStats(stores.journal, {
      commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
    });
    expect(stats.commitments.total).toBe(1);
    expect(stats.jobs.total).toBe(0);
  });
});

describe('parseAppraisalDecisionId / inferAppraisedByFromGrounds — 過去の行の復元に使う2つの純関数（#1310）', () => {
  it('formatAppraisalDecision が組んだ本文から id を読み解ける（reason・previous 併記でも崩れない）', () => {
    const decision = formatAppraisalDecision({
      prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      id: 'c-abc-123',
      value: 'bad',
      reason: '差し戻し',
      previous: '評定: うまくいった（good・clone）',
    });
    expect(parseAppraisalDecisionId(decision, COMMITMENT_APPRAISAL_DECISION_PREFIX)).toBe(
      'c-abc-123',
    );
  });

  it('prefix で始まらない行は undefined', () => {
    expect(
      parseAppraisalDecisionId('無関係な行', COMMITMENT_APPRAISAL_DECISION_PREFIX),
    ).toBeUndefined();
  });

  it('prefix の直後が「（」でない壊れた行は undefined（id が復元できない）', () => {
    expect(
      parseAppraisalDecisionId(
        `${COMMITMENT_APPRAISAL_DECISION_PREFIX}壊れている`,
        COMMITMENT_APPRAISAL_DECISION_PREFIX,
      ),
    ).toBeUndefined();
  });

  it('区切り「）: 」が無い行は undefined', () => {
    expect(
      parseAppraisalDecisionId(
        `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c1）壊れている`,
        COMMITMENT_APPRAISAL_DECISION_PREFIX,
      ),
    ).toBeUndefined();
  });

  it('台帳・クローン/人間の grounds を正しく判別する', () => {
    expect(inferAppraisedByFromGrounds(COMMITMENT_APPRAISAL_CLONE_GROUNDS, 'commitment')).toBe(
      'clone',
    );
    expect(inferAppraisedByFromGrounds(COMMITMENT_APPRAISAL_HUMAN_GROUNDS, 'commitment')).toBe(
      'human',
    );
  });

  it('委譲・クローン/人間の grounds を正しく判別する', () => {
    expect(inferAppraisedByFromGrounds(JOB_APPRAISAL_CLONE_GROUNDS, 'job')).toBe('clone');
    expect(inferAppraisedByFromGrounds(JOB_APPRAISAL_HUMAN_GROUNDS, 'job')).toBe('human');
  });

  it('軸を取り違えると判別できない（台帳の文面を委譲の軸で読まない）', () => {
    expect(inferAppraisedByFromGrounds(COMMITMENT_APPRAISAL_CLONE_GROUNDS, 'job')).toBeUndefined();
    expect(inferAppraisedByFromGrounds(JOB_APPRAISAL_CLONE_GROUNDS, 'commitment')).toBeUndefined();
  });

  it('未知の文面は undefined（判定できないという3つ目の状態）', () => {
    expect(inferAppraisedByFromGrounds('見たことが無い文面', 'commitment')).toBeUndefined();
  });
});

describe('computeAppraisalReconciliation — (b) 人間 と (c) クローンの食い違いを時系列で数える（#1310）', () => {
  /** 構造欄ありの評定行を1件組み立てる（新形式）。 */
  function structuredEntry(params: {
    prefix: string;
    target: 'commitment' | 'job';
    id: string;
    value: 'good' | 'bad' | 'unclear';
    by: 'clone' | 'human';
    previous?: string;
    previousBy?: string;
  }): JournalEntryInput {
    const { prefix, target, id, value, by, previous, previousBy } = params;
    return {
      type: 'decision',
      decision: formatAppraisalDecision({
        prefix,
        id,
        value,
        reason: undefined,
        previous: previous ?? null,
      }),
      grounds:
        target === 'commitment'
          ? by === 'clone'
            ? COMMITMENT_APPRAISAL_CLONE_GROUNDS
            : COMMITMENT_APPRAISAL_HUMAN_GROUNDS
          : by === 'clone'
            ? JOB_APPRAISAL_CLONE_GROUNDS
            : JOB_APPRAISAL_HUMAN_GROUNDS,
      appraisal: { target, id, value, by, previous, previousBy },
    };
  }

  const prefixes = {
    commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
    jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
  };

  it('クローン→人間で同じ値に付け直した対は「一致」', async () => {
    const stores = createMemoryStores();
    await stores.journal.append(
      structuredEntry({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        target: 'commitment',
        id: 'c1',
        value: 'good',
        by: 'clone',
      }),
    );
    await stores.journal.append(
      structuredEntry({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        target: 'commitment',
        id: 'c1',
        value: 'good',
        by: 'human',
        previous: 'good',
        previousBy: 'clone',
      }),
    );
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(1);
    expect(rec.commitments.matched).toBe(1);
    expect(rec.commitments.mismatched).toBe(0);
    expect(rec.commitments.transitions).toEqual([
      { cloneValue: 'good', humanValue: 'good', count: 1 },
    ]);
    expect(rec.commitments.undetermined).toBe(0);
    expect(rec.jobs.totalPairs).toBe(0);
  });

  it('クローン→人間で違う値に付け直した対は「食い違い」', async () => {
    const stores = createMemoryStores();
    await stores.journal.append(
      structuredEntry({
        prefix: JOB_APPRAISAL_DECISION_PREFIX,
        target: 'job',
        id: 'm1',
        value: 'good',
        by: 'clone',
      }),
    );
    await stores.journal.append(
      structuredEntry({
        prefix: JOB_APPRAISAL_DECISION_PREFIX,
        target: 'job',
        id: 'm1',
        value: 'bad',
        by: 'human',
        previous: 'good',
        previousBy: 'clone',
      }),
    );
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.jobs.totalPairs).toBe(1);
    expect(rec.jobs.matched).toBe(0);
    expect(rec.jobs.mismatched).toBe(1);
    expect(rec.jobs.transitions).toEqual([{ cloneValue: 'good', humanValue: 'bad', count: 1 }]);
    expect(rec.commitments.totalPairs).toBe(0);
  });

  it('人間による最初の評定（直前が無い）は対に数えない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append(
      structuredEntry({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        target: 'commitment',
        id: 'c1',
        value: 'good',
        by: 'human',
      }),
    );
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(0);
    expect(rec.commitments.undetermined).toBe(0);
  });

  it('クローン→クローン、人間→人間の付け直しは対に数えない（クローン→人間だけを数える）', async () => {
    const stores = createMemoryStores();
    const base = {
      prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      target: 'commitment' as const,
      id: 'c1',
    };
    await stores.journal.append(structuredEntry({ ...base, value: 'good', by: 'clone' }));
    await stores.journal.append(structuredEntry({ ...base, value: 'bad', by: 'clone' })); // clone→clone: 対に数えない
    await stores.journal.append(structuredEntry({ ...base, value: 'unclear', by: 'human' })); // clone(bad)→human(unclear): 数える
    await stores.journal.append(structuredEntry({ ...base, value: 'good', by: 'human' })); // human→human: 対に数えない
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(1);
    expect(rec.commitments.transitions).toEqual([
      { cloneValue: 'bad', humanValue: 'unclear', count: 1 },
    ]);
  });

  it('過去の行（構造欄が無い）でも grounds ・ decision 文面から対を復元できる', async () => {
    const stores = createMemoryStores();
    // 構造欄を持たない、#1310 より前の形の行をそのまま再現する。
    await stores.journal.append({
      type: 'decision',
      decision: formatAppraisalDecision({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        id: 'c1',
        value: 'good',
        reason: undefined,
        previous: null,
      }),
      grounds: COMMITMENT_APPRAISAL_CLONE_GROUNDS,
    });
    await stores.journal.append({
      type: 'decision',
      decision: formatAppraisalDecision({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        id: 'c1',
        value: 'bad',
        reason: undefined,
        previous: '評定: うまくいった（good・clone）',
      }),
      grounds: COMMITMENT_APPRAISAL_HUMAN_GROUNDS,
    });
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(1);
    expect(rec.commitments.mismatched).toBe(1);
    expect(rec.commitments.transitions).toEqual([
      { cloneValue: 'good', humanValue: 'bad', count: 1 },
    ]);
  });

  it('id が復元できない壊れた行は undetermined へ計上し、対には数えない（0に倒さない）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: `${COMMITMENT_APPRAISAL_DECISION_PREFIX}壊れている`,
      grounds: COMMITMENT_APPRAISAL_CLONE_GROUNDS,
    });
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.undetermined).toBe(1);
    expect(rec.commitments.totalPairs).toBe(0);
  });

  it('grounds が未知の文面だと「誰が付けたか」が復元できず undetermined へ計上する', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'decision',
      decision: formatAppraisalDecision({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        id: 'c1',
        value: 'good',
        reason: undefined,
        previous: null,
      }),
      grounds: '見たことが無い文面',
    });
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.undetermined).toBe(1);
    expect(rec.commitments.totalPairs).toBe(0);
  });

  it('台帳と委譲は混ぜない（同じ id 文字列でも軸ごとに独立に数える）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append(
      structuredEntry({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        target: 'commitment',
        id: 'shared-id',
        value: 'good',
        by: 'clone',
      }),
    );
    await stores.journal.append(
      structuredEntry({
        prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
        target: 'commitment',
        id: 'shared-id',
        value: 'bad',
        by: 'human',
      }),
    );
    await stores.journal.append(
      structuredEntry({
        prefix: JOB_APPRAISAL_DECISION_PREFIX,
        target: 'job',
        id: 'shared-id',
        value: 'good',
        by: 'clone',
      }),
    );
    await stores.journal.append(
      structuredEntry({
        prefix: JOB_APPRAISAL_DECISION_PREFIX,
        target: 'job',
        id: 'shared-id',
        value: 'good',
        by: 'human',
      }),
    );
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(1);
    expect(rec.commitments.mismatched).toBe(1);
    expect(rec.jobs.totalPairs).toBe(1);
    expect(rec.jobs.matched).toBe(1);
  });

  it('同じ組の遷移は件数へ集約し、件数の多い順に並ぶ', async () => {
    const stores = createMemoryStores();
    const pair = async (
      id: string,
      cloneValue: 'good' | 'bad' | 'unclear',
      humanValue: 'good' | 'bad' | 'unclear',
    ) => {
      await stores.journal.append(
        structuredEntry({
          prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
          target: 'commitment',
          id,
          value: cloneValue,
          by: 'clone',
        }),
      );
      await stores.journal.append(
        structuredEntry({
          prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
          target: 'commitment',
          id,
          value: humanValue,
          by: 'human',
        }),
      );
    };
    await pair('c1', 'good', 'bad');
    await pair('c2', 'good', 'bad');
    await pair('c3', 'good', 'unclear');
    const rec = await computeAppraisalReconciliation(stores.journal, prefixes);
    expect(rec.commitments.totalPairs).toBe(3);
    expect(rec.commitments.transitions).toEqual([
      { cloneValue: 'good', humanValue: 'bad', count: 2 },
      { cloneValue: 'good', humanValue: 'unclear', count: 1 },
    ]);
  });

  /**
   * ページをまたいでも、同じ id の「直前の評定」を正しく参照できることを
   * 測る（#1342 の走査を崩さないこと）。`computeAppraisalJournalStats` の
   * 「1ページを超える母集団でも全件数える」歯と同じ手（1ページより大きい
   * 母集団を `createSyntheticJournalStore` で作る）を、時系列（`asc`）側に
   * 対して当てる。
   */
  it('ページ送りをまたいでも id の直前の評定を正しく引き継ぐ', async () => {
    const total = 700; // JOURNAL_SCAN_PAGE_SIZE(500) を超える母集団
    const synthetic = createSyntheticJournalStore({
      total,
      entryAt: (index) => {
        // index は「0が最新・total-1が最古」。asc 走査は total-1 から読む。
        if (index === total - 1) {
          // 最も古い行——クローンが最初に good を付けた。
          return structuredEntry({
            prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
            target: 'commitment',
            id: 'p1',
            value: 'good',
            by: 'clone',
          });
        }
        if (index === 0) {
          // 最も新しい行——人間が bad へ覆した。ページをまたいだ先の
          // 「直前の評定」（上のクローンの行）を引き継げるかを測る。
          return structuredEntry({
            prefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
            target: 'commitment',
            id: 'p1',
            value: 'bad',
            by: 'human',
            previous: 'good',
            previousBy: 'clone',
          });
        }
        // 埋め草——どちらの印にも当たらない decision 行。
        return { type: 'decision', decision: `無関係な行 ${index}`, grounds: '' };
      },
    });

    const rec = await computeAppraisalReconciliation(synthetic.store, prefixes);
    expect(rec.commitments.totalPairs).toBe(1);
    expect(rec.commitments.mismatched).toBe(1);
    expect(rec.commitments.transitions).toEqual([
      { cloneValue: 'good', humanValue: 'bad', count: 1 },
    ]);

    // ページ送りが実際に複数回起きたこと、かつ時系列（asc）で読んだことを確認する
    // ——これが無いと、上の一致は「たまたま1ページに収まった」でも成立してしまう。
    expect(synthetic.calls.length).toBeGreaterThan(1);
    for (const call of synthetic.calls) {
      expect(call.order).toBe('asc');
    }
  });
});

describe('isTerminalJobStatus — running/waiting_human だけが非終端', () => {
  const cases: Array<[JobStatus, boolean]> = [
    ['running', false],
    ['waiting_human', false],
    ['done', true],
    ['failed', true],
    ['lost', true],
    ['stopped', true],
  ];
  it.each(cases)('%s は終端=%s', (status, expected) => {
    expect(isTerminalJobStatus(status)).toBe(expected);
  });
});

describe('computeJobAppraisalCoverage — 終端した委譲を状態ごとに割って評定の有無を数える', () => {
  it('未評定を4つ目の状態として保つ（0でも良い評定でもない）', () => {
    const jobs: Job[] = [
      job('a', { status: 'done', appraisal: 'good' }),
      job('b', { status: 'done' }), // 未評定
      job('c', { status: 'stopped' }), // 未評定（manager_stop で畳んだ想定）
      job('d', { status: 'failed', appraisal: 'bad' }),
      job('e', { status: 'lost' }), // 未評定
      job('f', { status: 'running' }), // 非終端——対象外
      job('g', { status: 'waiting_human' }), // 非終端——対象外
    ];
    const coverage = computeJobAppraisalCoverage(jobs);

    expect(coverage.terminalTotal).toBe(5);
    expect(coverage.terminalAppraised).toBe(2);
    expect(coverage.terminalUnappraised).toBe(3);
    expect(coverage.nonTerminalTotal).toBe(2);

    const byStatus = Object.fromEntries(coverage.byStatus.map((row) => [row.status, row]));
    expect(byStatus.done).toEqual({ status: 'done', total: 2, appraised: 1, unappraised: 1 });
    expect(byStatus.stopped).toEqual({ status: 'stopped', total: 1, appraised: 0, unappraised: 1 });
    expect(byStatus.failed).toEqual({ status: 'failed', total: 1, appraised: 1, unappraised: 0 });
    expect(byStatus.lost).toEqual({ status: 'lost', total: 1, appraised: 0, unappraised: 1 });
    // running/waiting_human は byStatus に現れない（対象外であって0件の水増しではない）。
    expect(Object.keys(byStatus).sort()).toEqual(['done', 'failed', 'lost', 'stopped']);
  });

  it('全ての終端状態が0件でも byStatus は4行とも出る（取れない軸に0の行を作るのとは逆——ここは実際に測れている0）', () => {
    const coverage = computeJobAppraisalCoverage([]);
    expect(coverage.byStatus).toHaveLength(4);
    expect(coverage.byStatus.every((row) => row.total === 0)).toBe(true);
    expect(coverage.terminalTotal).toBe(0);
    expect(coverage.nonTerminalTotal).toBe(0);
  });

  it('appraisal が空文字列でも「値が在る」として数える（undefined と "" は別——appraisalSchema の外の値でも欠落ではない）', () => {
    // `Job.appraisal` は `z.string().optional()` で緩く持っている
    // （schema.ts の doc）。この関数が見るのは `undefined` かどうかだけで、
    // 値の中身（既知の3値かどうか）は問わない——「評定を1度でも付けたか」を
    // 数えるのがこの関数の役割であって、内訳（good/bad/unclear/other）を
    // 数えるのは日誌側（`tallyAppraisalDecisions`）の役割である。
    const coverage = computeJobAppraisalCoverage([job('x', { status: 'done', appraisal: '' })]);
    const doneRow = coverage.byStatus.find((row) => row.status === 'done');
    expect(doneRow).toEqual({ status: 'done', total: 1, appraised: 1, unappraised: 0 });
  });
});

describe('describeAppraisalStats — MCP/HTTP が読む文面（2つの印を混ぜず、未評定を明示する）', () => {
  it('2つの印の内訳が別の節に出て、混ぜて比べるなという注記も出る', () => {
    const text = describeAppraisalStats({
      journal: {
        commitments: { good: 186, bad: 12, unclear: 65, other: 0, total: 263 },
        jobs: { good: 105, bad: 0, unclear: 9, other: 0, total: 114 },
        byWorkKind: { commitments: [], jobs: [] },
      },
      jobCoverage: computeJobAppraisalCoverage([
        job('a', { status: 'done', appraisal: 'good' }),
        job('b', { status: 'stopped' }),
      ]),
      reconciliation: emptyReconciliation(),
    });
    expect(text).toContain('引き受けた仕事');
    expect(text).toContain('委譲');
    expect(text).toContain('263');
    expect(text).toContain('114');
    expect(text).toContain('混ぜて比べないこと');
    expect(text).toContain('評定なし');
  });

  it('(b)/(c) の食い違いの節を出す——対が無ければそう明記し、判定できない件数も出す', () => {
    const text = describeAppraisalStats({
      journal: {
        commitments: { good: 1, bad: 0, unclear: 0, other: 0, total: 1 },
        jobs: { good: 0, bad: 0, unclear: 0, other: 0, total: 0 },
        byWorkKind: { commitments: [], jobs: [] },
      },
      jobCoverage: computeJobAppraisalCoverage([]),
      reconciliation: {
        commitments: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 3 },
        jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
      },
    });
    expect(text).toContain('(b) 人間 と (c) クローンの食い違い');
    expect(text).toContain('対は無い');
    // undetermined は0に倒さず、件数がそのまま出る。
    expect(text).toContain('判定できない');
    expect(text).toContain('3 件');
  });

  it('対が在れば値の遷移・一致/食い違いの件数が出る', () => {
    const text = describeAppraisalStats({
      journal: {
        commitments: { good: 0, bad: 0, unclear: 0, other: 0, total: 0 },
        jobs: { good: 0, bad: 0, unclear: 0, other: 0, total: 0 },
        byWorkKind: { commitments: [], jobs: [] },
      },
      jobCoverage: computeJobAppraisalCoverage([]),
      reconciliation: {
        commitments: {
          transitions: [{ cloneValue: 'good', humanValue: 'bad', count: 4 }],
          totalPairs: 4,
          matched: 0,
          mismatched: 4,
          undetermined: 0,
        },
        jobs: { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 },
      },
    });
    expect(text).toContain('4 件');
    expect(text).toContain('食い違い');
    expect(text).toContain('一致 0');
  });
});

describe('computeAppraisalJournalStats の byWorkKind — 仕事の種類ごとの評定行（#1308 段B）', () => {
  it('構造欄の種類で割り、群の和はその印の総数と一致し、未分類は最後に置く', async () => {
    const stores = createMemoryStores();
    const append = async (value: 'good' | 'bad' | 'unclear', workKind?: string) =>
      stores.journal.append({
        type: 'decision',
        decision: `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（c）: ${value}`,
        grounds: '',
        appraisal: {
          target: 'commitment',
          id: 'c',
          value,
          by: 'clone',
          ...(workKind === undefined ? {} : { workKind }),
        },
      });
    await append('bad', '実装');
    await append('good', '実装 ');
    await append('good', 'ＲＥＶＩＥＷ');
    await append('unclear');
    // 構造欄を持たない過去の行（#1310 より前）も未分類へ入る。
    await stores.journal.append({
      type: 'decision',
      decision: `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（old）: good`,
      grounds: '',
    });
    // 別の印の行は、この軸のどの群にも入らない。
    await stores.journal.append({
      type: 'decision',
      decision: `${JOB_APPRAISAL_DECISION_PREFIX}（m）: bad`,
      grounds: '',
      appraisal: { target: 'job', id: 'm', value: 'bad', by: 'clone', workKind: '実装' },
    });

    const stats = await computeAppraisalJournalStats(stores.journal, {
      commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
    });
    expect(stats.byWorkKind.commitments).toEqual([
      { workKind: '実装', good: 1, bad: 1, unclear: 0, other: 0, total: 2 },
      { workKind: 'ＲＥＶＩＥＷ', good: 1, bad: 0, unclear: 0, other: 0, total: 1 },
      { workKind: null, good: 1, bad: 0, unclear: 1, other: 0, total: 2 },
    ]);
    expect(stats.byWorkKind.jobs).toEqual([
      { workKind: '実装', good: 0, bad: 1, unclear: 0, other: 0, total: 1 },
    ]);
    // **割っただけで、足しても引いてもいない。**
    const sum = stats.byWorkKind.commitments.reduce((acc, tally) => acc + tally.total, 0);
    expect(sum).toBe(stats.commitments.total);
  });

  it('ページを跨いでも群ごとに足し込まれる（1ページより大きい母集団）', async () => {
    const stores = createMemoryStores();
    const total = JOURNAL_SCAN_PAGE_SIZE + 37;
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `${JOB_APPRAISAL_DECISION_PREFIX}（m${i}）: good`,
        grounds: '',
        appraisal: {
          target: 'job',
          id: `m${i}`,
          value: 'good',
          by: 'clone',
          workKind: i % 2 === 0 ? '実装' : '調査',
        },
      });
    }
    const stats = await computeAppraisalJournalStats(stores.journal, {
      commitmentPrefix: COMMITMENT_APPRAISAL_DECISION_PREFIX,
      jobPrefix: JOB_APPRAISAL_DECISION_PREFIX,
    });
    expect(stats.jobs.total).toBe(total);
    expect(stats.byWorkKind.jobs.map((tally) => [tally.workKind, tally.total])).toEqual([
      ['実装', Math.ceil(total / 2)],
      ['調査', Math.floor(total / 2)],
    ]);
  });

  it('describeAppraisalStats は種類ごとの節を出し、未分類を種類として読むなと注記する', () => {
    const text = describeAppraisalStats({
      journal: {
        commitments: { good: 1, bad: 1, unclear: 0, other: 0, total: 2 },
        jobs: { good: 0, bad: 0, unclear: 0, other: 0, total: 0 },
        byWorkKind: {
          commitments: [
            { workKind: '実装', good: 1, bad: 0, unclear: 0, other: 0, total: 1 },
            { workKind: null, good: 0, bad: 1, unclear: 0, other: 0, total: 1 },
          ],
          jobs: [],
        },
      },
      jobCoverage: computeJobAppraisalCoverage([]),
      reconciliation: emptyReconciliation(),
    });
    expect(text).toContain('## 仕事の種類ごとの評定行');
    expect(text).toContain('- 実装: 評定行 1 件');
    expect(text).toContain('- 未分類: 評定行 1 件');
    expect(text).toContain('（評定行が無い）');
    expect(text).toContain('未分類は種類の1つではない');
  });
});
