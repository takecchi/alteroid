import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * issue #1977 の直し（回答済みで未配達の承認を、起動時に拾い直す）。
 *
 * `Clone#answerApproval` は (a) 承認の行を回答済みにする → (c) `human_answer`
 * 合図を受信箱へ書く → (d) 配達済みの印を立てる、という順で別々に書き込む
 * （`clone.ts` の `answerApproval` の doc）。**(a) の後・(c) の前にプロセスが
 * 落ちると、承認の行は回答済みなのに合図は受信箱に無く、どの経路からも
 * 拾い直されなかった**（issue #1977 本文）。
 *
 * ここでは、`Clone` を止めずに捨てて同じ `Stores` から作り直す形
 * （`inbox-persistence.test.ts` と同じ手法）で「途中で落ちた」を再現する。
 */

interface Fake {
  fn: typeof sdkQuery;
  /** SDK へ渡った本文（＝クローンが実際に読んだプロンプト）。 */
  inputs: string[];
}

/**
 * SDK の代わり。`hang` を渡すと入力を受け取ったきり結果を返さない
 * （`inbox-persistence.test.ts` の `fakeSdk` と同じ形）。
 */
function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

/** 拾い直しが起きないはずの経路を確かめるための、束の間の待ち。 */
async function idle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** テストが直接ストアへ置く、素の（未回答の）承認待ち。 */
function seedApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'ap-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    question: '本番のマイグレーションを走らせてよいか',
    ...overrides,
  };
}

/**
 * `human_answer` 合図の決まった id の形（issue #1977。`clone.ts` の
 * `humanAnswerEventId` と同じ式）。**実装からは import しない**——実装が
 * 使っている関数をそのままテストへ持ち込むと、実装の式を書き換えた回だけ
 * この歯が一緒にずれて赤くならない（同語反復になる）。ここでは決まった
 * 文字列の形そのものを固定する。
 */
function expectedHumanAnswerEventId(approvalId: string, answeredAt: string): string {
  return `human-answer-${approvalId}-${answeredAt}`;
}

/** `human_answer` 合図を手で組み立てる（`clone.ts` の `buildHumanAnswerEvent` と同じ形）。 */
function humanAnswerEvent(approval: PendingApproval): InboxEvent {
  const { answeredAt, answer } = approval;
  if (answeredAt === undefined || answer === undefined) {
    throw new Error('テストの前提が壊れている: answeredAt/answer が無い承認から合図は組めない');
  }
  return {
    type: 'human_answer',
    id: expectedHumanAnswerEventId(approval.id, answeredAt),
    at: answeredAt,
    approvalId: approval.id,
    answer,
  };
}

