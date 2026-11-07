import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type { DelegatedPermissionRuleService } from './delegated-permission-rules.js';
import type { InboxEvent, JournalEntryInput, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

/**
 * 承認への回答の配達と許可の記録（E1。`clone.ts` の `answerApproval` の本体・`#recordPermissionGrantIfConsented`・`#markAnswerDelivered`・
 * `#markAnswerDeliveredOnHandle`・`#reopenAnswerDeliveryAfterFailure`・`#reconcileUndeliveredAnswers`・`#reconcilePermissionGrant`）を協力者へ切り出す前に置いた固定。今の作りの出力で通る。
 * 期待の文字列と呼び順は仕様を先に書いたものではなく、今の作りの出力を生成して目で読んで確かめたものを写した
 * （既存の `approval-answer-delivery.test.ts`・`clone-permission-grant-journal-first.test.ts` などは `includes`・件数・最終状態が中心。ここは全文・書き込みの順・握る失敗の跡の文言を足す）。
 * 切り出しの前後でこの試験を変えない。
 */

const RULE = 'Bash(make test)';
const VIA = { kind: 'account', accountId: 'acc-1' } as const;
const GROUNDS_TAIL = `approvalId=ap-perm・rule=${RULE}`;
const PERMISSION_APPROVAL: PendingApproval = {
  id: 'ap-perm',
  createdAt: '2026-09-01T00:00:00.000Z',
  question: `以降 ${RULE} を聞かずに通してよいか`,
  permissionRequest: { rule: RULE, allows: ['make test'], denies: ['make test; rm -rf /'] },
};
const PLAIN_APPROVAL: PendingApproval = {
  id: 'ap-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  question: '本番のマイグレーションを走らせてよいか',
};

type AnyFn = (...args: unknown[]) => unknown;

// 指定したメソッドだけ差し替え、残りは元の対象へ束ねて通す（`approval-answer-delivery.test.ts` の Proxy と同じ形）
function wrapMethods<T extends object>(target: T, overrides: Partial<Record<keyof T, AnyFn>>): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const override = overrides[prop as keyof T];
      if (override !== undefined) return override;
      const value = Reflect.get(t, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as AnyFn).bind(t) : value;
    },
  });
}

interface Hooks {
  /** `jobs.updateApproval` に渡った mutate の結果の種類（`answer`・`mark`・`reopen`・`skip`）を見て、投げる／丸ごと差し替える */
  beforeUpdate?: (kind: 'answer' | 'mark' | 'reopen' | 'skip') => void;
  failJournalWhen?: (entry: JournalEntryInput) => boolean;
  failInboxPutWhen?: (event: InboxEvent, nth: number) => boolean;
  failGrantPut?: boolean;
  failGrantList?: boolean;
  log?: string[];
  /** `inbox.put` に渡った合図（落とした回も含む）を順に積む */
  putEvents?: InboxEvent[];
}

function storesWith(hooks: Hooks): Stores {
  const base = createMemoryStores();
  const log = hooks.log;
  let putCount = 0;
  const jobs = wrapMethods(base.jobs, {
    updateApproval: (async (
      id: string,
      mutate: (current: PendingApproval) => PendingApproval | null,
    ) =>
      base.jobs.updateApproval(id, (current) => {
        const next = mutate(current);
        const kind =
          next === null
            ? 'skip'
            : current.answeredAt === undefined && next.answeredAt !== undefined
              ? 'answer'
              : current.answerDelivery === 'pending' && next.answerDelivery === 'delivered'
                ? 'mark'
                : current.answerDelivery === 'delivered' && next.answerDelivery === 'pending'
                  ? 'reopen'
                  : 'skip';
        log?.push(`updateApproval:${kind}:${id}`);
        hooks.beforeUpdate?.(kind);
        return next;
      })) as AnyFn,
  });
  const inbox = wrapMethods(base.inbox, {
    put: (async (event: InboxEvent, at: string) => {
      putCount += 1;
      hooks.putEvents?.push(event);
      log?.push(`inbox.put:${event.type}:${event.id}`);
      if (hooks.failInboxPutWhen?.(event, putCount) === true) {
        throw new Error('受信箱へ書けない（テスト）');
      }
      return base.inbox.put(event, at);
    }) as AnyFn,
  });
  const journal = {
    ...base.journal,
    async append(entry: JournalEntryInput) {
      if (hooks.failJournalWhen?.(entry) === true) throw new Error('日誌が書けない（テスト）');
      if (entry.type === 'escalation') log?.push(`journal:escalation:${entry.approvalId}`);
      if (entry.type === 'decision' && entry.decision.includes('許可を記録')) {
        log?.push(`journal:decision:${entry.decision}`);
      }
      return base.journal.append(entry);
    },
  };
  const permissionGrants = {
    ...base.permissionGrants,
    async put(grant: Parameters<Stores['permissionGrants']['put']>[0]) {
      log?.push(`permissionGrants.put:${grant.approvalId}`);
      if (hooks.failGrantPut === true) throw new Error('put が落ちた（テスト）');
      return base.permissionGrants.put(grant);
    },
    async list() {
      if (hooks.failGrantList === true) throw new Error('許可の一覧が読めない（テスト）');
      return base.permissionGrants.list();
    },
  };
  return { ...base, jobs, inbox, journal, permissionGrants };
}

