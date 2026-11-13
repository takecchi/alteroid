import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakeGatedSdk,
  fakeSdk,
  flushPendingMicrotasks,
  setup,
  waitFor,
  waitForDone,
  wireEvents,
} from './clone-test-harness.js';
import { createClone } from './clone.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent, Job, Task } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';

// `Clone` の「Task の取り込み」の殻（`#openHumanTask`・`#taskQueueNoticeFor`・`#waitingReplyLinesFor`・`#taskQueueNotice`、
// 状態は `#taskOpens`・`#humanTaskFailures`）を、`createClone` 経由で固定する。モデルへ渡る入力・日誌・stderr・Task ストアの状態を観測する。
// 切り出し（`clone-task-intake.ts`）の前に置いた。全文の期待は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で
// 生成して目で読んで確かめた値である。「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 積んだ／積めなかった行・待ち行列の見出し・返事待ちの行の逐語は `clone-turn-input-text-pin.test.ts`・`clone-waiting-reply-notice.test.ts` が持つ。
// ここが足すのは、既存の試験が縛っていない枝: 失敗の日誌・stderr の全文、失敗を控えて 1 回だけ名乗って外すこと、
// `#taskOpens` を待つ 3 箇所（断り書き・取り下げ・返答の終わり）、返事待ちの読み出しが投げた回の握り方、蒸留のターンには載せないこと。
// 時刻は `Date` だけを止める（タイマーは本物のまま。実時間の待ちは足さない。「まだ起きていない」は microtask を進めて見る）。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';
const QUEUE_HEAD = '[system] 待ち行列（';
const NOTICE_END = '\n\n---\n';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

/** `add` を、id が合うものだけ投げさせる。 */
function failingAdd(
  stores: Stores,
  pattern: RegExp,
  error: Error = new Error('台帳が書けない'),
): Stores {
  return {
    ...stores,
    tasks: {
      ...stores.tasks,
      add: async (entry, placement) => {
        if (pattern.test(entry.id)) throw error;
        return stores.tasks.add(entry, placement);
      },
    },
  };
}

/** `add` を、id が合うものだけ `release`（成功）／`fail`（失敗）まで止める。 */
function gatedAdd(
  stores: Stores,
  pattern: RegExp,
): { stores: Stores; release: () => void; fail: (error: Error) => void } {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  gate.catch(() => undefined);
  return {
    stores: {
      ...stores,
      tasks: {
        ...stores.tasks,
        add: async (entry, placement) => {
          if (pattern.test(entry.id)) await gate;
          return stores.tasks.add(entry, placement);
        },
      },
    },
    release: () => release(),
    fail: (error) => fail(error),
  };
}

function gatedClone(stores: Stores, mergedBatchLimit?: number) {
  const gated = fakeGatedSdk();
  const clone = createClone({
    stores,
    queryFn: gated.fn,
    env: {},
    ...(mergedBatchLimit === undefined ? {} : { mergedBatchLimit }),
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events, waitForEvents } = wireEvents(clone, 'conv-1');
  const inputs = (): string[] => gated.calls[0]?.inputs ?? [];
  return { ...gated, clone, events, waitForEvents, inputs };
}

const doneCount = (events: readonly { type: string }[]): number =>
  events.filter((event) => event.type === 'done').length;

/** 断り書きの待ち行列の節（見出しから `---` の行まで）。 */
function noticeOf(input: string): string {
  const start = input.indexOf(QUEUE_HEAD);
  expect(start).toBeGreaterThanOrEqual(0);
  return input.slice(start, input.indexOf(NOTICE_END, start) + NOTICE_END.length);
}

async function failureRows(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  return rows.flatMap((row) =>
    row.type === 'exchange' && row.text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX)
      ? [`${row.with}/${row.role}: ${row.text}`]
      : [],
  );
}