describe('回答済みで未配達の承認の配達（issue #1977）', () => {
  it('通常の answerApproval は、行を delivered にし、決まった id の human_answer を受信箱へ1件積む', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seedApproval());
    const { clone, inputs } = bootClone(stores, 'hang');

    await clone.answerApproval('ap-1', '許可します');
    await waitFor(() => inputs.length > 0, '回答のターンが起きる');

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBe('delivered');
    expect(approval?.answeredAt).toBeDefined();

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    const expectedId = expectedHumanAnswerEventId('ap-1', approval?.answeredAt as string);
    expect(pending[0]?.event.id).toBe(expectedId);
    expect(pending[0]?.event.type).toBe('human_answer');

    expect(inputs[0]).toContain('質問: 本番のマイグレーションを走らせてよいか');
    expect(inputs[0]).toContain('回答: 許可します');
  });

  it('落ちた窓の再現: answeredAt/answer/answerDelivery=pending だけの行（受信箱は空）から、起動時に1回だけ配られ、行が delivered になる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seedApproval({
        answeredAt: '2026-09-01T00:05:00.000Z',
        answer: '許可します',
        answerDelivery: 'pending',
      }),
    );
    // 受信箱は空のまま——`answerApproval` が (a) を書いた直後に落ちた形。
    expect((await stores.inbox.peekPending()).entries).toEqual([]);

    const { clone, inputs } = bootClone(stores, 'hang');
    await waitFor(() => inputs.length > 0, '拾い直した回答のターンが起きる');

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('質問: 本番のマイグレーションを走らせてよいか');
    expect(inputs[0]).toContain('回答: 許可します');

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBe('delivered');

    await idle();
    // 配られるのは1回だけ——同じターンがもう一度起きていないこと。
    expect(inputs).toHaveLength(1);

    void clone;
  });

  it('冪等: 受信箱に同じ id の合図が既に在る状態から起動しても、配られるのは1回だけ', async () => {
    const stores = createMemoryStores();
    const approval = seedApproval({
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: '許可します',
      answerDelivery: 'pending',
    });
    await stores.jobs.putApproval(approval);
    // (c) は済んでいたが (d) の前に落ちた形——合図は既に受信箱に在る。
    const event = humanAnswerEvent(approval);
    await stores.inbox.put(event, event.at);

    const { clone, inputs } = bootClone(stores, 'hang');
    await waitFor(() => inputs.length > 0, '拾い直した回答のターンが起きる');

    expect(inputs).toHaveLength(1);
    const updated = await stores.jobs.getApproval('ap-1');
    expect(updated?.answerDelivery).toBe('delivered');

    const pending = (await stores.inbox.peekPending()).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event.id).toBe(event.id);

    await idle();
    expect(inputs).toHaveLength(1);

    void clone;
  });

  it('古い行（answeredAt はあるが answerDelivery を持たない）は、起動しても拾い直されない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seedApproval({
        answeredAt: '2026-09-01T00:05:00.000Z',
        answer: '許可します',
        // answerDelivery を持たない——この直しより前に回答された行と同じ形。
      }),
    );

    const { clone, inputs } = bootClone(stores, 'hang');
    await idle();

    expect(inputs).toHaveLength(0);
    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBeUndefined();
    expect((await stores.inbox.peekPending()).entries).toEqual([]);

    void clone;
  });

  it('取り下げ済みの行は拾い直されない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seedApproval({
        answeredAt: '2026-09-01T00:05:00.000Z',
        answer: '許可します',
        answerDelivery: 'pending',
        withdrawnAt: '2026-09-01T00:06:00.000Z',
        withdrawnReason: '判断が要らなくなった',
      }),
    );

    const { clone, inputs } = bootClone(stores, 'hang');
    await idle();

    expect(inputs).toHaveLength(0);
    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBe('pending');
    expect((await stores.inbox.peekPending()).entries).toEqual([]);

    void clone;
  });

  /**
   * 起動より後に回答された行は、このプロセスの `answerApproval` が配達の途中にある行である
   * （`'pending'` を書いてから `'delivered'` を書くまでの間）。拾い直しがそれを拾うと、
   * 同じ合図を2回 `post` し（`#handle` の最後の砦が1回に抑えるが、形としては塞がない）、
   * 読んだ時点の写しで行を書き戻すので、その間に同じ承認へ2回目の回答があれば
   * 新しい回答を古い回答で上書きしうる。⟹ 拾い直すのは、このプロセスが起動する前に
   * 回答された行だけにする。ここでは「起動より後」を未来の時刻で表す。
   */
  it('起動より後に回答された行（このプロセスの answerApproval の途中にある行）は、拾い直されない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seedApproval({
        answeredAt: '2999-01-01T00:00:00.000Z',
        answer: '許可します',
        answerDelivery: 'pending',
      }),
    );

    const { clone, inputs } = bootClone(stores, 'hang');
    await idle();

    expect(inputs).toHaveLength(0);
    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answerDelivery).toBe('pending');
    expect((await stores.inbox.peekPending()).entries).toEqual([]);

    void clone;
  });

  it('同じ id の human_answer を2回 post しても、ターンの入力は1回分しか出ない（#handle の最後の砦）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seedApproval());
    // 'reply' —— 1本目のターンが終わって初めて、待ち行列の2件目が
    // `#handle` へ渡る。ここが畳まれることを確かめたいので、待たせて
    // 止めてしまう 'hang' は使わない。
    const { clone, inputs } = bootClone(stores, 'reply');

    // `answerApproval` を経由せず、`#handle` の重複排除そのものを直接
    // 確かめる——`post()` を2回呼ぶだけで、同じ id の合図が待ち行列へ
    // 2回積まれることは `#foldIntoPendingCollapse` の doc で確認済み
    // （`human_answer` は畳み込みの鍵を持たない型なので常に 'pass'）。
    const event: InboxEvent = {
      type: 'human_answer',
      id: 'human-answer-ap-1-2026-09-01T00:05:00.000Z',
      at: '2026-09-01T00:05:00.000Z',
      approvalId: 'ap-1',
      answer: '許可します',
    };
    clone.post(event);
    clone.post({ ...event });

    await waitFor(() => inputs.length > 0, '1本目のターンが起きる');
    // 2件目が待ち行列に残っていれば、'reply' なので放っておけば処理される
    // ——畳まれていれば `#runTurn` を一度も呼ばないので、ここで待っても
    // `inputs` は増えない。
    await idle();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('質問: 本番のマイグレーションを走らせてよいか');
    expect(inputs[0]).toContain('回答: 許可します');

    await clone.stop();
  });
});