// 跡（stderr の1行）から接頭辞の `alteroid: <時刻> ` を除く。時刻は毎回変わるので、文言の側だけを全文で比べる
function traces(lines: readonly string[], mark: string): string[] {
  return lines
    .filter((line) => line.includes(mark))
    .map((line) => line.replace(/^alteroid: \S+ /, ''));
}

interface DecisionRow {
  decision: string;
  grounds: string;
}

// `journal.list` は新しい順で返すので、書いた順に直す。許可の記録に関わる行だけを見る
async function grantDecisionRows(stores: Stores): Promise<DecisionRow[]> {
  const rows = await stores.journal.list({ types: ['decision'], limit: 100 });
  return rows
    .flatMap((row) =>
      row.type === 'decision' &&
      (row.decision.startsWith('許可を記録') || row.decision.startsWith('直前の「許可を記録する」'))
        ? [{ decision: row.decision, grounds: row.grounds }]
        : [],
    )
    .reverse();
}

async function exchangeTexts(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['self'], limit: 100 });
  return rows.flatMap((row) => (row.type === 'exchange' ? [row.text] : [])).reverse();
}

async function answerPermission(
  stores: Stores,
  answer: string,
  via: Parameters<ReturnType<typeof setup>['clone']['answerApproval']>[2],
  service?: DelegatedPermissionRuleService,
) {
  const s = setup(
    undefined,
    stores,
    {},
    {},
    service === undefined ? {} : { permissionRuleService: service },
  );
  await stores.jobs.putApproval(PERMISSION_APPROVAL);
  await s.clone.answerApproval('ap-perm', answer, via);
  return s;
}