describe('取り込みの失敗（#openHumanTask）の日誌・stderr・Task', () => {
  it('積めなかった発言: 日誌に failure の 1 行（全文）、stderr に 1 行、Task は積まれない。ターンは落ちない', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/, new Error('台帳が書けない'));
    const s = setup(undefined, stores);
    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('ng-one'));
      await waitForDone(s.events);
    });
    const rows = await failureRows(stores);
    await s.clone.stop();

    expect(rows).toMatchInlineSnapshot(`
      [
        "self/outbound: [障害] 人間の依頼を Task として積めなかった（id: evt-ng-one）。必要なら \`task_add\` で載せ直すこと（理由: Error: 台帳が書けない）。",
      ]
    `);
    expect(stderr.filter((line) => line.includes('Task の自動起票'))).toMatchInlineSnapshot(`
      [
        "alteroid: 2026-11-01T09:00:00.000Z Task の自動起票を記録できませんでした（human_message chars=6）: Error: 台帳が書けない
      ",
      ]
    `);
    expect((await stores.tasks.list({ includeClosed: true })).entries).toEqual([]);
  });

  it('理由は reasonOf を通る（複数行の理由は 1 行目へ畳まれる）', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/, new Error('一行目の理由\n二行目の詳細'));
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('ng-multi'));
    await waitForDone(s.events);
    const rows = await failureRows(stores);
    await s.clone.stop();

    expect(rows).toMatchInlineSnapshot(`
      [
        "self/outbound: [障害] 人間の依頼を Task として積めなかった（id: evt-ng-multi）。必要なら \`task_add\` で載せ直すこと（理由: Error: 一行目の理由）。",
      ]
    `);
  });

  it('積めた発言は失敗の行を書かず、stderr にも出さない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores);
    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('ok-one'));
      await waitForDone(s.events);
    });
    const rows = await failureRows(stores);
    await s.clone.stop();

    expect(rows).toEqual([]);
    expect(stderr.filter((line) => line.includes('Task の自動起票'))).toEqual([]);
    // 返答したターンの終わりに自動で done になるので、閉じたものも数える
    const { entries } = await stores.tasks.list({ includeClosed: true });
    expect(entries.map((task) => task.id)).toEqual(['evt-ok-one']);
  });

  it('起票の行: createdAt は合図の at、updatedAt は取り込んだ時点の Date（止めた時刻）。返答で閉じる前に読む', async () => {
    const stores = createMemoryStores();
    const t = gatedClone(stores);
    const at = '2026-10-01T00:00:00.000Z';
    t.clone.post({ ...humanMessage('起票の時刻'), at } as InboxEvent);
    await waitFor(() => t.inputs().length === 1, 'ターンが投げられる');
    const { entries } = await stores.tasks.list();
    t.release();
    await t.clone.stop();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'evt-起票の時刻', createdAt: at, updatedAt: FROZEN_AT });
  });
});

describe('失敗を控えて、その発言を読むターンの断り書きで 1 回だけ名乗って外す（#humanTaskFailures）', () => {
  it('次のターンには、同じ失敗の行は出ない（積んだ行だけが出る）', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/);
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('ng-one'));
    await s.waitForEvents((events) => doneCount(events) >= 1);
    s.clone.post(humanMessage('ok-two'));
    await s.waitForEvents((events) => doneCount(events) >= 2);
    const first = s.calls[0]?.inputs[0] ?? '';
    const second = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(first).toContain('Task として積めなかった（id: `evt-ng-one`）');
    expect(second).not.toContain('積めなかった');
    expect(second).toContain('いま届いたこの一件は task `evt-ok-two` として積んだ');
  });

  it('外した後に、同じ id の再配達が積めたら、積んだ行が出る（外し忘れた失敗を名乗らない）', async () => {
    const base = createMemoryStores();
    let failNext = true;
    const stores: Stores = {
      ...base,
      tasks: {
        ...base.tasks,
        add: async (entry, placement) => {
          if (failNext) {
            failNext = false;
            throw new Error('1 回目だけ書けない');
          }
          return base.tasks.add(entry, placement);
        },
      },
    };
    const s = setup(undefined, stores);
    const event = humanMessage('再配達');
    s.clone.post(event);
    await s.waitForEvents((events) => doneCount(events) >= 1);
    s.clone.post(event);
    await s.waitForEvents((events) => doneCount(events) >= 2);
    const first = s.calls[0]?.inputs[0] ?? '';
    const second = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(first).toContain('Task として積めなかった（id: `evt-再配達`）');
    expect(second).toContain('いま届いたこの一件は task `evt-再配達` として積んだ');
    expect(second).not.toContain('積めなかった');
  });

  it('その発言を読まない先のターンでは外さない: 束の上限で後ろへ回った発言の失敗は、読むターンで名乗る', async () => {
    const stores = failingAdd(createMemoryStores(), /ng/);
    const t = gatedClone(stores, 2);
    t.clone.post(humanMessage('先客'));
    await waitFor(() => t.inputs().length === 1, '先客のターンが投げられる');
    for (const text of ['ng-a', 'ng-b', 'ng-c']) t.clone.post(humanMessage(text));
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 4,
      '4 件が器に載る',
    );
    await flushPendingMicrotasks();
    t.release();
    await waitFor(() => t.inputs().length === 3, '束が 2 本に割れて 3 ターンになる');
    await t.waitForEvents((events) => doneCount(events) >= 3);
    const [, second = '', third = ''] = t.inputs();
    await t.clone.stop();

    expect(second).toContain('Task として積めなかった（id: `evt-ng-a`, `evt-ng-b`）');
    expect(second).not.toContain('evt-ng-c');
    expect(third).toContain('Task として積めなかった（id: `evt-ng-c`）');
    expect(third).not.toContain('evt-ng-a');
  });
});

