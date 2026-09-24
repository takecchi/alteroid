import { describe, expect, it } from 'vitest';

import type { AppraisalReconciliationStats } from './appraisal-stats.js';
import {
  describePracticeCandidates,
  PRACTICE_CANDIDATE_EVIDENCE_BUDGET,
  PRACTICE_CANDIDATES_BUDGET,
  practiceCandidateKindKeys,
  type PracticeCandidateMaterial,
  type PracticeCandidateReconciliation,
} from './practice-candidates.js';
import type { Commitment, Job } from './schema.js';
import type { CommitmentList } from './store.js';

const T1 = '2026-08-01T00:00:00.000Z';

/** 台帳の1件（`appraisal.test.ts` の同名ヘルパと同じ形）。 */
function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return { id, at: T1, origin: 'human', body: '依頼の本文', ...overrides };
}

function commitmentList(
  entries: readonly Commitment[],
  overrides: Partial<Omit<CommitmentList, 'entries'>> = {},
): CommitmentList {
  return { entries: [...entries], unreadable: [], trimmedClosed: 0, ...overrides };
}

/** 委譲の1本（`appraisal.test.ts` の同名ヘルパと同じ形）。 */
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

function practice(
  slug: string,
  overrides: Partial<PracticeCandidateMaterial> = {},
): PracticeCandidateMaterial {
  return {
    slug,
    kind: '調査',
    title: `${slug} の題`,
    updatedAt: T1,
    content: `${slug} の本文`,
    versions: 1,
    ...overrides,
  };
}

const EMPTY_AXIS = { transitions: [], totalPairs: 0, matched: 0, mismatched: 0, undetermined: 0 };
const NO_PAIRS: PracticeCandidateReconciliation = {
  measured: true,
  stats: { commitments: EMPTY_AXIS, jobs: EMPTY_AXIS },
};

/** `## 委譲` の見出しで2つの軸に割る。群が軸を跨いでいないかを見るため。 */
function splitAxes(reply: string): { commitments: string; jobs: string } {
  const jobsAt = reply.indexOf('## 委譲');
  const calibrationAt = reply.indexOf('## 評定する側の較正の材料');
  return {
    commitments: reply.slice(reply.indexOf('## 引き受けた仕事'), jobsAt),
    jobs: reply.slice(jobsAt, calibrationAt),
  };
}