describe('許可の記録の日誌の行（`#recordPermissionGrantIfConsented`）の全文', () => {
  it('回答が定型文でないとき: 「記録しなかった」と、一致しない理由（全文）', async () => {
    const stores = storesWith({});
    const s = await answerPermission(stores, 'はい', VIA);

    expect(await grantDecisionRows(stores)).toEqual([
      {
        decision: `許可を記録しなかった: ${RULE}`,
        grounds: `回答が定型文（許可します）と一致しない（${GROUNDS_TAIL}）`,
      },
    ]);
    expect(await stores.permissionGrants.list()).toEqual([]);
    await s.clone.stop();
  });

  it('経路（via）が未指定のとき: 「記録しなかった」と、既定は不許可の理由（全文）', async () => {
    const stores = storesWith({});
    const s = await answerPermission(stores, '許可します', undefined);

    expect(await grantDecisionRows(stores)).toEqual([
      {
        decision: `許可を記録しなかった: ${RULE}`,
        grounds: `回答の経路が指定されていない——既定は不許可（${GROUNDS_TAIL}）`,
      },
    ]);
    expect(await stores.permissionGrants.list()).toEqual([]);
    await s.clone.stop();
  });

  it('経路が operator のとき: 「記録しなかった」と、認証の名前を含む理由（全文）', async () => {
    const stores = storesWith({});
    const s = await answerPermission(stores, '許可します', {
      kind: 'operator',
      auth: 'operator-token',
    });

    expect(await grantDecisionRows(stores)).toEqual([
      {
        decision: `許可を記録しなかった: ${RULE}`,
        grounds:
          '回答の経路が実行環境の持ち主（operator。認証: operator-token）だった——operator の資格は' +
          `クローンの器から読めるため、人間の証拠にならない（${GROUNDS_TAIL}）`,
      },
    ]);
    expect(await stores.permissionGrants.list()).toEqual([]);
    await s.clone.stop();
  });

  it('定型文・アカウント経路のとき: 「記録する」と、アカウントの id を含む根拠（全文）。許可の欄も固定する', async () => {
    const stores = storesWith({});
    const s = await answerPermission(stores, '  許可します  ', VIA);

    expect(await grantDecisionRows(stores)).toEqual([
      {
        decision: `許可を記録する: ${RULE}`,
        grounds: `許可されたアカウント（acc-1）の回答（${GROUNDS_TAIL}）`,
      },
    ]);
    const approval = await stores.jobs.getApproval('ap-perm');
    const grants = await stores.permissionGrants.list();
    expect(grants).toHaveLength(1);
    // 同意の判定は trim 後で行うが、行へ残す `answer` は trim していない（NUL を落とした後の値）
    expect(grants[0]).toEqual({
      id: expect.any(String) as string,
      rule: RULE,
      allows: ['make test'],
      denies: ['make test; rm -rf /'],
      approvalId: 'ap-perm',
      answer: '  許可します  ',
      grantedAt: approval?.answeredAt,
      route: { principalKind: 'account', accountId: 'acc-1' },
    });
    await s.clone.stop();
  });

  it('許可の書き込みが落ちたとき: 先の「記録する」の行の後に、打ち消す行（全文）が続く', async () => {
    const stores = storesWith({ failGrantPut: true });
    const s = await answerPermission(stores, '許可します', VIA);

    expect(await grantDecisionRows(stores)).toEqual([
      {
        decision: `許可を記録する: ${RULE}`,
        grounds: `許可されたアカウント（acc-1）の回答（${GROUNDS_TAIL}）`,
      },
      {
        decision: `直前の「許可を記録する」の行は効いていない（許可の記録に失敗した）: ${RULE}`,
        grounds: `Error: put が落ちた（テスト）（${GROUNDS_TAIL}）`,
      },
    ]);
    expect(await stores.permissionGrants.list()).toEqual([]);
    await s.clone.stop();
  });

  it('承認が許可の要求を持たないとき: 許可の行は1行も書かず、許可も記録しない', async () => {
    const stores = storesWith({});
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores);
    await s.clone.answerApproval('ap-1', '許可します', VIA);

    expect(await grantDecisionRows(stores)).toEqual([]);
    expect(await stores.permissionGrants.list()).toEqual([]);
    await s.clone.stop();
  });

  it('許可の行を日誌に書けないとき: 許可を書かず、握った跡を文言どおりに stderr へ残す', async () => {
    const stores = storesWith({
      failJournalWhen: (entry) =>
        entry.type === 'decision' && entry.decision.includes('許可を記録する'),
    });
    let s: Awaited<ReturnType<typeof answerPermission>> | undefined;
    const lines = await captureStderr(async () => {
      s = await answerPermission(stores, '許可します', VIA);
    });

    expect(await stores.permissionGrants.list()).toEqual([]);
    expect(traces(lines, '許可の記録（日誌に書けないので許可を記録しなかった）')).toEqual([
      '許可の記録（日誌に書けないので許可を記録しなかった）を記録できませんでした' +
        `（${GROUNDS_TAIL}）: Error: 日誌が書けない（テスト）\n`,
    ]);
    await s?.clone.stop();
  });
});

describe('委譲先への配信は待たない（`void` のまま）', () => {
  function serviceWith(pushAll: DelegatedPermissionRuleService['pushAll']) {
    const triggers: string[] = [];
    const service: DelegatedPermissionRuleService = {
      async syncRunner() {
        return null;
      },
      pushAll(trigger: string) {
        triggers.push(trigger);
        return pushAll(trigger);
      },
      onPushed: () => () => undefined,
    };
    return { service, triggers };
  }

  it('配信が終わらなくても、answerApproval は戻り、受信箱への先出しまで済む', async () => {
    const stores = storesWith({});
    const { service, triggers } = serviceWith(() => new Promise(() => undefined));
    const s = await answerPermission(stores, '許可します', VIA, service);

    expect(triggers).toHaveLength(1);
    expect((await stores.jobs.getApproval('ap-perm'))?.answerDelivery).toBe('delivered');
    await s.clone.stop();
  });

  it('配信が拒否されても、answerApproval は投げない', async () => {
    const stores = storesWith({});
    const { service, triggers } = serviceWith(() =>
      Promise.reject(new Error('配れない（テスト）')),
    );
    const s = await answerPermission(stores, '許可します', VIA, service);

    expect(triggers).toHaveLength(1);
    expect((await stores.jobs.getApproval('ap-perm'))?.answer).toBe('許可します');
    await s.clone.stop();
  });

  it('載せない形の許可（`*` を含む前方一致）では、記録は残るが配信は呼ばない', async () => {
    const stores = storesWith({});
    const { service, triggers } = serviceWith(async () => []);
    const s = setup(undefined, stores, {}, {}, { permissionRuleService: service });
    await stores.jobs.putApproval({
      ...PERMISSION_APPROVAL,
      permissionRequest: { rule: 'Bash(make *:*)', allows: ['make a'], denies: [] },
    });
    await s.clone.answerApproval('ap-perm', '許可します', VIA);

    expect((await stores.permissionGrants.list()).map((grant) => grant.rule)).toEqual([
      'Bash(make *:*)',
    ]);
    expect(triggers).toEqual([]);
    await s.clone.stop();
  });
});