describe('取り込み中の Task を待つ（#taskOpens）', () => {
  it('断り書きは、取り込みが済むまでターンの入力を出さず、済んだ後の件数を名乗る', async () => {
    const gated = gatedAdd(createMemoryStores(), /pending/);
    const s = setup(undefined, gated.stores);
    s.clone.post(humanMessage('pending-one'));
    await flushPendingMicrotasks();
    expect(s.calls[0]?.inputs ?? []).toEqual([]);

    gated.release();
    await waitForDone(s.events);
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).toContain(
      '- 待ち行列: 開いている 1 件（queued 1 / waiting 0 / needs_decision 0）',
    );
    expect(noticeOf(input)).toContain('いま届いたこの一件は task `evt-pending-one` として積んだ');
  });

  it('取り込みが失敗で終わっても待ちは解け、その失敗を名乗る（失敗を控えるのは待ちが解ける前）', async () => {
    const gated = gatedAdd(createMemoryStores(), /pending/);
    const s = setup(undefined, gated.stores);
    s.clone.post(humanMessage('pending-one'));
    await flushPendingMicrotasks();
    expect(s.calls[0]?.inputs ?? []).toEqual([]);

    gated.fail(new Error('途中で書けなくなった'));
    await waitForDone(s.events);
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).toContain('Task として積めなかった（id: `evt-pending-one`）');
    expect(noticeOf(input)).not.toContain('として積んだ');
  });

  it('取り下げは、取り込み中の Task が済むのを待ってから閉じる（閉じ損ねない）', async () => {
    const gated = gatedAdd(createMemoryStores(), /evt-B/);
    const stores = gated.stores;
    const t = gatedClone(stores);
    const A = { ...humanMessage('先客', 'conv-a'), id: 'evt-A', clientMessageId: 'cm-a' };
    const B = { ...humanMessage('取り下げる', 'conv-b'), id: 'evt-B', clientMessageId: 'cm-b' };
    t.clone.post(A as InboxEvent);
    await waitFor(() => t.inputs().length === 1, '先客のターンが始まる');
    t.clone.post(B as InboxEvent);
    await waitFor(
      async () => (await stores.inbox.peekPending()).entries.length === 2,
      '2 件が器に載る',
    );

    let settled = false;
    const withdrawing = t.clone.interruptTurn!({
      conversationId: 'conv-b',
      clientMessageId: 'cm-b',
    });
    void withdrawing.then(() => {
      settled = true;
    });
    await flushPendingMicrotasks();
    expect(settled).toBe(false);

    gated.release();
    await expect(withdrawing).resolves.toBe('withdrawn');
    const { entries } = await stores.tasks.list({ includeClosed: true });
    t.release();
    await t.clone.stop();

    expect(entries.find((task) => task.id === 'evt-B')).toMatchObject({
      status: 'cancelled',
      closedBy: 'human',
    });
    expect(entries.find((task) => task.id === 'evt-A')?.status).toBe('queued');
  });

  it('返答のターンの終わりは、取り込み中の Task が済むまで done にならない（取り逃がさない）', async () => {
    const gated = gatedAdd(createMemoryStores(), /evt-late/);
    const t = gatedClone(gated.stores);
    t.clone.post(humanMessage('先客'));
    await waitFor(() => t.inputs().length === 1, '先客のターンが始まる');
    t.clone.post({ ...humanMessage('遅れて届く', 'conv-late'), id: 'evt-late' } as InboxEvent);
    await flushPendingMicrotasks();

    t.release();
    await flushPendingMicrotasks();
    expect(doneCount(t.events)).toBe(0);

    gated.release();
    await t.waitForEvents((events) => doneCount(events) >= 1);
    await t.clone.stop();
  });
});