/**
 * issue #1999（#1977 の残り）: `answerApproval` の途中（承認の行を `'pending'` で書いた後、
 * 許可の記録を終える前）で落ちると、人間が定型文で同意した許可の記録は作られない。
 * #1977 の拾い直しは合図の配達だけを拾い直していたので、次の起動でも作られなかった。
 *
 * ここでは、拾い直しのときに許可の記録の前提（定型文の回答・経路がアカウント・
 * `permissionRequest` がある）を満たし、かつその `approvalId` の許可の記録がまだ無い
 * 承認についてだけ、許可を記録し直すことを見る。在れば二重にしない。前提を満たさない
 * 承認では記録しない。
 */
describe('回答済みで未配達の承認の拾い直しは、作られなかった許可の記録も作り直す（issue #1999）', () => {
  const PERMISSION_REQUEST = {
    rule: 'Bash(pnpm test:*)',
    allows: ['pnpm test'],
    denies: ['rm -rf /'],
  };

  function consentedPendingRow(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return seedApproval({
      permissionRequest: PERMISSION_REQUEST,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: '許可します',
      answeredVia: { kind: 'account', accountId: 'acct-1' },
      answerDelivery: 'pending',
      ...overrides,
    } as Partial<PendingApproval>);
  }

  it('定型文でアカウントから同意した承認の許可の記録が無ければ、起動時に作る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(consentedPendingRow());

    const { clone } = bootClone(stores, 'hang');
    await waitFor(() => true, '起動');
    await waitFor(
      async () => (await stores.permissionGrants.list()).length > 0,
      '許可の記録が作られる',
    );

    const grants = await stores.permissionGrants.list();
    expect(grants.map((grant) => ({ approvalId: grant.approvalId, rule: grant.rule }))).toEqual([
      { approvalId: 'ap-1', rule: 'Bash(pnpm test:*)' },
    ]);

    void clone;
  });

  it('同じ approvalId の許可の記録が既に在れば、二重に作らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(consentedPendingRow());
    await stores.permissionGrants.put({
      id: 'grant-existing',
      rule: PERMISSION_REQUEST.rule,
      allows: PERMISSION_REQUEST.allows,
      denies: PERMISSION_REQUEST.denies,
      approvalId: 'ap-1',
      answer: '許可します',
      grantedAt: '2026-09-01T00:05:00.000Z',
      route: { principalKind: 'account', accountId: 'acct-1' },
    });

    const { clone } = bootClone(stores, 'hang');
    await waitFor(() => true, '起動');
    // 拾い直しが済むまで待つ（行が delivered になる）。
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'delivered',
      '拾い直しで行が delivered になる',
    );
    await idle();

    expect((await stores.permissionGrants.list()).map((grant) => grant.id)).toEqual([
      'grant-existing',
    ]);

    void clone;
  });

  it('対照: 定型文でない回答の承認は、拾い直しても許可の記録を作らない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(consentedPendingRow({ answer: 'はい' }));

    const { clone } = bootClone(stores, 'hang');
    await waitFor(
      async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'delivered',
      '拾い直しで行が delivered になる',
    );
    await idle();

    expect(await stores.permissionGrants.list()).toEqual([]);

    void clone;
  });

  // **人間のアカウントでない経路の回答では作らない。** operator の資格（認証を切った
  // 構成・実行環境の持ち主の token）はクローンの器から読めるので、人間の同意の証拠に
  // ならない（`host.ts` の `AnswerApprovalVia` / `#recordPermissionGrantIfConsented` の
  // doc）。定型文どおりの回答でも、経路が operator なら拾い直しで作らないことを見る。
  it.each([
    ['operator-token', { kind: 'operator', auth: 'operator-token' }],
    ['disabled', { kind: 'operator', auth: 'disabled' }],
  ] as const)(
    '対照: 経路が operator（%s）の回答は、定型文どおりでも拾い直しで許可の記録を作らない',
    async (_label, via) => {
      const stores = createMemoryStores();
      await stores.jobs.putApproval(consentedPendingRow({ answeredVia: via }));

      const { clone } = bootClone(stores, 'hang');
      await waitFor(
        async () => (await stores.jobs.getApproval('ap-1'))?.answerDelivery === 'delivered',
        '拾い直しで行が delivered になる',
      );
      await idle();

      expect((await stores.jobs.getApproval('ap-1'))?.answerDelivery).toBe('delivered');
      expect(await stores.permissionGrants.list()).toEqual([]);

      void clone;
    },
  );
});