describe('answerApproval の書き込みの順と握る失敗', () => {
  it('行へ回答 → 日誌（escalation）→ 許可の日誌 → 許可 → 受信箱への先出し → 配達の印、の順で書く', async () => {
    const log: string[] = [];
    const stores = storesWith({ log });
    const s = await answerPermission(stores, '許可します', VIA);
    const answeredAt = (await stores.jobs.getApproval('ap-perm'))?.answeredAt as string;
    const id = `human-answer-ap-perm-${answeredAt}`;

    // 受信箱への先出しは `post` の前に済み、`post` が積む書き込み（同じ id の `put`）は印の後ろに来る
    // 回答のターンが起きる（処理時の印の判定が済む）まで待ってから、書き込みの全部を見る: 処理時に余計な書き込みが増えないことも固定する
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, 'post した回答のターンが起きる');
    expect(log).toEqual([
      'updateApproval:answer:ap-perm',
      'journal:escalation:ap-perm',
      `journal:decision:許可を記録する: ${RULE}`,
      'permissionGrants.put:ap-perm',
      `inbox.put:human_answer:${id}`,
      'updateApproval:mark:ap-perm',
      `inbox.put:human_answer:${id}`,
    ]);
    await s.clone.stop();
  });

  it('受信箱への先出しが落ちたとき: 印は立てず（行は pending のまま）、post だけは走る。先出しの跡を残す', async () => {
    const log: string[] = [];
    // 印（`delivered`）の書き込みを全部落として、行が `pending` のままであることを見えるようにする
    const stores = storesWith({
      log,
      failInboxPutWhen: (_event, nth) => nth === 1,
      beforeUpdate: (kind) => {
        if (kind === 'mark') throw new Error('印が書けない（テスト）');
      },
    });
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores);
    const lines = await captureStderr(async () => {
      await s.clone.answerApproval('ap-1', '許可します');
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, 'post した回答のターンが起きる');
    });

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBe('pending');
    expect(s.calls[0]?.inputs[0]).toContain('回答: 許可します');
    expect(traces(lines, '回答の配達印の先出し')).toEqual([
      '回答の配達印の先出しを記録できませんでした' +
        '（human_answer approvalId=ap-1 answer.chars=5）: Error: 受信箱へ書けない（テスト）\n',
    ]);
    // 先出しが落ちた回は、`answerApproval` は印を試みない（確定の跡は無い。処理時の印の失敗は別の文言）
    expect(lines.some((line) => line.includes('回答の配達印の確定を記録できませんでした'))).toBe(
      false,
    );
    expect(log.filter((entry) => entry.startsWith('updateApproval:mark'))).toEqual([
      'updateApproval:mark:ap-1',
    ]);
    await s.clone.stop();
  });

  it('受信箱への先出しが落ちたとき（印は通す）: 印は post が積む書き込みより後ろ、処理時にだけ立つ', async () => {
    const log: string[] = [];
    const stores = storesWith({ log, failInboxPutWhen: (_event, nth) => nth === 1 });
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores);
    await s.clone.answerApproval('ap-1', '許可します');
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'delivered',
      '処理時に印が立つ',
    );

    const answeredAt = (await stores.jobs.getApproval('ap-1'))?.answeredAt as string;
    const id = `human-answer-ap-1-${answeredAt}`;
    // 先出し（落ちた）→ post の書き込み → 処理時の印。`answerApproval` の中に印は無い
    expect(log).toEqual([
      'updateApproval:answer:ap-1',
      'journal:escalation:ap-1',
      `inbox.put:human_answer:${id}`,
      `inbox.put:human_answer:${id}`,
      'updateApproval:mark:ap-1',
    ]);
    await s.clone.stop();
  });

  it('配達の印の確定が落ちたとき: 確定の跡を残し、post は走る', async () => {
    let failedOnce = false;
    const stores = storesWith({
      beforeUpdate: (kind) => {
        if (kind === 'mark' && !failedOnce) {
          failedOnce = true;
          throw new Error('印が書けない（テスト）');
        }
      },
    });
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores);
    const lines = await captureStderr(async () => {
      await s.clone.answerApproval('ap-1', '許可します');
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, 'post した回答のターンが起きる');
    });

    expect(failedOnce).toBe(true);
    expect(s.calls[0]?.inputs[0]).toContain('回答: 許可します');
    expect(traces(lines, '回答の配達印の確定')).toEqual([
      '回答の配達印の確定を記録できませんでした' +
        '（human_answer approvalId=ap-1 answer.chars=5）: Error: 印が書けない（テスト）\n',
    ]);
    await s.clone.stop();
  });

  it('存在しない承認への回答は、文言どおりに断り、何も書かない', async () => {
    const stores = storesWith({});
    const s = setup(undefined, stores);

    await expect(s.clone.answerApproval('ap-none', '許可します')).rejects.toThrow(
      new Error('承認待ち ap-none は存在しない'),
    );
    expect(await exchangeTexts(stores)).toEqual([]);
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
    await s.clone.stop();
  });

  it('行を書く時点で承認が消えていたとき（書き込みが null を返し、理由も無い）: 同じ文言で断り、日誌も受信箱も書かない', async () => {
    const log: string[] = [];
    const base = storesWith({ log });
    const jobs = wrapMethods(base.jobs, { updateApproval: (async () => null) as AnyFn });
    const stores: Stores = { ...base, jobs };
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores);

    await expect(s.clone.answerApproval('ap-1', '許可します')).rejects.toThrow(
      new Error('承認待ち ap-1 は存在しない'),
    );
    expect(log).toEqual([]);
    await s.clone.stop();
  });

  it('受け取った回答（selections を畳んだ文・conversationId・answeredVia）を、human_answer の欄へ全部運ぶ（全文）', async () => {
    const puts: InboxEvent[] = [];
    const stores = storesWith({ putEvents: puts });
    await stores.jobs.putApproval({
      ...PLAIN_APPROVAL,
      conversationId: 'conv-1',
      questions: [
        {
          id: 'target',
          prompt: 'デプロイ先',
          options: [
            { id: 'railway', label: 'Railway' },
            { id: 'fly', label: 'Fly.io' },
          ],
        },
      ],
    });
    const s = setup(undefined, stores);
    await s.clone.answerApproval('ap-1', '金曜は避けたい', VIA, [
      { questionId: 'target', optionIds: ['railway'] },
    ]);

    const approval = await stores.jobs.getApproval('ap-1');
    const answeredAt = approval?.answeredAt as string;
    expect(puts[0]).toEqual({
      type: 'human_answer',
      id: `human-answer-ap-1-${answeredAt}`,
      at: answeredAt,
      approvalId: 'ap-1',
      answer: 'Q1 デプロイ先: (a) Railway\n補足: 金曜は避けたい',
      selections: [{ questionId: 'target', optionIds: ['railway'] }],
      conversationId: 'conv-1',
      answeredVia: { kind: 'account', accountId: 'acc-1' },
    });
    await s.clone.stop();
  });
});