describe('返事待ちの task の読み出し（#waitingReplyLinesFor）が投げた回の握り方', () => {
  const AT = '2026-10-29T00:00:00.000Z';
  const waitingTask: Task = {
    id: 'w1',
    createdAt: AT,
    updatedAt: AT,
    status: 'waiting',
    origin: 'self',
    title: '返事待ち-w1',
    body: 'body-w1',
    originConversationId: 'conv-1',
  };
  const WAITING_MARK = '返事待ち（waiting）の task:';

  it('台帳を読めなければ返事待ちの行だけ落とし、断り書きの他の行は残す。stderr に残す', async () => {
    const base = createMemoryStores();
    await base.tasks.add(waitingTask);
    let calls = 0;
    const stores: Stores = {
      ...base,
      tasks: {
        ...base.tasks,
        list: async (...args) => {
          calls += 1;
          // 1 回目は待ち行列の読み出し、2 回目が返事待ちの読み出し
          if (calls === 2) throw new Error('2 回目の台帳読みで落ちた');
          return base.tasks.list(...args);
        },
      },
    };
    const s = setup(undefined, stores);
    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('返事です'));
      await waitForDone(s.events);
    });
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).not.toContain(WAITING_MARK);
    expect(noticeOf(input)).toContain('いま届いたこの一件は task `evt-返事です` として積んだ');
    expect(noticeOf(input)).toContain('全部は task_list）');
    expect(noticeOf(input)).not.toContain('全文は `task_list`');
    expect(stderr.filter((line) => line.includes('返事待ちの task の断り書き')))
      .toMatchInlineSnapshot(`
      [
        "alteroid: 2026-11-01T09:00:00.000Z 返事待ちの task の断り書きを記録できませんでした（waiting-reply）: Error: 2 回目の台帳読みで落ちた
      ",
      ]
    `);
  });

  /**
   * 委譲の一覧の読みを、ターンの入力が出る前（= `#prepareTurn` の中）のものだけ数える（返事の後の自動 done も読むため）。
   * `failBeforeInput` なら、その読みは投げる。
   */
  function probeJobReads(
    base: Stores,
    inputsSeen: () => number,
    failBeforeInput: boolean,
  ): { stores: Stores; readsBeforeInput: () => number } {
    let reads = 0;
    return {
      readsBeforeInput: () => reads,
      stores: {
        ...base,
        jobs: {
          ...base.jobs,
          listJobs: async (...args: Parameters<Stores['jobs']['listJobs']>) => {
            if (inputsSeen() === 0) {
              reads += 1;
              if (failBeforeInput) throw new Error('委譲の台帳が壊れている');
            }
            return base.jobs.listJobs(...args);
          },
        },
      },
    };
  }

  it('委譲の一覧を読めなければ返事待ちの行だけ落とし、断り書きの他の行は残す。stderr に残す', async () => {
    const base = createMemoryStores();
    await base.tasks.add(waitingTask);
    let inputsSeen = (): number => 0;
    const probe = probeJobReads(base, () => inputsSeen(), true);
    const s = setup(undefined, probe.stores);
    inputsSeen = () => s.calls[0]?.inputs.length ?? 0;
    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('返事です'));
      await waitForDone(s.events);
    });
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).not.toContain(WAITING_MARK);
    expect(noticeOf(input)).toContain('いま届いたこの一件は task `evt-返事です` として積んだ');
    expect(noticeOf(input)).toContain('全部は task_list）');
    expect(noticeOf(input)).not.toContain('全文は `task_list`');
    expect(stderr.filter((line) => line.includes('返事待ちの task の断り書き')))
      .toMatchInlineSnapshot(`
      [
        "alteroid: 2026-11-01T09:00:00.000Z 返事待ちの task の断り書きを記録できませんでした（waiting-reply）: Error: 委譲の台帳が壊れている
      ",
      ]
    `);
  });

  it('該当（その会話を起点にした waiting）が無ければ、委譲の一覧は読まない。ある回は 1 回読む', async () => {
    const readsFor = async (conversationId: string): Promise<number> => {
      const base = createMemoryStores();
      await base.tasks.add(waitingTask);
      let inputsSeen = (): number => 0;
      const probe = probeJobReads(base, () => inputsSeen(), false);
      const s = setup(undefined, probe.stores);
      inputsSeen = () => s.calls[0]?.inputs.length ?? 0;
      s.clone.post(humanMessage('返事です', conversationId));
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '入力が出る');
      const reads = probe.readsBeforeInput();
      await s.clone.stop();
      return reads;
    };

    // 入力が出る前の読みには他の読み手（要約など）も居るので、差で見る: 該当のある回だけ、返事待ちの読み出しの分が 1 回増える
    const without = await readsFor('conv-other');
    const withCandidate = await readsFor('conv-1');
    expect(withCandidate - without).toBe(1);
  });

  it('人間の発言を含まない束（報告）は、返事待ちのために台帳を読まない。人間の発言の束は 1 回多く読む', async () => {
    const listReadsBeforeInput = async (event: InboxEvent): Promise<number> => {
      const base = createMemoryStores();
      let reads = 0;
      let inputsSeen = (): number => 0;
      const stores: Stores = {
        ...base,
        tasks: {
          ...base.tasks,
          list: async (...args) => {
            if (inputsSeen() === 0) reads += 1;
            return base.tasks.list(...args);
          },
        },
      };
      const s = setup(undefined, stores);
      inputsSeen = () => s.calls[0]?.inputs.length ?? 0;
      s.clone.post(event);
      await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '入力が出る');
      const count = reads;
      await s.clone.stop();
      return count;
    };
    const report: InboxEvent = {
      type: 'manager_message',
      id: 'evt-report',
      at: FROZEN_AT,
      managerId: 'mgr-T',
      kind: 'report',
      text: '本文',
    };

    const human = await listReadsBeforeInput(humanMessage('人間の発言', 'conv-other'));
    const reported = await listReadsBeforeInput(report);
    expect(human - reported).toBe(1);
  });

  it('待ち行列を読めない回は、stderr に残す（0 件と書かない断りと別に、跡を残す）', async () => {
    const base = createMemoryStores();
    const stores: Stores = {
      ...base,
      tasks: {
        ...base.tasks,
        list: async () => {
          throw new Error('task 台帳が壊れている');
        },
      },
    };
    const s = setup(undefined, stores);
    const stderr = await captureStderr(async () => {
      s.clone.post(humanMessage('読めない'));
      await waitForDone(s.events);
    });
    await s.clone.stop();

    expect(stderr.filter((line) => line.includes('待ち行列の読み出し'))).toMatchInlineSnapshot(`
      [
        "alteroid: 2026-11-01T09:00:00.000Z 待ち行列の読み出しを記録できませんでした（human_message chars=4）: Error: task 台帳が壊れている
      ",
      ]
    `);
  });

  it('走っていない委譲なら返事待ちの行は出る（読み出しが通る回の対照）', async () => {
    const base = createMemoryStores();
    await base.tasks.add(waitingTask);
    const finished: Job = {
      id: 'job-1',
      createdAt: AT,
      updatedAt: AT,
      status: 'done',
      conversationId: 'conv-1',
      summary: 's',
      taskId: 'w1',
    };
    const stores: Stores = {
      ...base,
      jobs: { ...base.jobs, listJobs: async () => [finished] },
    };
    const s = setup(undefined, stores);
    s.clone.post(humanMessage('返事です'));
    await waitForDone(s.events);
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(noticeOf(input)).toContain(WAITING_MARK);
  });
});

