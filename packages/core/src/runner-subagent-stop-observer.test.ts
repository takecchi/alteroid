import { describe, expect, it } from 'vitest';

import type { AgentSubagentStopRecord } from './agent-hooks.js';
import type { RunnerBackgroundWaiters } from './runner-background-waiters.js';
import type { RunnerEvent } from './runner-protocol.js';
import { RunnerSubagentStopObserver } from './runner-subagent-stop.js';
import {
  RunnerSubagentStopState,
  SUBAGENT_BACKGROUND_WAIT_MS,
} from './runner-subagent-stop-state.js';

// `RunnerSubagentStopObserver#observe`（`RunnerSession#onSubagentStop` を切り出したもの）を、口を偽物にして直に縛る。
// 外から（runner を通して）は見えない差を縛るのが目的: 口（`workerTools.settleAgent`・`tryObservation`・`stopState` の各メソッド・`sdkSession`・
// `cutOffWorkers.recordCutOff`・`note`・`emit`・`resumeGuidance`）を呼ぶ順と回数・結果が Promise であること・
// 各口が同期で投げたときの握り方（`catch` で受けて `continue` へ倒す／先頭の片付けだけは `try` の外）・
// `waitForBackgroundTasks` の 3 通りの結果（released／settled／timeout）を偽の `backgroundWaiters` で作り分けること・
// `stopState`／`sdkSession` が参照のまま使われること（getter は呼ぶたびに読む）・await を足さない／外さないこと。
// note の全文・欄ごとの値は `runner-subagent-stop-pin.test.ts`（切り出し前の作りの出力）が縛っている。
// 期待の値は、切り出し後の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで置いた（仕様を先に書いたものではない）。
// 実時間では待たない（待つのはマイクロタスクの周回だけ。待ちは偽の `backgroundWaiters` が決める）。

type WaitOutcome = 'settled' | 'timeout' | 'released';