describe('起動時の拾い直し（`#reconcileUndeliveredAnswers`）', () => {
  const ROW_A: PendingApproval = {
    id: 'ap-a',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: 'A を進めてよいか',
    answeredAt: '2026-09-01T00:05:00.000Z',
    answer: '進めてよい',
    answerDelivery: 'pending',
  };
  const ROW_B: PendingApproval = {
    ...ROW_A,
    id: 'ap-b',
    question: 'B を進めてよいか',
    answeredAt: '2026-09-01T00:06:00.000Z',
  };
  const eventOf = (row: PendingApproval): InboxEvent => ({
    type: 'human_answer',
    id: `human-answer-${row.id}-${row.answeredAt as string}`,
    at: row.answeredAt as string,
    approvalId: row.id,
    answer: row.answer as string,
  });

  it('拾い直した件数の行（全文）は、拾えた分だけを数える', async () => {
    const stores = storesWith({
      // B の受信箱への書き込みだけ落とす（A は拾えて、B は拾えない）
      failInboxPutWhen: (event) => event.type === 'human_answer' && event.approvalId === 'ap-b',
    });
    await stores.jobs.putApproval(ROW_A);
    await stores.jobs.putApproval(ROW_B);
    let s: ReturnType<typeof setup> | undefined;
    const lines = await captureStderr(async () => {
      s = setup(undefined, stores);
      await waitFor(
        async () =>
          (await stores.journal.list({ types: ['decision'], limit: 100 })).some(
            (row) =>
              row.type === 'decision' &&
              row.decision.startsWith('回答済みで未配達の承認を拾い直した'),
          ),
        '拾い直しの行が書かれる',
      );
    });

    const rows = (await stores.journal.list({ types: ['decision'], limit: 100 })).flatMap((row) =>
      row.type === 'decision' && row.decision.startsWith('回答済みで未配達の承認を拾い直した')
        ? [{ decision: row.decision, grounds: row.grounds }]
        : [],
    );
    expect(rows).toEqual([
      {
        decision: '回答済みで未配達の承認を拾い直した（1 件）',
        grounds:
          '起動時、承認の行が answerDelivery=pending のまま残っていた' +
          '（issue #1977。プロセスが answerApproval の途中で落ちた痕跡）。',
      },
    ]);
    expect((await stores.jobs.getApproval('ap-a'))?.answerDelivery).toBe('delivered');
    expect((await stores.jobs.getApproval('ap-b'))?.answerDelivery).toBe('pending');
    expect(traces(lines, '回答済み未配達の承認の拾い直し')).toEqual([
      '回答済み未配達の承認の拾い直しを記録できませんでした' +
        '（human_answer approvalId=ap-b answer.chars=5）: Error: 受信箱へ書けない（テスト）\n',
    ]);
    await s?.clone.stop();
  });

  it('呼び順: 受信箱に在る（claimedIds に載る）行は印だけ、無い行は put → 印 → post の順', async () => {
    const log: string[] = [];
    const stores = storesWith({ log });
    await stores.jobs.putApproval(ROW_A);
    await stores.jobs.putApproval(ROW_B);
    // A は前の器が受信箱へ積んだ後に落ちた形（印だけが pending）。B は受信箱へも積めていない形
    await stores.inbox.put(eventOf(ROW_A), ROW_A.answeredAt as string);
    log.length = 0;

    const s = setup(undefined, stores);
    await waitFor(
      async () =>
        (await stores.jobs.getApproval('ap-a'))?.answerDelivery === 'delivered' &&
        (await stores.jobs.getApproval('ap-b'))?.answerDelivery === 'delivered',
      '2行とも delivered になる',
    );
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '拾い直した2件のターンが起きる');

    const forA = log.filter((entry) => entry.includes('ap-a'));
    const forB = log.filter((entry) => entry.includes('ap-b'));
    // A: 印だけ（reconcile 自身は `put` も `post` もしない。`post` が積む `put` も出ない）
    expect(forA).toEqual(['updateApproval:mark:ap-a']);
    // B: put → 印 → post（`post` が積む同じ id の `put`）
    expect(forB).toEqual([
      `inbox.put:human_answer:${eventOf(ROW_B).id}`,
      'updateApproval:mark:ap-b',
      `inbox.put:human_answer:${eventOf(ROW_B).id}`,
    ]);
    await s.clone.stop();
  });

  it('読めない承認の行が混じっていても、読める行の拾い直しは進み、読めない行の件数の跡を残す', async () => {
    const base = storesWith({});
    const jobs = wrapMethods(base.jobs, {
      listApprovals: (async (options: { pendingOnly?: boolean }) => {
        const list = await base.jobs.listApprovals(options);
        return { ...list, unreadable: [{ id: 'bad', reason: '壊れた行（テスト）' }] };
      }) as AnyFn,
    });
    const stores: Stores = { ...base, jobs };
    await stores.jobs.putApproval(ROW_A);
    let s: ReturnType<typeof setup> | undefined;
    const lines = await captureStderr(async () => {
      s = setup(undefined, stores);
      await waitFor(
        async () => (await stores.jobs.getApproval('ap-a'))?.answerDelivery === 'delivered',
        '読める行は拾い直される',
      );
    });

    expect(traces(lines, '読めない承認待ち')).toEqual([
      '読めない承認待ち 1 件の回答済み未配達の拾い直しを記録できませんでした' +
        ': Error: 行が読めない形で入っている。行は書き換えていない\n',
    ]);
    await s?.clone.stop();
  });

  it('拾い直し時の印が落ちても、post は走り、件数に数える。跡は「拾い直し時」の文言', async () => {
    let failedOnce = false;
    const stores = storesWith({
      beforeUpdate: (kind) => {
        if (kind === 'mark' && !failedOnce) {
          failedOnce = true;
          throw new Error('印が書けない（テスト）');
        }
      },
    });
    await stores.jobs.putApproval(ROW_A);
    let s: ReturnType<typeof setup> | undefined;
    const lines = await captureStderr(async () => {
      s = setup(undefined, stores);
      await waitFor(() => (s?.calls[0]?.inputs.length ?? 0) >= 1, '拾い直した回答のターンが起きる');
      await waitFor(
        async () =>
          (await stores.journal.list({ types: ['decision'], limit: 100 })).some(
            (row) =>
              row.type === 'decision' &&
              row.decision === '回答済みで未配達の承認を拾い直した（1 件）',
          ),
        '拾い直しの行が書かれる',
      );
    });

    expect(failedOnce).toBe(true);
    expect(traces(lines, '回答の配達印の確定（拾い直し時）')).toEqual([
      '回答の配達印の確定（拾い直し時）を記録できませんでした' +
        '（human_answer approvalId=ap-a answer.chars=5）: Error: 印が書けない（テスト）\n',
    ]);
    await s?.clone.stop();
  });

  it('許可の記録の作り直しは配達より先。許可の一覧が読めなくても、配達の拾い直しは止まらず、跡を残す', async () => {
    const log: string[] = [];
    const stores = storesWith({ log, failGrantList: true });
    await stores.jobs.putApproval({
      ...PERMISSION_APPROVAL,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: '許可します',
      answeredVia: VIA,
      answerDelivery: 'pending',
    } as PendingApproval);
    let s: ReturnType<typeof setup> | undefined;
    const lines = await captureStderr(async () => {
      s = setup(undefined, stores);
      await waitFor(
        async () => (await stores.jobs.getApproval('ap-perm'))?.answerDelivery === 'delivered',
        '拾い直しで行が delivered になる',
      );
    });

    expect(
      await stores.permissionGrants.list.call(stores.permissionGrants).catch(() => 'failed'),
    ).toBe('failed');
    expect(traces(lines, '回答済み未配達の承認の許可の記録の拾い直し')).toEqual([
      '回答済み未配達の承認の許可の記録の拾い直しを記録できませんでした' +
        '（approvalId=ap-perm）: Error: 許可の一覧が読めない（テスト）\n',
    ]);
    await s?.clone.stop();
  });
});

