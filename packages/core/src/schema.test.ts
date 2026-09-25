import { describe, expect, it } from 'vitest';

import {
  answeredViaSchema,
  approvalUpdatedAt,
  COMMITMENT_APPRAISAL_CLONE_GROUNDS,
  COMMITMENT_APPRAISAL_HUMAN_GROUNDS,
  commitmentActiveDelegationIds,
  commitmentRespondedAt,
  commitmentUpdatedAt,
  describeAnsweredVia,
  inboxEventSchema,
  JOB_APPRAISAL_CLONE_GROUNDS,
  JOB_APPRAISAL_HUMAN_GROUNDS,
  journalEntrySchema,
  pendingApprovalSchema,
} from './schema.js';

/**
 * `manager_message` の `statusAtDelivery`（issue #870）。
 *
 * **正本は構造化欄、散文（`text`）は表示のためだけ**——`#124`（`d2ff50c`）が
 * 固定した「判定は構造化された印で行い、文言は表示にだけ使う」の踏襲
 * （`schema.ts` の `statusAtDelivery` の doc）。ここで確かめるのは2つ:
 *
 * 1. **構造化欄から `JobStatus` の値そのものが読める。** フィクスチャが
 *    与えた値（例: `'waiting_human'`）がそのまま出る——定型の飾り文を
 *    `toContain` して済ませない（それは「文言が一致した」であって
 *    「構造化欄から読めた」ではない）。
 * 2. **散文の書式が変わっても、この読み取りは壊れない。** `text` が
 *    まったく違う書式の2つの `manager_message` を用意し、`statusAtDelivery`
 *    への読み取り（`.statusAtDelivery` を直接見る）が両方で同じように
 *    成立することを見る——`text` を1文字も参照せずに済んでいることが、
 *    このアサーションの形そのもので示される。
 */
function managerMessageEvent(overrides: {
  text: string;
  statusAtDelivery?: 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';
}) {
  return {
    type: 'manager_message' as const,
    id: 'evt-1',
    at: '2026-09-01T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report' as const,
    ...overrides,
  };
}

describe('inboxEventSchema: manager_message.statusAtDelivery', () => {
  it('フィクスチャが与えた JobStatus の値そのものが構造化欄に現れる', () => {
    const parsed = inboxEventSchema.parse(
      managerMessageEvent({ text: '本文はなんでもよい', statusAtDelivery: 'waiting_human' }),
    );
    if (parsed.type !== 'manager_message') throw new Error('unreachable');
    expect(parsed.statusAtDelivery).toBe('waiting_human');
  });

  it('省略時はキー自体が付かない（既定値を作らない）', () => {
    const parsed = inboxEventSchema.parse(managerMessageEvent({ text: '本文はなんでもよい' }));
    if (parsed.type !== 'manager_message') throw new Error('unreachable');
    expect(parsed.statusAtDelivery).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, 'statusAtDelivery')).toBe(false);
  });

  it('未知の値は拒否する（jobStatusSchema と同じ6値に閉じている）', () => {
    const result = inboxEventSchema.safeParse(
      managerMessageEvent({
        text: '本文はなんでもよい',
        // @ts-expect-error -- 意図的に未知の値を渡す
        statusAtDelivery: 'not_a_real_status',
      }),
    );
    expect(result.success).toBe(false);
  });

  it('散文（text）の書式が変わっても、statusAtDelivery の読み取りは同じ形で成立する', () => {
    // 2つの `text` はまったく別の書式——1つは実在する散文（`manager.ts` の
    // `case 'closed'` が組み立てる「この委譲は終わった（status=...)」の形）、
    // もう1つはその書式を変えた（将来の書き換えを想定した）まったく別の文。
    // どちらも `statusAtDelivery` は同じ値を持つ。
    const before = inboxEventSchema.parse(
      managerMessageEvent({
        text: '[mgr-1] この委譲は終わった（status=lost）。背景処理の完了待ちで畳んでいた報告をまとめて配る。',
        statusAtDelivery: 'lost',
      }),
    );
    const after = inboxEventSchema.parse(
      managerMessageEvent({
        text: '[mgr-1] 委譲が終了しました。積み残しの報告をまとめて送ります。',
        statusAtDelivery: 'lost',
      }),
    );
    if (before.type !== 'manager_message' || after.type !== 'manager_message') {
      throw new Error('unreachable');
    }
    // **同じ1本の式で読む。`text` は一度も参照しない。**
    const readStatus = (event: typeof before) => event.statusAtDelivery;
    expect(readStatus(before)).toBe('lost');
    expect(readStatus(after)).toBe('lost');
  });
});