describe('describePracticeCandidates — 種類ごとの候補を材料として並べる（#1055 段4）', () => {
  it('空: 傾いた群が無ければ専用の断り書きを返し、「変えなくてよい」とは読ませない', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-good', { appraisal: 'good', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [practice('p-research')],
      reconciliation: NO_PAIRS,
    });

    expect(reply).toContain('候補の的:');
    expect(reply).toContain('これは「やり方を変えなくてよい」ではない');
    // good しか無い群は候補に出ない（本文もやり方も並べない）。
    expect(reply).not.toContain('### 種類');
    expect(reply).not.toContain('p-research');
    // 空でも較正の材料は出る。
    expect(reply).toContain('## 評定する側の較正の材料');
  });

  it('台帳と委譲は同じ種類名でも別の群に出る（1つの群に混ぜない）', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', {
          body: '台帳側の本文',
          appraisal: 'bad',
          appraisedAt: T1,
          workKind: '調査',
        }),
      ]),
      jobs: [
        job('j-bad', {
          summary: '委譲側の要旨',
          appraisal: 'bad',
          appraisedAt: T1,
          workKind: '調査',
        }),
      ],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments, jobs } = splitAxes(reply);
    expect(commitments).toContain('台帳側の本文');
    expect(commitments).not.toContain('委譲側の要旨');
    expect(jobs).toContain('委譲側の要旨');
    expect(jobs).not.toContain('台帳側の本文');
    // どちらの群も1件ずつ（足し合わせて2件の群になっていない）。
    expect(commitments).toContain('評定済み 1 件（うまくいかなかった 1 /');
    expect(jobs).toContain('評定済み 1 件（うまくいかなかった 1 /');
  });

  it('未評定はどの群にも数えず、件数だけを別に出す（good にも bad にも寄せない）', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
        commitment('c-none-1', { body: '未評定その1', workKind: '調査' }),
        commitment('c-none-2', { body: '未評定その2' }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments } = splitAxes(reply);
    expect(commitments).toContain('評定済み 1 件・未評定 2 件');
    // 群の内訳に未評定が入っていない（入れば 2 件になる）。
    expect(commitments).toContain(
      '### 種類「調査」 評定済み 1 件（うまくいかなかった 1 / 判定できない 0 / うまくいった 0 / 上の3値以外 0）',
    );
    expect(reply).not.toContain('未評定その1');
    expect(reply).not.toContain('未評定その2');
  });

  it('種類ごとに束ね、証拠は うまくいかなかった → 判定できない の順で、good の本文は出さない', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-unclear', {
          body: '判定できない本文',
          appraisal: 'unclear',
          appraisedAt: '2026-08-03T00:00:00.000Z',
          workKind: '返信',
        }),
        commitment('c-bad', {
          body: 'うまくいかなかった本文',
          appraisal: 'bad',
          appraisedAt: '2026-08-02T00:00:00.000Z',
          appraisalReason: '期限に遅れた',
          workKind: '返信',
        }),
        commitment('c-good', {
          body: 'うまくいった本文',
          appraisal: 'good',
          appraisedAt: T1,
          workKind: '返信',
        }),
        commitment('c-other-kind', {
          body: '別の種類の本文',
          appraisal: 'bad',
          appraisedAt: T1,
          workKind: '日報',
        }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments } = splitAxes(reply);
    expect(commitments).toContain('### 種類「返信」 評定済み 3 件');
    expect(commitments).toContain('### 種類「日報」 評定済み 1 件');
    // 証拠の順: bad が unclear より先（新しい unclear があっても bad を先に出す）。
    expect(commitments.indexOf('うまくいかなかった本文')).toBeLessThan(
      commitments.indexOf('判定できない本文'),
    );
    expect(commitments).toContain('（理由: 期限に遅れた）');
    // good は数だけで、本文は出さない。
    expect(reply).not.toContain('うまくいった本文');
  });

  it('未分類は群にしない。件数は軸の1行目に必ず出す', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-unclassified', {
          body: '種類の無い本文',
          appraisal: 'bad',
          appraisedAt: T1,
        }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments } = splitAxes(reply);
    expect(commitments).toContain(
      '未分類（種類を述べていない評定）は 1 件（うまくいかなかった 1 /',
    );
    expect(commitments).not.toContain('### 種類');
    // 群が無いので空の枝を通る。
    expect(reply).toContain('候補の的:');
  });

  it('やり方: 同じ種類（表記ゆれを寄せる）のものだけを並べ、無ければ無いと書く', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-review', {
          appraisal: 'bad',
          appraisedAt: T1,
          workKind: 'Review',
        }),
        commitment('c-research', { appraisal: 'unclear', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [
        practice('p-review', {
          kind: ' ＲＥＶＩＥＷ ',
          title: 'レビューの手順',
          content: 'レビューの本文',
          versions: 3,
        }),
        practice('p-unrelated', { kind: '日報', content: '関係ない本文' }),
      ],
      reconciliation: NO_PAIRS,
    });

    const reviewBlock = reply.slice(
      reply.indexOf('### 種類「Review」'),
      reply.indexOf('### 種類「調査」'),
    );
    expect(reviewBlock).toContain('やり方 p-review「レビューの手順」（版 3 件・更新');
    expect(reviewBlock).toContain('レビューの本文');
    const researchBlock = reply.slice(reply.indexOf('### 種類「調査」'));
    expect(researchBlock).toContain('この種類のやり方は器に無い');
    // 候補の的に当たらない種類のやり方は出さない。
    expect(reply).not.toContain('p-unrelated');
  });

  it('やり方の本文は全文を載せない（抜粋にする）', () => {
    const long = 'あ'.repeat(5_000);
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [practice('p-long', { content: long })],
      reconciliation: NO_PAIRS,
    });
    expect(reply).not.toContain(long);
    expect(reply).toContain('p-long');
  });

  it('版の数が読めなかったやり方は 0 と書かず「読めなかった」と書く', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [practice('p-x', { versions: undefined })],
      reconciliation: NO_PAIRS,
    });
    expect(reply).toContain('版の数は読めなかった');
    expect(reply).not.toContain('版 0 件');
  });

  it('予算: 種類が多いと文字数で切り、省略した種類の数と続きの取り方を出す', () => {
    const entries = Array.from({ length: 200 }, (_, i) =>
      commitment(`c-${i}`, {
        body: `本文${i} ${'x'.repeat(80)}`,
        appraisal: 'bad',
        appraisedAt: T1,
        workKind: `種類${String(i).padStart(3, '0')}`,
      }),
    );
    const reply = describePracticeCandidates({
      commitments: commitmentList(entries),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments } = splitAxes(reply);
    expect(commitments).toMatch(/…ほか \d+ 種類は省略（全 200 種類のうち \d+ 種類だけ出した。/);
    expect(commitments).toContain('commitment_list と practice_list で確認できる');
    // 軸全体が予算＋固定の見出し程度に収まっている（件数に比例して伸びていない）。
    expect(commitments.length).toBeLessThan(PRACTICE_CANDIDATES_BUDGET + 1_000);
  });

  it('予算: 1つの種類に証拠が積もっても群の中で切り、他の種類が押し出されない', () => {
    const heavy = Array.from({ length: 100 }, (_, i) =>
      commitment(`heavy-${i}`, {
        body: `重い本文${i} ${'y'.repeat(80)}`,
        appraisal: 'bad',
        appraisedAt: T1,
        workKind: '実装',
      }),
    );
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        ...heavy,
        commitment('light', {
          body: '軽い本文',
          appraisal: 'bad',
          appraisedAt: T1,
          workKind: '調査',
        }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });

    const { commitments } = splitAxes(reply);
    expect(commitments).toMatch(/…ほか \d+ 件は省略（全 100 件のうち \d+ 件だけ出した。/);
    // 重い群の後ろの種類も見える。
    expect(commitments).toContain('### 種類「調査」');
    expect(commitments).toContain('軽い本文');
    const heavyBlock = commitments.slice(
      commitments.indexOf('### 種類「実装」'),
      commitments.indexOf('### 種類「調査」'),
    );
    expect(heavyBlock.length).toBeLessThan(PRACTICE_CANDIDATE_EVIDENCE_BUDGET + 600);
  });

  it('(b)/(c) の食い違いを軸ごとに出す（種類ごとではないと名乗る）', () => {
    const stats: AppraisalReconciliationStats = {
      commitments: {
        transitions: [
          { cloneValue: 'good', humanValue: 'bad', count: 3 },
          { cloneValue: 'bad', humanValue: 'bad', count: 1 },
        ],
        totalPairs: 4,
        matched: 1,
        mismatched: 3,
        undetermined: 2,
      },
      jobs: EMPTY_AXIS,
    };
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: { measured: true, stats },
    });

    const calibration = reply.slice(reply.indexOf('## 評定する側の較正の材料'));
    expect(calibration).toContain('種類ごとには割っていない');
    const commitmentPart = calibration.slice(0, calibration.indexOf('### 委譲'));
    expect(commitmentPart).toContain(
      'クローン「うまくいった」→人間「うまくいかなかった」: 3 件（食い違い）',
    );
    expect(commitmentPart).toContain('合計: 4 対（一致 1 / 食い違い 3）。');
    expect(commitmentPart).toContain('評定行: 2 件');
    const jobPart = calibration.slice(calibration.indexOf('### 委譲'));
    expect(jobPart).toContain('（クローンが付けた評定を人間が付け直した対は無い）');
  });

  it('食い違いが測れなかったときは「無い」と書かず、測れなかったと書く', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [],
      practices: [],
      reconciliation: { measured: false, reason: 'journal down' },
    });
    expect(reply).toContain('測れなかった（理由: journal down）');
    expect(reply).not.toContain('人間が付け直した対は無い');
  });

  it('台帳の分母の欠落（trimmedClosed / unreadable）を台帳の軸に出す', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList(
        [commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' })],
        { trimmedClosed: 7, unreadable: [{ id: 'broken', reason: 'bad json' }] },
      ),
      jobs: [],
      practices: [],
      reconciliation: NO_PAIRS,
    });
    const { commitments } = splitAxes(reply);
    expect(commitments).toContain('古い片付き行が 7 件消えている');
    expect(commitments).toContain('読めなかった行が 1 件在る');
  });

  it('⛔ 採否を決める言い回しを出さない（材料であって指示ではない）', () => {
    const reply = describePracticeCandidates({
      commitments: commitmentList([
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1, workKind: '調査' }),
      ]),
      jobs: [job('j-unclear', { appraisal: 'unclear', appraisedAt: T1, workKind: '調査' })],
      practices: [practice('p-research')],
      reconciliation: NO_PAIRS,
    });
    expect(reply).toContain('**材料**');
    expect(reply).toContain('優先度の判定ではない');
    expect(reply).not.toMatch(/付けるべき|書き換えよ|採用せよ|practice_write/);
  });
});

describe('practiceCandidateKindKeys — 読むやり方を絞るための鍵', () => {
  it('bad / unclear が付いた種類だけを、寄せた鍵で返す（good だけ・未分類・未評定は入らない）', () => {
    const keys = practiceCandidateKindKeys({
      commitments: commitmentList([
        commitment('a', { appraisal: 'bad', appraisedAt: T1, workKind: ' Review ' }),
        commitment('b', { appraisal: 'good', appraisedAt: T1, workKind: '日報' }),
        commitment('c', { appraisal: 'bad', appraisedAt: T1 }),
        commitment('d', { workKind: '実装' }),
      ]),
      jobs: [job('j', { appraisal: 'unclear', appraisedAt: T1, workKind: '調査' })],
    });
    expect([...keys].sort()).toEqual(['review', '調査']);
  });
});