interface Options {
  /** 所有者の表に最初から載せる（`taskId → agentId`）。 */
  owners?: Record<string, string>;
  /** 偽の待ち。省略時は 'settled' を返す。`check` を 1 回呼んでから決める（呼び出しの記録のため）。 */
  wait?: (check: () => boolean, timeoutMs: number) => Promise<WaitOutcome>;
  finished?: Record<string, string | null>;
  live?: { id: string; taskType: string }[];
  stopped?: boolean;
  generation?: number;
  note?: (text: string) => void;
  emit?: (event: RunnerEvent) => void;
  settleAgent?: (agentId: string) => void;
  tryObservation?: (label: string, fn: () => void) => void;
  resumeGuidance?: (agentId: string) => string;
  recordCutOff?: (agentId: string, tasks: readonly unknown[]) => void;
  stopStateOverride?: Partial<Record<'recordSubagentWakeup' | 'subagentWakeupTotal', () => never>>;
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const events: RunnerEvent[] = [];
  const cutOffs: { agentId: string; tasks: readonly unknown[] }[] = [];
  const waits: { timeoutMs: number; checkResult: boolean }[] = [];
  const real = new RunnerSubagentStopState();
  for (const [id, owner] of Object.entries(options.owners ?? {})) {
    real.setBackgroundTaskOwner(id, owner, 'sleep 90');
  }
  const sdk = {
    stopped: options.stopped ?? false,
    generation: options.generation ?? 0,
    live: options.live ?? [],
  };
  const finished = options.finished ?? {};
  const observer = new RunnerSubagentStopObserver({
    workerTools: {
      settleAgent: (agentId) => {
        calls.push(`settleAgent:${agentId}`);
        options.settleAgent?.(agentId);
      },
    },
    tryObservation:
      options.tryObservation ??
      ((label, fn) => {
        calls.push(`tryObservation:${label}`);
        try {
          fn();
        } catch {
          // 本物の `tryObservation` と同じく握る
        }
      }),
    stopState: {
      backgroundTaskOwner: (id) => {
        calls.push(`backgroundTaskOwner:${id}`);
        return real.backgroundTaskOwner(id);
      },
      backgroundTaskCommand: (id) => {
        calls.push(`backgroundTaskCommand:${id}`);
        return real.backgroundTaskCommand(id);
      },
      hasBackgroundTaskOwner: (id) => {
        calls.push(`hasBackgroundTaskOwner:${id}`);
        return real.hasBackgroundTaskOwner(id);
      },
      get ownerLookupFailureNoted() {
        calls.push('ownerLookupFailureNoted');
        return real.ownerLookupFailureNoted;
      },
      markOwnerLookupFailureNoted: () => {
        calls.push('markOwnerLookupFailureNoted');
        real.markOwnerLookupFailureNoted();
      },
      get settledOnlyNoted() {
        calls.push('settledOnlyNoted');
        return real.settledOnlyNoted;
      },
      markSettledOnlyNoted: () => {
        calls.push('markSettledOnlyNoted');
        real.markSettledOnlyNoted();
      },
      recordSubagentWakeup: (agentId) => {
        calls.push(`recordSubagentWakeup:${agentId}`);
        if (options.stopStateOverride?.recordSubagentWakeup !== undefined) {
          options.stopStateOverride.recordSubagentWakeup();
        }
        return real.recordSubagentWakeup(agentId);
      },
      subagentWakeupTotal: (agentId) => {
        calls.push(`subagentWakeupTotal:${agentId}`);
        if (options.stopStateOverride?.subagentWakeupTotal !== undefined) {
          options.stopStateOverride.subagentWakeupTotal();
        }
        return real.subagentWakeupTotal(agentId);
      },
      recordSubagentLimitReachedNote: (agentId) => {
        calls.push(`recordSubagentLimitReachedNote:${agentId}`);
        return real.recordSubagentLimitReachedNote(agentId);
      },
    },
    sdkSession: {
      get stopped() {
        calls.push('stopped');
        return sdk.stopped;
      },
      get generation() {
        calls.push('generation');
        return sdk.generation;
      },
      get liveBackgroundTasks() {
        calls.push('liveBackgroundTasks');
        return sdk.live;
      },
      get backgroundWaiters(): Pick<
        RunnerBackgroundWaiters,
        'wait' | 'isFinished' | 'outputFileOf'
      > {
        calls.push('backgroundWaiters');
        return {
          wait: (check, timeoutMs) => {
            calls.push('wait');
            waits.push({ timeoutMs, checkResult: check() });
            return (options.wait ?? (() => Promise.resolve('settled')))(check, timeoutMs);
          },
          isFinished: (id) => {
            calls.push(`isFinished:${id}`);
            return id in finished;
          },
          outputFileOf: (id) => {
            calls.push(`outputFileOf:${id}`);
            return finished[id] ?? null;
          },
        };
      },
    },
    cutOffWorkers: {
      recordCutOff: (agentId, tasks = []) => {
        calls.push(`recordCutOff:${agentId}`);
        cutOffs.push({ agentId, tasks });
        options.recordCutOff?.(agentId, tasks);
      },
    },
    note:
      options.note ??
      ((text) => {
        calls.push('note');
        notes.push(text);
      }),
    emit:
      options.emit ??
      ((event) => {
        calls.push('emit');
        events.push(event);
      }),
    managerId: 'mgr-fake',
    resumeGuidance: (agentId) => {
      calls.push(`resumeGuidance:${agentId}`);
      return options.resumeGuidance?.(agentId) ?? `案内(${agentId})`;
    },
  });
  return { observer, calls, notes, events, cutOffs, waits, sdk, real };
}

const shell = (id: string, status = 'running', extra: Record<string, unknown> = {}) => ({
  id,
  type: 'shell',
  status,
  description: 'd',
  ...extra,
});

const record = (extra: Partial<AgentSubagentStopRecord> = {}): AgentSubagentStopRecord => ({
  agentId: 'agent-1',
  agentType: 'worker',
  stopHookActive: false,
  backgroundTasks: [],
  sessionCrons: [],
  ...extra,
});

const CONTINUE = { kind: 'continue' } as const;