/**
 * 一覧の `updatedAt` 導出（`commitmentUpdatedAt` / `approvalUpdatedAt`）。
 *
 * MCP（`tools.ts`）・HTTP・CLI（`apps/cli/src/chat.ts`）の3面が同じ導出を
 * それぞれの実装側に書いていたのをここへ寄せた（#269 一覧の updatedAt 導出を
 * 1箇所へ）。ここで固定するのは導出そのもの（両枝）で、出力の文字列を測る
 * 歯は `tools.test.ts` の「commitment_list の作成は at・更新は closedAt ?? at」
 * が別に持っている——役割が違うので、あちらは書き換えていない。
 */
describe('commitmentUpdatedAt', () => {
  it('closedAt が無ければ at を返す（未了）', () => {
    expect(commitmentUpdatedAt({ at: '2026-01-01T00:00:00.000Z', closedAt: undefined })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('closedAt があればそちらを返す（片付いた）', () => {
    expect(
      commitmentUpdatedAt({
        at: '2026-01-01T00:00:00.000Z',
        closedAt: '2026-01-02T00:00:00.000Z',
      }),
    ).toBe('2026-01-02T00:00:00.000Z');
  });
});

/**
 * 「返答済み・未クローズ」の導出（issue #1003）。
 *
 * ここで固定するのは `commitmentRespondedAt` 単体の枝分かれである。
 * 画面（`apps/web/app/routes/commitments.tsx`）がこの値の有無をどう見せる
 * かは `commitments.test.tsx` の「返答済み・未クローズ / 未着手」が別に持つ
 * ——役割が違うので、あちらは書き換えていない。
 */
describe('commitmentRespondedAt', () => {
  it('origin が human で、返答（with:human, role:outbound）が at より後に見つかれば、その時刻を返す', () => {
    const replies = new Map([['conv-1', ['2026-01-02T00:00:00.000Z']]]);
    expect(
      commitmentRespondedAt(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        replies,
      ),
    ).toBe('2026-01-02T00:00:00.000Z');
  });

  it('昇順の並びの中で、at を初めて超えた時刻を返す（それより前の返答は無視する）', () => {
    const replies = new Map([
      [
        'conv-1',
        ['2026-01-01T00:00:00.000Z', '2026-01-01T12:00:00.000Z', '2026-01-03T00:00:00.000Z'],
      ],
    ]);
    // 最初の返答（00:00）はこの行の `at`（12:00）より前——この行への返答では
    // ありえない。それより後（1/3）が「返答済み」の時刻になる。
    expect(
      commitmentRespondedAt(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T12:00:00.000Z' },
        replies,
      ),
    ).toBe('2026-01-03T00:00:00.000Z');
  });

  it('会話 id が一致する返答が無ければ undefined（＝「未着手」側の残余）', () => {
    const replies = new Map([['conv-other', ['2026-01-02T00:00:00.000Z']]]);
    expect(
      commitmentRespondedAt(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        replies,
      ),
    ).toBeUndefined();
  });

  it('origin が human でなければ、一致する会話があっても undefined（この導出の対象外）', () => {
    const replies = new Map([['conv-1', ['2026-01-02T00:00:00.000Z']]]);
    expect(
      commitmentRespondedAt(
        { origin: 'self', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        replies,
      ),
    ).toBeUndefined();
  });

  /**
   * `origin: 'human'` の `source` は、承認待ちへの回答（`human_answer`）では
   * `approvalId`、`POST /commitments` では呼び出し側の任意文字列——会話 id
   * とは限らない（`commitmentRespondedAt` の doc）。`source` が無い行
   * （`POST /commitments` は省略可）はこの導出の対象外になる。
   */
  it('source が無ければ undefined（会話 id を持たない human 行——POST /commitments 等）', () => {
    const replies = new Map([['conv-1', ['2026-01-02T00:00:00.000Z']]]);
    expect(
      commitmentRespondedAt(
        { origin: 'human', source: undefined, at: '2026-01-01T00:00:00.000Z' },
        replies,
      ),
    ).toBeUndefined();
  });
});

/**
 * 「進行中（委譲あり）」の導出（issue #1003 段2）。
 *
 * `commitmentRespondedAt`（直上）と対になる関数——形と枝分かれの立て方を
 * そのまま流用する。画面（`apps/web/app/routes/commitments.tsx`）がこの値の
 * 有無をどう見せるかは `commitments.test.tsx` の側が持つ想定で、ここで
 * 固定するのは `commitmentActiveDelegationIds` 単体の枝分かれである。
 */
describe('commitmentActiveDelegationIds', () => {
  it('origin が human で、行の at より後に始まった走行中のマネージャーが見つかれば、その managerId を返す', () => {
    const active = new Map([
      ['conv-1', [{ managerId: 'mgr-1', createdAt: '2026-01-02T00:00:00.000Z' }]],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        active,
      ),
    ).toEqual(['mgr-1']);
  });

  it('行の at より前に始まった委譲は数えない（この行より前の頼みごとに応えたもの）', () => {
    const active = new Map([
      ['conv-1', [{ managerId: 'mgr-old', createdAt: '2026-01-01T00:00:00.000Z' }]],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T12:00:00.000Z' },
        active,
      ),
    ).toBeUndefined();
  });

  it('同じ会話に複数の走行中のマネージャーが在れば、全部の managerId を返す', () => {
    const active = new Map([
      [
        'conv-1',
        [
          { managerId: 'mgr-1', createdAt: '2026-01-02T00:00:00.000Z' },
          { managerId: 'mgr-2', createdAt: '2026-01-03T00:00:00.000Z' },
        ],
      ],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        active,
      ),
    ).toEqual(['mgr-1', 'mgr-2']);
  });

  it('会話 id が一致する走行中のマネージャーが無ければ undefined（＝「進行中」ではない側の残余）', () => {
    const active = new Map([
      ['conv-other', [{ managerId: 'mgr-1', createdAt: '2026-01-02T00:00:00.000Z' }]],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'human', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        active,
      ),
    ).toBeUndefined();
  });

  it('origin が human でなければ、一致する会話があっても undefined（この導出の対象外）', () => {
    const active = new Map([
      ['conv-1', [{ managerId: 'mgr-1', createdAt: '2026-01-02T00:00:00.000Z' }]],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'self', source: 'conv-1', at: '2026-01-01T00:00:00.000Z' },
        active,
      ),
    ).toBeUndefined();
  });

  it('source が無ければ undefined（会話 id を持たない human 行——POST /commitments 等）', () => {
    const active = new Map([
      ['conv-1', [{ managerId: 'mgr-1', createdAt: '2026-01-02T00:00:00.000Z' }]],
    ]);
    expect(
      commitmentActiveDelegationIds(
        { origin: 'human', source: undefined, at: '2026-01-01T00:00:00.000Z' },
        active,
      ),
    ).toBeUndefined();
  });
});

describe('approvalUpdatedAt', () => {
  it('answeredAt が無ければ createdAt を返す（回答待ち）', () => {
    expect(
      approvalUpdatedAt({ createdAt: '2026-01-01T00:00:00.000Z', answeredAt: undefined }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('answeredAt があればそちらを返す（回答済み）。この枝は tools.ts の呼び出し元からは到達しないが、ここで直接固定する', () => {
    expect(
      approvalUpdatedAt({
        createdAt: '2026-01-01T00:00:00.000Z',
        answeredAt: '2026-01-03T00:00:00.000Z',
      }),
    ).toBe('2026-01-03T00:00:00.000Z');
  });

  // #963: withdrawnAt を answeredAt と対の終端として足した。
  it('withdrawnAt があればそちらを返す（取り下げ済み）', () => {
    expect(
      approvalUpdatedAt({
        createdAt: '2026-01-01T00:00:00.000Z',
        withdrawnAt: '2026-01-04T00:00:00.000Z',
      }),
    ).toBe('2026-01-04T00:00:00.000Z');
  });

  it('withdrawnAt と answeredAt が両方あれば withdrawnAt を優先する（正常な経路では両立しないが、優先順位を明示する）', () => {
    expect(
      approvalUpdatedAt({
        createdAt: '2026-01-01T00:00:00.000Z',
        answeredAt: '2026-01-03T00:00:00.000Z',
        withdrawnAt: '2026-01-04T00:00:00.000Z',
      }),
    ).toBe('2026-01-04T00:00:00.000Z');
  });
});

describe('pendingApprovalSchema（#963: withdrawnAt / withdrawnReason）', () => {
  it('withdrawnAt / withdrawnReason 無しでもパースできる（既存の行と互換）', () => {
    const parsed = pendingApprovalSchema.safeParse({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '質問',
    });
    expect(parsed.success).toBe(true);
  });

  it('withdrawnAt / withdrawnReason 付きでパースできる', () => {
    const parsed = pendingApprovalSchema.safeParse({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '質問',
      withdrawnAt: '2026-01-02T00:00:00.000Z',
      withdrawnReason: '不要になった',
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * 承認への回答経路（Issue #1479）。**既存レコード（欄が無い）は「記録なし」
 * として読める**——`answeredVia` を持たない fs / pg の古い行に対する後方互換を
 * ここで固定する。値そのもの（`operator` の2値・`account`）のパースと
 * `describeAnsweredVia` の文言も併せて固定する。
 */
describe('answeredViaSchema / pendingApprovalSchema.answeredVia（Issue #1479）', () => {
  it('answeredVia 無しでもパースできる（既存の行と互換）', () => {
    const parsed = pendingApprovalSchema.safeParse({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '質問',
      answeredAt: '2026-01-01T00:00:10.000Z',
      answer: 'よい',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.answeredVia).toBeUndefined();
  });

  it.each([
    [{ kind: 'operator', auth: 'disabled' }],
    [{ kind: 'operator', auth: 'operator-token' }],
    [{ kind: 'account', accountId: 'acc-1' }],
  ])('answeredVia=%o を持つ行がパースできる', (answeredVia) => {
    const parsed = pendingApprovalSchema.safeParse({
      id: 'ap-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: '質問',
      answeredAt: '2026-01-01T00:00:10.000Z',
      answer: 'よい',
      answeredVia,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.answeredVia).toEqual(answeredVia);
  });

  it('operator の auth に定義外の値が来ると拒む（版ずれの検出）', () => {
    const parsed = answeredViaSchema.safeParse({ kind: 'operator', auth: 'something-else' });
    expect(parsed.success).toBe(false);
  });

  it('kind が operator でも account でもない値は拒む', () => {
    const parsed = answeredViaSchema.safeParse({ kind: 'clone' });
    expect(parsed.success).toBe(false);
  });

  it('describeAnsweredVia は経路ごとに短い1行を返す', () => {
    expect(describeAnsweredVia({ kind: 'operator', auth: 'disabled' })).toBe(
      'operator（認証無効）',
    );
    expect(describeAnsweredVia({ kind: 'operator', auth: 'operator-token' })).toBe(
      'operator（operator token）',
    );
    expect(describeAnsweredVia({ kind: 'account', accountId: 'acc-1' })).toBe('account（acc-1）');
  });

  it('inboxEventSchema の human_answer は answeredVia 無しでもパースできる（既存の合図と互換）', () => {
    const parsed = inboxEventSchema.safeParse({
      type: 'human_answer',
      id: 'ev-1',
      at: '2026-01-01T00:00:10.000Z',
      approvalId: 'ap-1',
      answer: 'よい',
    });
    expect(parsed.success).toBe(true);
  });

  it('inboxEventSchema の human_answer は answeredVia を運べる', () => {
    const parsed = inboxEventSchema.safeParse({
      type: 'human_answer',
      id: 'ev-1',
      at: '2026-01-01T00:00:10.000Z',
      approvalId: 'ap-1',
      answer: 'よい',
      answeredVia: { kind: 'account', accountId: 'acc-1' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'human_answer') {
      expect(parsed.data.answeredVia).toEqual({ kind: 'account', accountId: 'acc-1' });
    }
  });

  it('journalEntrySchema の escalation は answeredVia 無しでもパースできる（既存の行と互換）', () => {
    const parsed = journalEntrySchema.safeParse({
      type: 'escalation',
      id: 'j-1',
      at: '2026-01-01T00:00:10.000Z',
      question: '質問',
      approvalId: 'ap-1',
      answeredAt: '2026-01-01T00:00:10.000Z',
      answer: 'よい',
    });
    expect(parsed.success).toBe(true);
  });

  it('journalEntrySchema の escalation は answeredVia を運べる', () => {
    const parsed = journalEntrySchema.safeParse({
      type: 'escalation',
      id: 'j-1',
      at: '2026-01-01T00:00:10.000Z',
      question: '質問',
      approvalId: 'ap-1',
      answeredAt: '2026-01-01T00:00:10.000Z',
      answer: 'よい',
      answeredVia: { kind: 'operator', auth: 'operator-token' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'escalation') {
      expect(parsed.data.answeredVia).toEqual({ kind: 'operator', auth: 'operator-token' });
    }
  });
});

/**
 * 台帳・委譲の `grounds` 定数（#1310）。**文言は main へ入っていた元のリテラルと
 * 1文字も変わっていないことを固定する**——`inferAppraisedByFromGrounds` が
 * 構造欄の無い過去の行を読むのはこの文言との `===` 一致に依存しているので、
 * 誰かがこの定数の中身を「整形のつもりで」書き換えると、過去の行が静かに
 * 「判定できない」側へ落ちる（AGENTS.md「取れない軸に0の行を作る」と同じ形の
 * 逆——ここは「0」ではなく「undetermined が増える」側で起きる）。
 */
describe('評定の grounds 共有定数（#1310）— 文言を固定する', () => {
  it('台帳・クローンの文言', () => {
    expect(COMMITMENT_APPRAISAL_CLONE_GROUNDS).toBe(
      'クローン自身が付けた評定（人間はこれを読んで後から覆す）',
    );
  });

  it('台帳・人間の文言', () => {
    expect(COMMITMENT_APPRAISAL_HUMAN_GROUNDS).toBe(
      '人間が直接 API から付けた（クローンの評定を覆したならその前の値も上に在る）',
    );
  });

  it('委譲・クローンの文言（旧 `who` テンプレートの生成結果と同一）', () => {
    expect(JOB_APPRAISAL_CLONE_GROUNDS).toBe('クローンが付けた（人間はこれを読んで後から覆す）');
  });

  it('委譲・人間の文言（旧 `who` テンプレートの生成結果と同一）', () => {
    expect(JOB_APPRAISAL_HUMAN_GROUNDS).toBe('人間が付けた（人間はこれを読んで後から覆す）');
  });
});

describe('journalEntrySchema — decision.appraisal（#1310）', () => {
  const base = {
    type: 'decision' as const,
    id: 'd1',
    at: '2026-01-01T00:00:00.000Z',
    decision: '引き受けた仕事に評定を付けた（c1）: good',
    grounds: COMMITMENT_APPRAISAL_CLONE_GROUNDS,
  };

  it('構造欄が無い過去の行も引き続き safeParse を通る（既存の行を壊さない）', () => {
    const parsed = journalEntrySchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it('構造欄ありの行を safeParse できる（previous / previousBy 無し＝初回）', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      appraisal: { target: 'commitment', id: 'c1', value: 'good', by: 'clone' },
    });
    expect(parsed.success).toBe(true);
  });

  it('構造欄ありの行を safeParse できる（previous / previousBy 有り＝付け直し）', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      appraisal: {
        target: 'job',
        id: 'm1',
        value: 'bad',
        by: 'human',
        previous: 'good',
        previousBy: 'clone',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('appraisal.target が既知の2値以外だと safeParse は落ちる', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      appraisal: { target: 'workflow', id: 'w1', value: 'good', by: 'clone' },
    });
    expect(parsed.success).toBe(false);
  });

  it('appraisal.value が既知の3値以外だと safeParse は落ちる（書き込み側は appraisalSchema に縛る）', () => {
    const parsed = journalEntrySchema.safeParse({
      ...base,
      appraisal: { target: 'commitment', id: 'c1', value: 'brilliant', by: 'clone' },
    });
    expect(parsed.success).toBe(false);
  });
});
