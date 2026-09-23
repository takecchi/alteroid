import { describe, expect, it } from 'vitest';

import {
  computeAppraisalJournalStats,
  computeJobAppraisalCoverage,
  describeAppraisalStats,
  isTerminalJobStatus,
  tallyAppraisalDecisions,
} from './appraisal-stats.js';
import {
  COMMITMENT_APPRAISAL_DECISION_PREFIX,
  formatAppraisalDecision,
  JOB_APPRAISAL_DECISION_PREFIX,
  parseAppraisalDecisionValue,
  type Job,
  type JobStatus,
  type JournalEntry,
} from './schema.js';
import { createMemoryStores } from './testing.js';

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
    // 側が切れた。この歯は「この関数が limit を渡していないこと」を、
    // 200件超のデータで実際に確かめる——境界値のすぐ外側（201件）ではなく、
    // 実測に近い263件で作る。
    const entries: JournalEntry[] = Array.from({ length: 263 }, (_, i) =>
      decisionEntry(`c${i}`, `${COMMITMENT_APPRAISAL_DECISION_PREFIX}（id-${i}）: good`),
    );
    const tally = tallyAppraisalDecisions(entries, COMMITMENT_APPRAISAL_DECISION_PREFIX);
    expect(tally.total).toBe(263);
    expect(tally.good).toBe(263);
  });
});

describe('computeAppraisalJournalStats — ストアから2つの印を1回の読みで数える（I/O あり）', () => {
  it('総数200件超でもストア経由で全件返る（limit を渡していないことの結合確認）', async () => {
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
    expect(stats.commitments.total).toBe(210);
    expect(stats.commitments.good).toBe(210);
    expect(stats.jobs.total).toBe(5);
    expect(stats.jobs.bad).toBe(5);
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
      },
      jobCoverage: computeJobAppraisalCoverage([
        job('a', { status: 'done', appraisal: 'good' }),
        job('b', { status: 'stopped' }),
      ]),
    });
    expect(text).toContain('引き受けた仕事');
    expect(text).toContain('委譲');
    expect(text).toContain('263');
    expect(text).toContain('114');
    expect(text).toContain('混ぜて比べないこと');
    expect(text).toContain('評定なし');
  });
});