describe('処理時の配達印（`#markAnswerDeliveredOnHandle`）', () => {
  const PENDING_ROW: PendingApproval = {
    ...PLAIN_APPROVAL,
    answeredAt: '2999-01-01T00:05:00.000Z',
    answer: '許可します',
    answerDelivery: 'pending',
  };
  const eventFor = (id: string): InboxEvent => ({
    type: 'human_answer',
    id,
    at: '2999-01-01T00:05:00.000Z',
    approvalId: 'ap-1',
    answer: '許可します',
  });

  it('行が pending で、合図の id が行の回答と一致するとき: 処理した時点で delivered にする', async () => {
    const stores = storesWith({});
    await stores.jobs.putApproval(PENDING_ROW);
    const s = setup(undefined, stores);
    s.clone.post(eventFor('human-answer-ap-1-2999-01-01T00:05:00.000Z'));
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'delivered',
      '処理時に印が立つ',
    );
    await s.clone.stop();
  });

  it('合図の id が行の回答と一致しないとき: 印を立てない', async () => {
    const stores = storesWith({});
    await stores.jobs.putApproval(PENDING_ROW);
    const s = setup(undefined, stores);
    s.clone.post(eventFor('human-answer-ap-1-another'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '回答のターンが起きる');
    await s.clone.stop();

    expect((await stores.jobs.getApproval('ap-1'))?.answerDelivery).toBe('pending');
  });

  it('印の書き込みが落ちたとき: 握って処理時の跡を残し、ターンは起きる', async () => {
    const stores = storesWith({
      beforeUpdate: (kind) => {
        if (kind === 'mark') throw new Error('印が書けない（テスト）');
      },
    });
    await stores.jobs.putApproval(PENDING_ROW);
    const s = setup(undefined, stores);
    const lines = await captureStderr(async () => {
      s.clone.post(eventFor('human-answer-ap-1-2999-01-01T00:05:00.000Z'));
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '回答のターンが起きる');
    });

    expect(traces(lines, '回答の配達印の確定（処理時）')).toEqual([
      '回答の配達印の確定（処理時）を記録できませんでした' +
        '（human_answer approvalId=ap-1 answer.chars=5）: Error: 印が書けない（テスト）\n',
    ]);
    await s.clone.stop();
  });
});

