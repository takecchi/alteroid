import { describe, expect, it } from 'vitest';

import {
  APPRAISAL_TARGETS_BUDGET,
  APPRAISAL_TARGETS_LINE_LIMIT,
  describeAppraisalTargets,
} from './appraisal.js';
import type { Commitment, Job } from './schema.js';
import type { CommitmentList } from './store.js';

const T1 = '2026-08-01T00:00:00.000Z';

/** 台帳の1件を組み立てる（`clone.test.ts` の `commitment` ヘルパと同じ形）。 */
function commitment(id: string, overrides: Partial<Commitment> = {}): Commitment {
  return {
    id,
    at: T1,
    origin: 'human',
    body: '依頼の本文',
    ...overrides,
  };
}

/** `CommitmentStore.list` の戻り値を組み立てる。既定は保持上限に触れていない状態。 */
function commitmentList(
  entries: readonly Commitment[],
  overrides: Partial<Omit<CommitmentList, 'entries'>> = {},
): CommitmentList {
  return { entries: [...entries], unreadable: [], trimmedClosed: 0, ...overrides };
}

/** 委譲の1本を組み立てる（`manager.test.ts` の `job` ヘルパと同じ形）。 */
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

describe('describeAppraisalTargets — 評定を台帳・委譲の2節に束ねて名指しする（#1055 段2）', () => {
  it('台帳と委譲は別の節に出る（同じ id の素が混ざらない）', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('shared-id', { body: '台帳側の本文', appraisal: 'good', appraisedAt: T1 }),
      ]),
      jobs: [job('shared-id', { summary: '委譲側の要旨', appraisal: 'bad', appraisedAt: T1 })],
    });

    expect(reply).toContain('## 引き受けた仕事（台帳）');
    expect(reply).toContain('## 委譲（マネージャーへ出した仕事）');

    const commitmentSection = reply.slice(0, reply.indexOf('## 委譲'));
    const jobSection = reply.slice(reply.indexOf('## 委譲'));

    expect(commitmentSection).toContain('台帳側の本文');
    expect(commitmentSection).not.toContain('委譲側の要旨');
    expect(jobSection).toContain('委譲側の要旨');
    expect(jobSection).not.toContain('台帳側の本文');
  });

  it('⭐ 未評定は一覧に1件も出ず、件数だけが別に出る', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('c-good', { appraisal: 'good', appraisedAt: T1 }),
        commitment('c-none', { body: '未評定の件' }),
      ]),
      jobs: [],
    });

    // 未評定の行そのもの（id）は一覧に出ない。
    expect(reply).not.toContain('c-none');
    // 件数としては別に出る。
    expect(reply).toContain('未評定 1 件');
    expect(reply).toContain('評定済み 1 件');
  });

  it('並びが bad → unclear → 3値以外 → good、同じ群の中は appraisedAt の新しい順', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('good-old', { appraisal: 'good', appraisedAt: '2026-08-01T00:00:00.000Z' }),
        commitment('bad-new', { appraisal: 'bad', appraisedAt: '2026-08-03T00:00:00.000Z' }),
        commitment('other', { appraisal: 'weird', appraisedAt: '2026-08-02T00:00:00.000Z' }),
        commitment('unclear-1', { appraisal: 'unclear', appraisedAt: '2026-08-01T12:00:00.000Z' }),
        commitment('bad-old', { appraisal: 'bad', appraisedAt: '2026-08-01T00:00:00.000Z' }),
        commitment('good-new', { appraisal: 'good', appraisedAt: '2026-08-04T00:00:00.000Z' }),
      ]),
      jobs: [],
    });

    const section = reply.slice(0, reply.indexOf('## 委譲'));
    const order = ['bad-new', 'bad-old', 'unclear-1', 'other', 'good-new', 'good-old'];
    const positions = order.map((id) => section.indexOf(id));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('⭐ 本文の全文を載せない', () => {
    const longBody = 'あ'.repeat(APPRAISAL_TARGETS_LINE_LIMIT + 500);
    const reply = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('c-long', { body: longBody, appraisal: 'good', appraisedAt: T1 }),
      ]),
      jobs: [],
    });

    expect(reply).not.toContain(longBody);
    // excerpt.ts の印。
    expect(reply).toMatch(/文字省略/);
  });

  it('⭐ 予算は文字数で締まる（大量件数を入れても、切ったら省略の合図が出る）', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      commitment(`c-${String(i).padStart(3, '0')}`, {
        body: `本文の内容その${i}`.repeat(5),
        appraisal: 'bad',
        appraisedAt: T1,
      }),
    );
    const reply = describeAppraisalTargets({ commitments: commitmentList(many), jobs: [] });

    expect(reply).toContain('件は省略');
    // 節は2つ在るので全体はこの2倍＋見出しに収まる（`memory.test.ts` の
    // 同種のテストと同じ向き）。
    expect(reply.length).toBeLessThan(APPRAISAL_TARGETS_BUDGET * 2 + 2_000);
  });

  it('3値以外の評定値を落とさない（生の値がラベルとして出る／件数に数えられる）', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('c-mystery', { appraisal: 'mystery-value', appraisedAt: T1 }),
      ]),
      jobs: [],
    });

    expect(reply).toContain('[mystery-value]');
    expect(reply).toContain('上の3値以外 1 件');
  });

  it('評定が1件も無い → 専用の断り書きが出て、「良い仕事が無い」と読めない断りが付く', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-1')]),
      jobs: [job('j-1')],
    });

    expect(reply).toContain('評定の的');
    expect(reply).toContain('「良い仕事が無い」ではない');
    expect(reply).toContain('commitment_appraise');
    expect(reply).toContain('manager_appraise');
    // 断りだけで終わる（節は出ない）。
    expect(reply).not.toContain('## 引き受けた仕事（台帳）');
    expect(reply).not.toContain('## 委譲');
    // 欠落が無いときは疑いの行を出さない——毎回出すと、本当に欠落が在るときの
    // 目印が効かなくなる。
    expect(reply).not.toContain('この0を「まだ付けていない」と読まないこと');
  });

  /**
   * ⛔ この枝は Issue #1055 の冒頭の門がそのまま読む値である（「0件なら段2 の
   * 入力は永久に空なので段2 を書くな」と分岐する）。**0 の原因を断言して外すと、
   * この Issue でいちばん高くつく誤読になる。**
   *
   * `storage-fs` は保持上限を超えた古い片付き行を物理削除するので、**付けた評定が
   * 行ごと消えていても「1件も無い」に見える。** 消えた分母の申告が0件の枝から
   * 落ちていると、その区別が読み手から永久に失われる。
   */
  it('⭐ 評定が0件でも、消えた分母の申告が在れば出て、0 の原因の断言が弱まる', () => {
    const trimmed = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-1')], { trimmedClosed: 7 }),
      jobs: [],
    });
    expect(trimmed).toContain('古い片付き行が 7 件消えている');
    expect(trimmed).toContain('この0を「まだ付けていない」と読まないこと');
    // 0件の枝であることは変わらない（節は出ない）。
    expect(trimmed).not.toContain('## 引き受けた仕事（台帳）');

    const unreadable = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-1')], { unreadable: [{ reason: '壊れていた' }] }),
      jobs: [],
    });
    expect(unreadable).toContain('読めなかった行が 1 件在る');
    expect(unreadable).toContain('この0を「まだ付けていない」と読まないこと');
  });

  it('⭐ bad が0件のとき⚠の1行が出る／1件以上あるとき出ない／評定済みが0件の節では出ない', () => {
    const zeroBad = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-good', { appraisal: 'good', appraisedAt: T1 })]),
      jobs: [],
    });
    expect(zeroBad).toContain('「うまくいかなかった」が0件である');
    // 委譲の節は評定済みが0件 ⟹ そちらには出ない。
    const jobSection = zeroBad.slice(zeroBad.indexOf('## 委譲'));
    expect(jobSection).not.toContain('「うまくいかなかった」が0件である');

    const withBad = describeAppraisalTargets({
      commitments: commitmentList([
        commitment('c-good', { appraisal: 'good', appraisedAt: T1 }),
        commitment('c-bad', { appraisal: 'bad', appraisedAt: T1 }),
      ]),
      jobs: [],
    });
    expect(withBad).not.toContain('「うまくいかなかった」が0件である');
  });

  it('台帳の trimmedClosed / unreadable が非ゼロのときだけ断り書きが出る', () => {
    const withTrim = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-good', { appraisal: 'good', appraisedAt: T1 })], {
        trimmedClosed: 3,
      }),
      jobs: [],
    });
    expect(withTrim).toContain('古い片付き行が 3 件消えている');
    expect(withTrim).toContain('全期間の実数ではない');

    const withUnreadable = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-good', { appraisal: 'good', appraisedAt: T1 })], {
        unreadable: [{ reason: '壊れていた' }],
      }),
      jobs: [],
    });
    expect(withUnreadable).toContain('読めなかった行が 1 件在る');

    const clean = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-good', { appraisal: 'good', appraisedAt: T1 })]),
      jobs: [],
    });
    expect(clean).not.toContain('古い片付き行が');
    expect(clean).not.toContain('読めなかった行が');
  });

  it('委譲の節には常に「走行中の委譲の評定はまだ反映されていない」旨の注記が出る', () => {
    const reply = describeAppraisalTargets({
      commitments: commitmentList([commitment('c-good', { appraisal: 'good', appraisedAt: T1 })]),
      jobs: [],
    });
    const jobSection = reply.slice(reply.indexOf('## 委譲'));
    expect(jobSection).toContain('走行中の委譲の評定は');
  });
});