describe('口を呼ぶ順と回数', () => {
  it('当人の分が無い（診断）の回: settleAgent の片付けが先頭、所有者を引いて、診断の旗 → hasBackgroundTaskOwner → 旗を立てる → note。2 回目は旗の確認で止まる', async () => {
    const h = harness();
    const input = record({ backgroundTasks: [shell('x')] });
    const first = await h.observer.observe(input);
    const firstCalls = [...h.calls];
    h.calls.length = 0;
    const second = await h.observer.observe(input);
    expect({ first, second, firstCalls, secondCalls: h.calls }).toMatchInlineSnapshot(`
      {
        "first": {
          "kind": "continue",
        },
        "firstCalls": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:x",
          "ownerLookupFailureNoted",
          "hasBackgroundTaskOwner:x",
          "markOwnerLookupFailureNoted",
          "note",
        ],
        "second": {
          "kind": "continue",
        },
        "secondCalls": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:x",
          "ownerLookupFailureNoted",
        ],
      }
    `);
  });

  it('終わった側だけの回: 旗 → 旗を立てる → note。2 回目は note まで進まない', async () => {
    const h = harness({ owners: { a: 'agent-1' } });
    const input = record({ backgroundTasks: [shell('a', 'completed')] });
    await h.observer.observe(input);
    const first = [...h.calls];
    h.calls.length = 0;
    await h.observer.observe(input);
    expect({ first, second: h.calls, notes: h.notes.length }).toMatchInlineSnapshot(`
      {
        "first": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:a",
          "settledOnlyNoted",
          "markSettledOnlyNoted",
          "note",
        ],
        "notes": 1,
        "second": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:a",
          "settledOnlyNoted",
        ],
      }
    `);
  });

  it('settled の回: 待ち（stopped → generation → backgroundWaiters → wait → stopped → generation）→ recordSubagentWakeup → emit → outputFileOf。note は出さない', async () => {
    const h = harness({ owners: { a: 'agent-1' }, finished: { a: '/tmp/out-a' } });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, calls: h.calls, events: h.events.length, notes: h.notes.length })
      .toMatchInlineSnapshot(`
        {
          "calls": [
            "tryObservation:作業者の道具の見張りの片付け",
            "settleAgent:agent-1",
            "backgroundTaskOwner:a",
            "stopped",
            "generation",
            "backgroundWaiters",
            "wait",
            "liveBackgroundTasks",
            "isFinished:a",
            "stopped",
            "generation",
            "recordSubagentWakeup:agent-1",
            "emit",
            "backgroundTaskCommand:a",
            "backgroundWaiters",
            "outputFileOf:a",
          ],
          "events": 1,
          "notes": 0,
          "result": {
            "kind": "addContext",
            "text": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。
        - id=a command=sleep 90 出力: /tmp/out-a
        **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
        これはこの作業者の通算 1回目の起こし直し。",
          },
        }
      `);
  });

  it('timeout の回: 待ち → subagentWakeupTotal → recordSubagentLimitReachedNote → resumeGuidance → emit → recordCutOff', async () => {
    const h = harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('timeout') });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, calls: h.calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:a",
          "stopped",
          "generation",
          "backgroundWaiters",
          "wait",
          "liveBackgroundTasks",
          "isFinished:a",
          "subagentWakeupTotal:agent-1",
          "recordSubagentLimitReachedNote:agent-1",
          "resumeGuidance:agent-1",
          "emit",
          "recordCutOff:agent-1",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('released の回: 待ち → note（emit しない・recordCutOff を通らない・通算を進めない）', async () => {
    const h = harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('released') });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, calls: h.calls, cutOffs: h.cutOffs.length }).toMatchInlineSnapshot(`
      {
        "calls": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "backgroundTaskOwner:a",
          "stopped",
          "generation",
          "backgroundWaiters",
          "wait",
          "liveBackgroundTasks",
          "isFinished:a",
          "note",
        ],
        "cutOffs": 0,
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('readError の回: 片付けの後は何も引かず、失敗の note 1 本', async () => {
    const h = harness();
    const result = await h.observer.observe(record({ readError: new Error('読めなかった') }));
    expect({ result, calls: h.calls, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "calls": [
          "tryObservation:作業者の道具の見張りの片付け",
          "settleAgent:agent-1",
          "note",
        ],
        "notes": [
          "SubagentStop の観測に失敗した: Error: 読めなかった",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('agentId が無い回: 片付けず（tryObservation を呼ばない）、所有者を引かず、診断だけ', async () => {
    const h = harness({ owners: { a: 'agent-1' } });
    const result = await h.observer.observe(
      record({ agentId: undefined, backgroundTasks: [shell('a'), shell('b')] }),
    );
    expect({ result, calls: h.calls }).toMatchInlineSnapshot(`
      {
        "calls": [
          "ownerLookupFailureNoted",
          "hasBackgroundTaskOwner:a",
          "hasBackgroundTaskOwner:b",
          "markOwnerLookupFailureNoted",
          "note",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });
});

