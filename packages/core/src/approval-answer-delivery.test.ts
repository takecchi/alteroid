import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, PendingApproval } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

    const pending = await stores.inbox.peekPending();
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
    expect(await stores.inbox.peekPending()).toEqual([]);

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

    const pending = await stores.inbox.peekPending();
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
    expect(await stores.inbox.peekPending()).toEqual([]);

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
    expect(await stores.inbox.peekPending()).toEqual([]);

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
    expect(await stores.inbox.peekPending()).toEqual([]);

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