describe('失敗したターンの回答の配達印の差し戻し（`#reopenAnswerDeliveryAfterFailure`）', () => {
  const API_ERROR = {
    resultFor: (turnIndex: number) =>
      turnIndex < 1
        ? {
            subtype: 'error_during_execution' as const,
            text: 'API Error: 500 Internal server error',
          }
        : undefined,
  };

  it('日誌の1行（全文）。pending へ戻す', async () => {
    const stores = storesWith({});
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores, API_ERROR);
    await s.clone.answerApproval('ap-1', '許可します');
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'pending',
      '印が pending に戻る',
    );
    await s.clone.stop();

    const reopened = (await exchangeTexts(stores)).filter((text) =>
      text.includes('配達の印を未配達（pending）へ戻した'),
    );
    expect(reopened).toEqual([
      '[判断] 人間の回答（承認 ap-1）を渡したターンが枠以外の理由で失敗したので、' +
        '配達の印を未配達（pending）へ戻した。次の起動（器の入れ替え）の拾い直しでもう一度配る。' +
        '同じ承認でこの行が何度も出るなら、その回答の処理は決定的に失敗している。',
    ]);
  });

  it('差し戻しの書き込みが落ちたとき: 握って差し戻しの跡を残し、日誌の行は書かない', async () => {
    const stores = storesWith({
      beforeUpdate: (kind) => {
        if (kind === 'reopen') throw new Error('差し戻せない（テスト）');
      },
    });
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores, API_ERROR);
    const lines = await captureStderr(async () => {
      await s.clone.answerApproval('ap-1', '許可します');
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '回答の初回のターンが起きる');
      await s.clone.stop();
    });

    expect(traces(lines, '失敗したターンの回答の配達印の差し戻し')).toEqual([
      '失敗したターンの回答の配達印の差し戻しを記録できませんでした' +
        '（human_answer approvalId=ap-1 answer.chars=5）: Error: 差し戻せない（テスト）\n',
    ]);
    expect(
      (await exchangeTexts(stores)).some((text) =>
        text.includes('配達の印を未配達（pending）へ戻した'),
      ),
    ).toBe(false);
  });

  it.each([
    [
      '行の回答が別の回答に変わっていた（id が合わない）',
      { answeredAt: '2026-09-02T00:00:00.000Z' },
      'delivered',
    ],
    ['行が既に pending だった', { answerDelivery: 'pending' as const }, 'pending'],
  ])('%s とき: 書き戻さず、日誌の行も書かない', async (_label, change, expectedDelivery) => {
    const base = createMemoryStores();
    let updates = 0;
    const jobs = wrapMethods(base.jobs, {
      updateApproval: (async (
        id: string,
        mutate: (current: PendingApproval) => PendingApproval | null,
      ) => {
        updates += 1;
        // 1回目＝回答の書き込み、2回目＝配達の印。3回目（差し戻し）の直前に、行を横から書き換える
        if (updates === 3) {
          const row = await base.jobs.getApproval(id);
          if (row !== null) await base.jobs.putApproval({ ...row, ...change });
        }
        return base.jobs.updateApproval(id, mutate);
      }) as AnyFn,
    });
    const stores: Stores = { ...base, jobs };
    await stores.jobs.putApproval(PLAIN_APPROVAL);
    const s = setup(undefined, stores, API_ERROR);
    await s.clone.answerApproval('ap-1', '許可します');
    await waitFor(() => updates >= 3, '差し戻しの書き込みが試みられる');
    await s.clone.stop();

    const row = await stores.jobs.getApproval('ap-1');
    expect(row?.answerDelivery).toBe(expectedDelivery);
    expect(
      (await exchangeTexts(stores)).some((text) =>
        text.includes('配達の印を未配達（pending）へ戻した'),
      ),
    ).toBe(false);
  });
});