describe('待ち行列の断り書きの枝（#taskQueueNoticeFor）', () => {
  it('蒸留のターンには待ち行列の節を載せない（Task が開いていても）', async () => {
    const s = setup();
    s.clone.post(humanMessage('1回目'));
    await s.waitForEvents((events) => doneCount(events) >= 1);
    s.clone.post({
      type: 'distill',
      id: 'evt-tidy-1',
      at: new Date().toISOString(),
      reason: 'scheduled',
    });
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '棚卸しのターン');
    const first = s.calls[0]?.inputs[0] ?? '';
    const distill = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(first).toContain(QUEUE_HEAD);
    expect(distill).toContain('定期の棚卸しの刻みが来た');
    expect(distill).not.toContain(QUEUE_HEAD);
    expect(distill).not.toContain('全文は `task_list`');
  });

  it('報告の回（Task を積まない回）は、積んだ行も積めなかった行も無く、先頭だけが出る（末尾の再掲は無い）', async () => {
    const s = setup();
    s.clone.post(humanMessage('1回目'));
    await s.waitForEvents((events) => doneCount(events) >= 1);
    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-T',
      kind: 'report',
      text: '本文',
    });
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '報告のターン');
    const report = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(noticeOf(report)).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）

      ---
      "
    `);
  });
});
