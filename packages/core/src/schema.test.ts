import { describe, expect, it } from 'vitest';

import {
  answeredViaSchema,
  approvalUpdatedAt,
  commitmentActiveDelegationIds,
  commitmentSchema,
  commitmentRespondedAt,
  commitmentUpdatedAt,
  describeAnsweredVia,
  inboxEventSchema,
  jobSchema,
  journalEntrySchema,
  pendingApprovalSchema,
} from './schema.js';

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
    const readStatus = (event: typeof before) => event.statusAtDelivery;
    expect(readStatus(before)).toBe('lost');
    expect(readStatus(after)).toBe('lost');
  });
});

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

describe('decision.target（やり方の書き込みの印、#4065）', () => {
  const base = {
    type: 'decision',
    id: 'd1',
    at: '2026-01-01T00:00:00.000Z',
    decision: 'やり方 daily を書き直した',
    grounds: '根拠',
  };

  it('target の無い古い行は印なしとして読める', () => {
    const parsed = journalEntrySchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'decision') {
      expect(parsed.data.target).toBeUndefined();
    }
  });

  it('target を持つ行は値が落ちずに読める', () => {
    const target = { kind: 'practice', slug: 'daily' };
    const parsed = journalEntrySchema.safeParse({ ...base, target });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'decision') {
      expect(parsed.data.target).toEqual(target);
    }
  });
});

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

describe('過去の評定のキーを持つ行が読める（#2699）', () => {
  it('journalEntrySchema: decision.appraisal を持つ過去の行は safeParse を通る', () => {
    const parsed = journalEntrySchema.safeParse({
      type: 'decision',
      id: 'd1',
      at: '2026-01-01T00:00:00.000Z',
      decision: '引き受けた仕事に評定を付けた（c1）: good',
      grounds: 'クローン自身が付けた評定（人間はこれを読んで後から覆す）',
      appraisal: { target: 'job', id: 'm1', value: 'bad', by: 'human', previous: 'good' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'decision') {
      expect(parsed.data.decision).toBe('引き受けた仕事に評定を付けた（c1）: good');
    }
  });

  it('commitmentSchema: appraisal 系のキーを持つ過去の行は safeParse を通る', () => {
    const parsed = commitmentSchema.safeParse({
      id: 'c1',
      at: '2026-01-01T00:00:00.000Z',
      body: '依頼',
      origin: 'human',
      closedAt: '2026-01-02T00:00:00.000Z',
      closedReason: '済んだ',
      closedBy: 'clone',
      appraisal: 'good',
      appraisedAt: '2026-01-02T00:01:00.000Z',
      appraisedBy: 'human',
      appraisalReason: '理由',
      workKind: '実装',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body).toBe('依頼');
  });

  it('jobSchema: appraisal 系のキーを持つ過去の行は safeParse を通る', () => {
    const parsed = jobSchema.safeParse({
      id: 'm1',
      status: 'done',
      summary: '委譲',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      appraisal: 'bad',
      appraisedAt: '2026-01-02T00:01:00.000Z',
      appraisedBy: 'clone',
      appraisalReason: '理由',
      workKind: '調査',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.status).toBe('done');
  });
});