/**
 * issue #2002（C の横断レビュー）: `answerApproval` で「配達済み」の印の書き込み
 * （`putApproval({ answerDelivery: 'delivered' })`）だけが落ちると、承認は `'pending'` の
 * まま残る。配った合図をクローンが処理し終えて受信箱から消した後にデーモンが起こし
 * 直されると、起動時の拾い直しが同じ回答をもう一度配っていた。二重配達を畳む
 * `#handledHumanAnswerIds` はメモリの中の Set なので、起こし直しで空になる。
 *
 * 直し: クローンが `human_answer` を処理するときに、行がまだ `'pending'` なら
 * `'delivered'` を書く。印の書き込みが2回とも落ちたときだけは、二重に届きうる
 * （少なくとも1回は届く。`#markAnswerDeliveredOnHandle` の doc）。
 */
describe('配達済みの印の書き込みだけが落ちても、起こし直しで同じ回答を配り直さない（issue #2002）', () => {
  it('印の書き込みを1回落とし、処理し終えてから起こし直しても、2つ目のクローンに回答は届かない', async () => {
    const base = createMemoryStores();
    let failedOnce = false;
    const jobs = new Proxy(base.jobs, {
      get(target, prop, receiver) {
        if (prop === 'putApproval') {
          return async (approval: PendingApproval) => {
            if (!failedOnce && approval.answerDelivery === 'delivered') {
              failedOnce = true;
              throw new Error('配達済みの印の書き込みが落ちた（テスト用）');
            }
            return target.putApproval(approval);
          };
        }
        // 「配達済み」の印は、#2007 のコメントの直しで `updateApproval`（読み直す1操作）
        // から書くようになった。落とす場所をそちらにも広げる——落とすのは、今までと同じく
        // 「pending の行を delivered にする1回目の書き込み」だけである。
        if (prop === 'updateApproval') {
          return async (id: string, mutate: (current: PendingApproval) => PendingApproval | null) =>
            target.updateApproval(id, (current) => {
              const next = mutate(current);
              if (
                !failedOnce &&
                current.answerDelivery === 'pending' &&
                next?.answerDelivery === 'delivered'
              ) {
                failedOnce = true;
                throw new Error('配達済みの印の書き込みが落ちた（テスト用）');
              }
              return next;
            });
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const stores: Stores = { ...base, jobs };
    await stores.jobs.putApproval(seedApproval());

    const first = bootClone(stores, 'reply');
    await first.clone.answerApproval('ap-1', '許可します');
    await waitFor(
      () => first.inputs.some((input) => input.includes('回答: 許可します')),
      '1つ目の処理',
    );
    // 処理し終えて受信箱から消えるまで待つ（`#forget`）。
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 0,
      '処理し終えて受信箱から消える',
    );
    expect(failedOnce).toBe(true);
    expect((await stores.inbox.peekPending()).entries).toEqual([]);

    // 起こし直し（同じストアで2つ目のクローン）。起動時刻より前に回答された行になるよう、
    // 1ミリ秒以上あける。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = bootClone(stores, 'reply');
    await idle();
    await idle();

    expect(second.inputs.filter((input) => input.includes('回答: 許可します'))).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answerDelivery).toBe('delivered');

    void second.clone;
  });
});

/**
 * issue #2007: 承認への回答（`answerApproval`）は、`getApproval` で読んでから
 * `putApproval` で丸ごと書き戻す形で、回答済み・取り下げ済みかを自分では見ていなかった。
 * そのため、取り下げ済みの承認にも回答が立って配達・再開まで進み、同じ承認への2回目の
 * 回答や、ほぼ同時の2つの回答も両方通っていた（同じ承認に紐づく仕事が2回再開しうる）。
 *
 * ここでは、既に終わった承認への回答は断られ、行も配達も動かないことを見る。
 */
describe('既に終わった承認への回答は断る（issue #2007）', () => {
  it('取り下げ済みの承認に回答すると断られ、行に回答が立たず、human_answer は配られない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(
      seedApproval({
        withdrawnAt: '2026-09-01T00:06:00.000Z',
        withdrawnReason: '判断が要らなくなった',
      }),
    );
    const { clone, inputs } = bootClone(stores, 'hang');

    await expect(clone.answerApproval('ap-1', '許可します')).rejects.toThrow();
    await idle();

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answeredAt).toBeUndefined();
    expect(approval?.answer).toBeUndefined();
    expect((await stores.inbox.peekPending()).entries).toEqual([]);
    expect(inputs).toHaveLength(0);
  });

  it('回答済みの承認に2回目の回答をすると断られ、1回目の回答が残り、配達は1回だけ', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seedApproval());
    const { clone, inputs } = bootClone(stores, 'hang');

    await clone.answerApproval('ap-1', '許可します');
    await waitFor(() => inputs.length > 0, '1回目の処理');
    await expect(clone.answerApproval('ap-1', 'やっぱりやめて')).rejects.toThrow();
    await idle();

    const approval = await stores.jobs.getApproval('ap-1');
    expect(approval?.answer).toBe('許可します');
    expect(inputs).toHaveLength(1);
  });

  it('2つの回答を同時に投げると、ちょうど1つだけが通り、もう1つは断られる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seedApproval());
    const { clone, inputs } = bootClone(stores, 'hang');

    const results = await Promise.allSettled([
      clone.answerApproval('ap-1', '許可します'),
      clone.answerApproval('ap-1', 'やめて'),
    ]);
    await waitFor(() => inputs.length > 0, '回答の処理');
    await idle();

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(inputs).toHaveLength(1);
  });
});