describe('結果は Promise', () => {
  it('どの枝でも observe は Promise を返す。診断の枝は呼んだ直後に note が出ている（await の前）', () => {
    const h = harness();
    const promise = h.observer.observe(record({ backgroundTasks: [shell('x')] }));
    expect({ isPromise: promise instanceof Promise, notesSync: h.notes.length })
      .toMatchInlineSnapshot(`
        {
          "isPromise": true,
          "notesSync": 1,
        }
      `);
    return promise;
  });

  it('待ちが解けるまで戻らない（wait が決着するまで保留）。決着したら 1 回だけ emit', async () => {
    let release: (outcome: WaitOutcome) => void = () => undefined;
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () =>
        new Promise<WaitOutcome>((resolve) => {
          release = resolve;
        }),
    });
    const promise = h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    let done = false;
    void promise.then(() => {
      done = true;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const pendingState = { done, events: h.events.length };
    release('settled');
    await promise;
    expect({ pendingState, after: { done, events: h.events.length } }).toMatchInlineSnapshot(`
      {
        "after": {
          "done": true,
          "events": 1,
        },
        "pendingState": {
          "done": false,
          "events": 0,
        },
      }
    `);
  });
});

describe('waitForBackgroundTasks の 3 通りと、待ちの前後の確認', () => {
  it('stopped が先に立っていたら wait を呼ばず released', async () => {
    const h = harness({ owners: { a: 'agent-1' }, stopped: true });
    await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({
      calls: h.calls.filter((c) => c === 'wait' || c === 'backgroundWaiters'),
      notes: h.notes.length,
    }).toMatchInlineSnapshot(`
        {
          "calls": [],
          "notes": 1,
        }
      `);
  });

  it('wait が settled を返しても、待っている間に stopped が立っていたら released（emit しない）', async () => {
    const waitingHarness = harness({
      owners: { a: 'agent-1' },
      wait: () => {
        waitingHarness.sdk.stopped = true;
        return Promise.resolve('settled');
      },
    });
    const result = await waitingHarness.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({
      result,
      events: waitingHarness.events.length,
      notes: waitingHarness.notes.map((n) => n.slice(0, 40)),
    }).toMatchInlineSnapshot(`
      {
        "events": 0,
        "notes": [
          "SubagentStop（作業者: worker / agent_id=agen",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('wait が settled を返しても、世代が替わっていたら released（emit しない・通算を進めない）', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () => {
        h.sdk.generation += 1;
        return Promise.resolve('settled');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({
      result,
      events: h.events.length,
      wakeups: h.real.subagentWakeupTotal('agent-1'),
      notes: h.notes.map((n) => n.slice(0, 40)),
    }).toMatchInlineSnapshot(`
      {
        "events": 0,
        "notes": [
          "SubagentStop（作業者: worker / agent_id=agen",
        ],
        "result": {
          "kind": "continue",
        },
        "wakeups": 0,
      }
    `);
  });

  it('wait が timeout を返したときは、待ちの後の stopped／世代は見ない（そのまま timeout の枝）', async () => {
    const h = harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('timeout') });
    await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    // 待ちの後の確認は `outcome === 'settled' &&` が先に偽になるので、stopped／generation は 1 回ずつ（待ちの前）だけ読まれる
    expect({
      stopped: h.calls.filter((c) => c === 'stopped').length,
      generation: h.calls.filter((c) => c === 'generation').length,
    }).toMatchInlineSnapshot(`
      {
        "generation": 1,
        "stopped": 1,
      }
    `);
  });

  it('wait へ渡す上限は SUBAGENT_BACKGROUND_WAIT_MS。check は「終わった通知が来た」か「載ったのを見てから載らなくなった」で真になる', async () => {
    const h = harness({
      owners: { a: 'agent-1', b: 'agent-1', c: 'agent-1' },
      finished: { a: '/tmp/a' },
      live: [{ id: 'b', taskType: 'local_bash' }],
      wait: () => Promise.resolve('timeout'),
    });
    await h.observer.observe(record({ backgroundTasks: [shell('a'), shell('b'), shell('c')] }));
    expect({
      timeoutIsLimit: h.waits[0]?.timeoutMs === SUBAGENT_BACKGROUND_WAIT_MS,
      // c は載ったことが無いので、載っていないだけでは終わりにならない → 全体は偽
      checkResult: h.waits[0]?.checkResult,
    }).toMatchInlineSnapshot(`
      {
        "checkResult": false,
        "timeoutIsLimit": true,
      }
    `);
  });

  it('check の中の生きている背景処理は、呼ぶたびに読む（値に写さない）', async () => {
    const h = harness({
      owners: { b: 'agent-1' },
      wait: (check) => {
        // 1 回目: 載っている → 偽。載ったのを見たので、2 回目に載らなくなれば真
        const first = check();
        h.sdk.live = [];
        const second = check();
        h.calls.push(`check:${String(first)}:${String(second)}`);
        return Promise.resolve('timeout');
      },
      live: [{ id: 'b', taskType: 'local_bash' }],
    });
    await h.observer.observe(record({ backgroundTasks: [shell('b')] }));
    expect(h.calls.filter((c) => c.startsWith('check:'))).toMatchInlineSnapshot(`
      [
        "check:false:true",
      ]
    `);
  });
});

describe('口が同期で投げたとき', () => {
  async function outcomeOf(options: Options, input: AgentSubagentStopRecord) {
    const h = harness(options);
    const result = await h.observer.observe(input);
    return { result, notes: h.notes.map((n) => n.slice(0, 60)), calls: h.calls, h };
  }

  it('settleAgent が投げても tryObservation が握り、本体は続く', async () => {
    const r = await outcomeOf(
      {
        settleAgent: () => {
          throw new Error('settle が落ちた');
        },
      },
      record({ backgroundTasks: [shell('x')] }),
    );
    expect({ result: r.result, notes: r.notes }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=x type=shell）。この行が出た",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('tryObservation 自体が投げたら、先頭の片付けは try の外なので observe は reject する（握らない）', async () => {
    const h = harness({
      tryObservation: () => {
        throw new Error('tryObservation が落ちた');
      },
    });
    await expect(h.observer.observe(record())).rejects.toThrow('tryObservation が落ちた');
    expect(h.notes).toEqual([]);
  });

  it('診断の note が投げたら、失敗の note が 1 本出て continue。旗は note の前に立っている', async () => {
    let thrown = false;
    const texts: string[] = [];
    const h = harness({
      note: (text) => {
        texts.push(text);
        if (!thrown) {
          thrown = true;
          throw new Error('note が落ちた');
        }
      },
    });
    const input = record({ backgroundTasks: [shell('x')] });
    const first = await h.observer.observe(input);
    const second = await h.observer.observe(input);
    expect({ first, second, texts: texts.map((t) => t.slice(0, 40)) }).toMatchInlineSnapshot(`
      {
        "first": {
          "kind": "continue",
        },
        "second": {
          "kind": "continue",
        },
        "texts": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=",
          "SubagentStop の観測に失敗した: Error: note が落ちた",
        ],
      }
    `);
  });

  it('失敗の note も投げたら、黙って諦める（continue）', async () => {
    const h = harness({
      note: () => {
        throw new Error('note が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('x')] }));
    expect(result).toEqual(CONTINUE);
  });

  it('settled の emit が投げたら、起こし直さず continue。失敗の note が出る。通算は進んでいる（recordSubagentWakeup が emit より前）', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      emit: () => {
        throw new Error('emit が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, notes: h.notes, wakeups: h.real.subagentWakeupTotal('agent-1') })
      .toMatchInlineSnapshot(`
        {
          "notes": [
            "SubagentStop の観測に失敗した: Error: emit が落ちた",
          ],
          "result": {
            "kind": "continue",
          },
          "wakeups": 1,
        }
      `);
  });

  it('timeout の emit が投げたら、recordCutOff を通らず continue。間引きの回数は進んでいる', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () => Promise.resolve('timeout'),
      emit: () => {
        throw new Error('emit が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({
      result,
      notes: h.notes,
      cutOffs: h.cutOffs.length,
      nextCount: h.real.recordSubagentLimitReachedNote('agent-1').count,
    }).toMatchInlineSnapshot(`
      {
        "cutOffs": 0,
        "nextCount": 2,
        "notes": [
          "SubagentStop の観測に失敗した: Error: emit が落ちた",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('timeout の resumeGuidance が投げたら、emit も recordCutOff も無しで continue（案内は emit より前に組む）', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () => Promise.resolve('timeout'),
      resumeGuidance: () => {
        throw new Error('案内が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, events: h.events.length, cutOffs: h.cutOffs.length, notes: h.notes })
      .toMatchInlineSnapshot(`
        {
          "cutOffs": 0,
          "events": 0,
          "notes": [
            "SubagentStop の観測に失敗した: Error: 案内が落ちた",
          ],
          "result": {
            "kind": "continue",
          },
        }
      `);
  });

  it('timeout の recordCutOff が投げたら、emit は済んでいて continue、失敗の note が出る', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () => Promise.resolve('timeout'),
      recordCutOff: () => {
        throw new Error('cutOff が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, events: h.events.length, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "events": 1,
        "notes": [
          "SubagentStop の観測に失敗した: Error: cutOff が落ちた",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('wait が reject したら、catch で受けて continue（失敗の note）', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      wait: () => Promise.reject(new Error('待ちが落ちた')),
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop の観測に失敗した: Error: 待ちが落ちた",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('sdkSession の getter（stopped）が投げても catch で受けて continue', async () => {
    const h = harness({ owners: { a: 'agent-1' } });
    Object.defineProperty(h.sdk, 'stopped', {
      get(): never {
        throw new Error('stopped が落ちた');
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop の観測に失敗した: Error: stopped が落ちた",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });

  it('stopState の recordSubagentWakeup が投げても catch で受けて continue（emit まで進まない）', async () => {
    const h = harness({
      owners: { a: 'agent-1' },
      stopStateOverride: {
        recordSubagentWakeup: () => {
          throw new Error('記録が落ちた');
        },
      },
    });
    const result = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ result, events: h.events.length, notes: h.notes }).toMatchInlineSnapshot(`
      {
        "events": 0,
        "notes": [
          "SubagentStop の観測に失敗した: Error: 記録が落ちた",
        ],
        "result": {
          "kind": "continue",
        },
      }
    `);
  });
});

describe('参照のまま使うこと（値に写さない）', () => {
  it('stopState: 作った後に外から載せた所有者が効く。ここが立てた旗が外から見える', async () => {
    const h = harness();
    h.real.setBackgroundTaskOwner('late', 'agent-1', 'sleep 1');
    const result = await h.observer.observe(record({ backgroundTasks: [shell('late')] }));
    expect({
      result,
      wakeups: h.real.subagentWakeupTotal('agent-1'),
      ownerNotedBefore: h.real.ownerLookupFailureNoted,
    }).toMatchInlineSnapshot(`
      {
        "ownerNotedBefore": false,
        "result": {
          "kind": "addContext",
          "text": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。
      - id=late command=sleep 1 出力: 取れなかった（完了通知の output_file が無い）
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
        },
        "wakeups": 1,
      }
    `);
    await h.observer.observe(record({ backgroundTasks: [shell('orphan')] }));
    expect(h.real.ownerLookupFailureNoted).toBe(true);
  });

  it('sdkSession: stopped は呼ぶたびに読む（呼び間で立てると、次の回は待たずに released）', async () => {
    const h = harness({ owners: { a: 'agent-1' } });
    const first = await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    h.sdk.stopped = true;
    h.waits.length = 0;
    await h.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({ first, waitsAfterStopped: h.waits.length }).toMatchInlineSnapshot(`
      {
        "first": {
          "kind": "addContext",
          "text": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。
      - id=a command=sleep 90 出力: 取れなかった（完了通知の output_file が無い）
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
        },
        "waitsAfterStopped": 0,
      }
    `);
  });

  it('cutOffWorkers: recordCutOff には id と command だけを渡す（command が無ければ欄ごと省く）', async () => {
    const h = harness({
      owners: { a: 'agent-1', b: 'agent-1' },
      wait: () => Promise.resolve('timeout'),
    });
    await h.observer.observe(
      record({ backgroundTasks: [shell('a', 'running', { command: 'pnpm test' }), shell('b')] }),
    );
    expect(h.cutOffs).toStrictEqual([
      {
        agentId: 'agent-1',
        tasks: [{ id: 'a', command: 'pnpm test' }, { id: 'b' }],
      },
    ]);
  });

  it('emit した note には managerId が載る（口の managerId）。stall.outcome は woken／limit_reached', async () => {
    const woken = harness({ owners: { a: 'agent-1' } });
    await woken.observer.observe(record({ backgroundTasks: [shell('a')] }));
    const limited = harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('timeout') });
    await limited.observer.observe(record({ backgroundTasks: [shell('a')] }));
    expect({
      woken: woken.events.map((e) => (e.type === 'note' ? [e.managerId, e.stall?.outcome] : null)),
      limited: limited.events.map((e) =>
        e.type === 'note' ? [e.managerId, e.stall?.outcome, e.escalate] : null,
      ),
    }).toMatchInlineSnapshot(`
      {
        "limited": [
          [
            "mgr-fake",
            "limit_reached",
            true,
          ],
        ],
        "woken": [
          [
            "mgr-fake",
            "woken",
          ],
        ],
      }
    `);
  });
});

describe('周回（await 1 か所のまま）', () => {
  async function ticksOf(h: ReturnType<typeof harness>, input: AgentSubagentStopRecord) {
    const promise = h.observer.observe(input);
    const syncNotes = h.notes.length + h.events.length;
    let ticks = 0;
    let settledAt = -1;
    void promise.then(() => {
      settledAt = ticks;
    });
    const seen: number[] = [];
    while (settledAt < 0 && ticks < 50) {
      await Promise.resolve();
      ticks += 1;
      seen.push(h.notes.length + h.events.length);
    }
    return { syncNotes, settledAt, seen };
  }

  it('各枝の、呼んだ直後に出ている出力の本数・戻りまでの周回数・周回ごとの出力の本数（待ちは即座に決着する偽）', async () => {
    const orphan = await ticksOf(harness(), record({ backgroundTasks: [shell('x')] }));
    const failed = await ticksOf(harness(), record({ readError: new Error('r') }));
    const settledOnly = await ticksOf(
      harness({ owners: { a: 'agent-1' } }),
      record({ backgroundTasks: [shell('a', 'completed')] }),
    );
    const woken = await ticksOf(
      harness({ owners: { a: 'agent-1' } }),
      record({ backgroundTasks: [shell('a')] }),
    );
    const timeout = await ticksOf(
      harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('timeout') }),
      record({ backgroundTasks: [shell('a')] }),
    );
    const released = await ticksOf(
      harness({ owners: { a: 'agent-1' }, wait: () => Promise.resolve('released') }),
      record({ backgroundTasks: [shell('a')] }),
    );
    const stoppedBefore = await ticksOf(
      harness({ owners: { a: 'agent-1' }, stopped: true }),
      record({ backgroundTasks: [shell('a')] }),
    );
    expect({ orphan, failed, settledOnly, woken, timeout, released, stoppedBefore })
      .toMatchInlineSnapshot(`
        {
          "failed": {
            "seen": [
              1,
            ],
            "settledAt": 0,
            "syncNotes": 1,
          },
          "orphan": {
            "seen": [
              1,
            ],
            "settledAt": 0,
            "syncNotes": 1,
          },
          "released": {
            "seen": [
              0,
              1,
              1,
            ],
            "settledAt": 2,
            "syncNotes": 0,
          },
          "settledOnly": {
            "seen": [
              1,
            ],
            "settledAt": 0,
            "syncNotes": 1,
          },
          "stoppedBefore": {
            "seen": [
              1,
              1,
            ],
            "settledAt": 1,
            "syncNotes": 0,
          },
          "timeout": {
            "seen": [
              0,
              1,
              1,
            ],
            "settledAt": 2,
            "syncNotes": 0,
          },
          "woken": {
            "seen": [
              0,
              1,
              1,
            ],
            "settledAt": 2,
            "syncNotes": 0,
          },
        }
      `);
  });
});