/**
 * issue #2007（C の3回目の横断レビューのコメント）: 「配達済み」の印を付ける書き込みは、
 * 読んだ写しに `answerDelivery: 'delivered'` を足して、行を丸ごと書き戻していた
 * （`#markAnswerDeliveredOnHandle` / `#reconcileUndeliveredAnswers` / `answerApproval`）。
 * 読んでから書くまでの間に同じ行へ別の書き込みが入ると、古い写しでそれを消していた。
 *
 * ここでは、`#handle` が承認を読んだ直後に、同じ行へ別の書き込み（取り下げの印）が
 * 入る場面を作り、印を付けた後もその書き込みが残ることを見る。
 */
describe('配達済みの印は、読んだ写しで行を丸ごと書き戻さない（issue #2007 のコメント）', () => {
  it('#handle が行を読んだ直後に入った別の書き込みを、配達済みの印で消さない', async () => {
    const base = createMemoryStores();
    await base.jobs.putApproval(
      seedApproval({
        answeredAt: '2999-01-01T00:05:00.000Z',
        answer: '許可します',
        answerDelivery: 'pending',
      }),
    );
    let interleaved = false;
    const jobs = new Proxy(base.jobs, {
      get(target, prop, receiver) {
        if (prop === 'getApproval') {
          return async (id: string) => {
            const snapshot = await target.getApproval(id);
            // 最初に読まれた直後に、同じ行へ別の書き込みを入れる（読んだ写しは古くなる）。
            if (!interleaved && snapshot !== null) {
              interleaved = true;
              await target.putApproval({
                ...snapshot,
                withdrawnAt: '2999-01-01T00:06:00.000Z',
                withdrawnReason: '同時に入った別の書き込み（テスト用）',
              });
            }
            return snapshot;
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const stores: Stores = { ...base, jobs };
    const { clone, inputs } = bootClone(stores, 'hang');

    clone.post({
      type: 'human_answer',
      id: expectedHumanAnswerEventId('ap-1', '2999-01-01T00:05:00.000Z'),
      at: '2999-01-01T00:05:00.000Z',
      approvalId: 'ap-1',
      answer: '許可します',
    } as unknown as InboxEvent);
    await waitFor(() => inputs.length > 0, '回答の処理');
    await idle();

    const approval = await base.jobs.getApproval('ap-1');
    expect(interleaved).toBe(true);
    expect(approval?.withdrawnAt).toBe('2999-01-01T00:06:00.000Z');
  });
});

describe('枠で保持した human_answer の再配達（issue #2744）', () => {
  const spendLimitMessage = "You've hit your individual spend limit for this account.";

  it('回答のターンが枠で失敗して保持されても、解除後の再配達でターンが起き、二重配達として捨てられない', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval(seedApproval());
    // 1ターン目（回答の初回）だけ枠で失敗させ、以降は成功させる。
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 1 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    });

    await s.clone.answerApproval('ap-1', '許可します');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '回答の初回のターンが起きる');
    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.some((p) => p.event.type === 'human_answer');
    }, '枠で失敗した human_answer が未読のまま保持される');

    // 次の合図の到着が解除の試行を起こす。保持した human_answer が先頭へ戻る。
    s.clone.post(humanMessage('次の合図'));

    // 回答の本文を含む入力が2回（初回の失敗 + 再配達）SDK へ渡ること。
    await waitFor(
      () =>
        (s.calls[0]?.inputs.filter((text) => text.includes('回答: 許可します')).length ?? 0) >= 2,
      '保持した human_answer の再配達でターンが起きる',
    );

    await s.clone.stop();
  });
});
