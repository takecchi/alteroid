import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import {
  WORKER_TOOL_RUNNING_AFTER_MS,
  type WorkerToolWatchClock,
} from './runner-worker-tool-watch.js';

// `RunnerSession#onSubagentStop`（作業者が畳むときの背景処理の完了待ちと起こし直し／打ち切り。
// `#waitForBackgroundTasks`・`#renderSubagentStopTaskLines`・`#noteSettledOnly`・`#noteOwnerLookupFailure` を含む）を、外から見える結果だけで縛る。
// `runner-subagent-stop.test.ts` が `toContain` で縛っていない所を足す: note の全文（欄の `escalate`／`stall` も）・`AgentContextOutcome` の全文・
// 診断が 1 回だけであること・待ちの結果 3 通り（released／settled／timeout）の状態の更新（通算・間引き・`recordCutOff` を通る／通らない）・
// 上限（1_500 文字）で切れる順・`readError`・`note`／`emit` が投げたときの握り方・`settleAgent` の位置・`await` の周回数。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待ちの上限は偽のタイマーで進める。それ以外はマイクロタスクの周回と `setTimeout(0)` の 1 回だけ）。

interface Started {
  options: Options;
  finish: () => void;
  notify: (taskId: string, extra?: Record<string, unknown>) => void;
  liveTasks: (ids: readonly string[]) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      notify: (taskId, extra = {}) =>
        emit?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          summary: '完了',
          session_id: `sess-${started.length}`,
          uuid: `uuid-task-notification-${taskId}`,
          ...extra,
        } as unknown as SDKMessage),
      liveTasks: (ids) =>
        emit?.({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: '' })),
          session_id: `sess-${started.length}`,
          uuid: `uuid-live-${ids.join('-')}-${String(Math.random())}`,
        } as unknown as SDKMessage),
    };
    started.push(record);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      for (;;) {
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: () => record.finish(),
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-subagent-stop-pin-');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
}

async function open(
  options: { throwOn?: (event: RunnerEvent) => boolean; clock?: WorkerToolWatchClock } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    ...(options.clock === undefined ? {} : { workerToolWatchClock: options.clock }),
    emit: (event) => {
      events.push(event);
      if (options.throwOn?.(event) === true) throw new Error('emit が落ちた（テスト用）');
    },
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  // 起動までに出た出来事は見ない
  events.length = 0;
  return { started: first, events };
}

type HookName = 'SubagentStop' | 'PostToolUse' | 'PreToolUse';

function hookOf(rig: Rig, name: HookName) {
  const hook = rig.started.options.hooks?.[name]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${name} フックが登録されていない`);
  return hook;
}

function fire(rig: Rig, name: HookName, input: Record<string, unknown>): Promise<HookJSONOutput> {
  // `input` は展開せずそのまま渡す（getter が投げる入力を、展開でテスト側が先に読んでしまわないため）
  return hookOf(rig, name)(input as never, undefined, { signal: new AbortController().signal });
}

const STOP_BASE = {
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_transcript_path: '/tmp/does-not-exist.jsonl',
  agent_type: 'worker',
  session_crons: [],
};

function fireStop(rig: Rig, input: Record<string, unknown>): Promise<HookJSONOutput> {
  return fire(rig, 'SubagentStop', input);
}

/** 所有者の表へ `taskId → agentId`（と command `sleep 90`）を載せる（PostToolUse の `backgroundTaskId`）。 */
async function register(rig: Rig, taskId: string, agentId?: string): Promise<void> {
  await fire(rig, 'PostToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 90', run_in_background: true },
    tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
    ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
  });
}

function bg(id: string, status = 'running', extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'shell',
    status,
    description: '背景のシェル',
    command: 'pnpm verify',
    ...extra,
  };
}

function selfEntry(agentId: string) {
  return { id: agentId, type: 'subagent', status: 'running', description: '当人' };
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

const subagentNotes = (events: readonly RunnerEvent[]): NoteEvent[] =>
  events.filter(
    (event): event is NoteEvent => event.type === 'note' && event.text.startsWith('SubagentStop'),
  );

/** note の全文と、`text` / `managerId` / `type` 以外の欄（`escalate`／`stall`）。 */
function viewNotes(events: readonly RunnerEvent[]): unknown[] {
  return subagentNotes(events).map((note) => {
    const rest = Object.fromEntries(
      Object.entries(note).filter(
        ([key]) => key !== 'type' && key !== 'managerId' && key !== 'text',
      ),
    );
    return Object.keys(rest).length === 0 ? note.text : { text: note.text, ...rest };
  });
}

/** 投げるのは、条件に当たった最初の 1 回だけ（その出来事は `events` に積んだ後で投げる）。 */
function throwOnce(predicate: (event: RunnerEvent) => boolean): (event: RunnerEvent) => boolean {
  let thrown = false;
  return (event) => {
    if (thrown || !predicate(event)) return false;
    thrown = true;
    return true;
  };
}

const isSubagentNote = (event: RunnerEvent): boolean =>
  event.type === 'note' && event.text.startsWith('SubagentStop');

/** 待ちの上限まで偽のタイマーで進めて、フックの戻りを返す。 */
async function stopUntilLimit(rig: Rig, input: Record<string, unknown>): Promise<HookJSONOutput> {
  vi.useFakeTimers();
  try {
    const pending = fireStop(rig, input);
    await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

async function finish(rig: Rig, taskId: string, outputFile?: string | null): Promise<void> {
  rig.started.notify(
    taskId,
    outputFile === null
      ? { output_file: undefined }
      : { output_file: outputFile ?? '/tmp/out.txt' },
  );
  await tick();
}

function contextOf(result: HookJSONOutput): string | undefined {
  return (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;
}

describe('読み取りの失敗（catch）', () => {
  function throwingInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const input: Record<string, unknown> = { ...STOP_BASE, agent_id: 'agent-1', ...extra };
    Object.defineProperty(input, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    return input;
  }

  it('readError の回: 失敗の note が 1 本・戻りは continue。診断の旗も通算も進めない', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    const failed = await fireStop(rig, throwingInput());
    // 旗が進んでいないこと: 続けて所有者を引けない形を渡すと診断が出る
    const after = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [bg('bg-unknown')],
    });
    expect({ failed, after, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "after": {
          "continue": true,
        },
        "failed": {
          "continue": true,
        },
        "notes": [
          "SubagentStop の観測に失敗した: Error: boom",
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=bg-unknown type=shell）。この行が出たら計器のほうを疑う — \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。（雑音にしないため、この診断はセッションに1回だけ出す。）",
        ],
      }
    `);
  });

  it('失敗の note も投げたら、黙って諦める（投げ直さない）。次の回は動く', async () => {
    const rig = await open({ throwOn: isSubagentNote });
    const failed = await fireStop(rig, throwingInput());
    const countAfterFirst = subagentNotes(rig.events).length;
    const second = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [bg('bg-unknown')],
    });
    expect({
      failed,
      second,
      countAfterFirst,
      countAfterSecond: subagentNotes(rig.events).length,
    }).toMatchInlineSnapshot(`
      {
        "countAfterFirst": 1,
        "countAfterSecond": 3,
        "failed": {
          "continue": true,
        },
        "second": {
          "continue": true,
        },
      }
    `);
  });
});

describe('所有者を引けない（#noteOwnerLookupFailure）／当人の分が無い', () => {
  it('mine が空で、表に無い shell が在る: 診断の全文（件数・列挙）。2 回目は出ない。戻りは continue', async () => {
    const rig = await open();
    const input = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        bg('bg-orphan-1'),
        { type: 'shell', status: 'running' },
        { id: 'mon-1', type: 'monitor', status: 'running' },
      ],
    };
    const first = await fireStop(rig, input);
    const second = await fireStop(rig, input);
    expect({ first, second, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "first": {
          "continue": true,
        },
        "notes": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（2件。id=bg-orphan-1 type=shell / id=(不明) type=shell）。この行が出たら計器のほうを疑う — \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。（雑音にしないため、この診断はセッションに1回だけ出す。）",
        ],
        "second": {
          "continue": true,
        },
      }
    `);
  });

  it('引けない shell が無ければ（monitor などだけ）診断は出ず、旗も立たない。後から引けない shell が来れば出る', async () => {
    const rig = await open();
    await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [{ id: 'mon-1', type: 'monitor', status: 'running' }],
    });
    const quiet = subagentNotes(rig.events).length;
    await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-late')],
    });
    expect({ quiet, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=bg-late type=shell）。この行が出たら計器のほうを疑う — \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。（雑音にしないため、この診断はセッションに1回だけ出す。）",
        ],
        "quiet": 0,
      }
    `);
  });

  it('agent_id が無い回: mine が空になるので診断の枝だけを通り、起こし直しはしない', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      background_tasks: [bg('bg-1'), bg('bg-orphan')],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=bg-orphan type=shell）。この行が出たら計器のほうを疑う — \`PostToolUse\` の \`tool_response.backgroundTaskId\` が改名・消滅したか、表が上限（500件）で古い側を捨てたかである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。そのあいだ「自分の背景処理を残して畳んだ作業者」の記録は出なくなる（無音になる）。（雑音にしないため、この診断はセッションに1回だけ出す。）",
        ],
        "result": {
          "continue": true,
        },
      }
    `);
  });

  it('兄弟・マネージャーの分しか無ければ、診断は出ない（引く対象が表に在る）', async () => {
    const rig = await open();
    await register(rig, 'bg-sib', 'agent-2');
    await register(rig, 'bg-mgr');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-sib'), bg('bg-mgr')],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [],
        "result": {
          "continue": true,
        },
      }
    `);
  });
});

describe('当人の分が全部終わっている（#noteSettledOnly）', () => {
  it('note の全文（列挙・件数）が 1 回だけ。2 回目は出ない。戻りは continue、通算は進まない', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    await register(rig, 'bg-2', 'agent-1');
    const input = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        bg('bg-1', 'completed'),
        bg('bg-2', 'killed', { type: 'shell' }),
      ],
    };
    const first = await fireStop(rig, input);
    const second = await fireStop(rig, input);
    // 通算が進んでいないこと: 次に起こし直すときの通算は 1 回目
    await register(rig, 'bg-3', 'agent-1');
    await finish(rig, 'bg-3');
    const woken = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-3')],
    });
    expect({ first, second, wokenKind: contextOf(woken)?.slice(-24), notes: viewNotes(rig.events) })
      .toMatchInlineSnapshot(`
        {
          "first": {
            "continue": true,
          },
          "notes": [
            "SubagentStop: 当人が起こした背景処理が 2件 配列に載っていたが、**status は全部「終わった」側だった**（type=shell status=completed / type=shell status=killed）。起こし直していない。SDK は \`background_tasks\` を「in-flight」と名乗っているので、この行が出たら計器のほうを疑う — 畳み終えた分が配列に残っているか、status の語彙が変わったかである。⟹ この Issue（#570）へ、この行と SDK の版を添えて報告してほしい。（雑音にしないため、この診断はセッションに1回だけ出す。）",
            {
              "stall": {
                "agentId": "agent-1",
                "agentType": "worker",
                "outcome": "woken",
                "ownedTaskCount": 1,
                "sessionTaskCount": 1,
                "wakeupCount": 1,
              },
              "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
        - id=bg-3 command=pnpm verify type=shell status=running description=背景のシェル
        ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
            },
          ],
          "second": {
            "continue": true,
          },
          "wokenKind": "。
        これはこの作業者の通算 1回目の起こし直し。",
        }
      `);
  });

  it('type / status の欄が無い行は「(不明)」と書く。status が欠けた行は終わった側ではない（走っている側へ倒れて起こし直す）', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    await finish(rig, 'bg-1');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [{ id: 'bg-1' }],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 1,
              "sessionTaskCount": 1,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
      - id=bg-1 type=(不明) status=(不明) description=(不明)
      ⚠️ 上のうち 1件 は status が既知の語彙のどちらでもない —— 「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
        "result": {
          "continue": true,
          "hookSpecificOutput": {
            "additionalContext": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。
      - id=bg-1 command=sleep 90 出力: /tmp/out.txt
      ⚠️ 上のうち 1件 は status が既知の語彙のどちらでもない —— 「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
            "hookEventName": "SubagentStop",
          },
        },
      }
    `);
  });
});

describe('待ちの結果: settled（完了を待って起こし直した）', () => {
  it('note の全文・stall・addContext の全文。command は task の値が先、無ければ表の値。output_file の有り／無し', async () => {
    const rig = await open();
    await register(rig, 'bg-a', 'agent-1');
    await register(rig, 'bg-b', 'agent-1');
    const pending = fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      stop_hook_active: true,
      session_crons: [{ id: 'cron-1' }],
      background_tasks: [
        selfEntry('agent-1'),
        bg('bg-a', 'running', { command: 'task 側の command' }),
        { id: 'bg-b', type: 'shell', status: 'pending', description: '表から引く' },
      ],
    });
    await tick();
    await finish(rig, 'bg-a', '/tmp/out-a.txt');
    await finish(rig, 'bg-b', null);
    const result = await pending;
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 2,
              "sessionTaskCount": 3,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 2件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=3件、session_crons=1件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=true。
      - id=bg-a command=task 側の command type=shell status=running description=背景のシェル
      - id=bg-b type=shell status=pending description=表から引く
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
        "result": {
          "continue": true,
          "hookSpecificOutput": {
            "additionalContext": "あなたが自分で起こした背景処理が 2件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=3件、session_crons=1件）。
      - id=bg-a command=task 側の command 出力: /tmp/out-a.txt
      - id=bg-b command=sleep 90 出力: 取れなかった（完了通知の output_file が無い）
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
            "hookEventName": "SubagentStop",
          },
        },
      }
    `);
  });

  it('通算が進む（2 回目は「通算 2回目」）。stall.wakeupCount も 2。別の作業者は別に数える', async () => {
    const rig = await open();
    const results: unknown[] = [];
    for (const [round, agentId] of [
      [1, 'agent-1'],
      [2, 'agent-1'],
      [3, 'agent-2'],
    ] as const) {
      const id = `bg-r${String(round)}`;
      await register(rig, id, agentId);
      await finish(rig, id);
      results.push(
        contextOf(
          await fireStop(rig, { ...STOP_BASE, agent_id: agentId, background_tasks: [bg(id)] }),
        )?.split('\n')[0],
      );
    }
    const stalls = subagentNotes(rig.events).map((note) => note.stall);
    expect({ results, stalls }).toMatchInlineSnapshot(`
      {
        "results": [
          "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。",
          "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。",
          "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。",
        ],
        "stalls": [
          {
            "agentId": "agent-1",
            "agentType": "worker",
            "outcome": "woken",
            "ownedTaskCount": 1,
            "sessionTaskCount": 1,
            "wakeupCount": 1,
          },
          {
            "agentId": "agent-1",
            "agentType": "worker",
            "outcome": "woken",
            "ownedTaskCount": 1,
            "sessionTaskCount": 1,
            "wakeupCount": 2,
          },
          {
            "agentId": "agent-2",
            "agentType": "worker",
            "outcome": "woken",
            "ownedTaskCount": 1,
            "sessionTaskCount": 1,
            "wakeupCount": 1,
          },
        ],
      }
    `);
  });

  it('stop_hook_active の 3 通り（true / false / 欠け）が note に出る・出ない', async () => {
    const rig = await open();
    const lines: unknown[] = [];
    for (const [name, extra] of [
      ['true', { stop_hook_active: true }],
      ['false', { stop_hook_active: false }],
      ['absent', { stop_hook_active: undefined }],
    ] as const) {
      const id = `bg-${name}`;
      await register(rig, id, 'agent-1');
      await finish(rig, id);
      await fireStop(rig, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        ...extra,
        background_tasks: [bg(id)],
      });
      lines.push(subagentNotes(rig.events).at(-1)?.text.split('\n')[0]);
    }
    expect(lines).toMatchInlineSnapshot(`
      [
        "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=true。",
        "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 2回目）。 stop_hook_active=false。",
        "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 3回目）。",
      ]
    `);
  });

  it('settled と running が混ざる: 終わった分は数に入れず、そう書く（note・addContext の両方）', async () => {
    const rig = await open();
    await register(rig, 'bg-run', 'agent-1');
    await register(rig, 'bg-done', 'agent-1');
    await finish(rig, 'bg-run');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-run'), bg('bg-done', 'completed')],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 1,
              "sessionTaskCount": 2,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（当人が起こしたもののうち 1件 は status が「終わった」側だったので数に入れていない）（この瞬間のセッション全体の在庫=2件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
      - id=bg-run command=pnpm verify type=shell status=running description=背景のシェル
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
        "result": {
          "continue": true,
          "hookSpecificOutput": {
            "additionalContext": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（当人が起こしたもののうち 1件 は status が「終わった」側だったので数に入れていない）（この瞬間のセッション全体の在庫=2件、session_crons=0件）。
      - id=bg-run command=pnpm verify 出力: /tmp/out.txt
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
            "hookEventName": "SubagentStop",
          },
        },
      }
    `);
  });

  it('未知の status は「走っている」へ倒して起こし直し、⚠️ 行を note と addContext の両方に書く。status の欄が無い行も同じ', async () => {
    const rig = await open();
    await register(rig, 'bg-x', 'agent-1');
    await register(rig, 'bg-y', 'agent-1');
    await finish(rig, 'bg-x');
    await finish(rig, 'bg-y');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-x', 'weird'), { id: 'bg-y', type: 'shell' }],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 2,
              "sessionTaskCount": 2,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 2件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=2件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
      - id=bg-x command=pnpm verify type=shell status=weird description=背景のシェル
      - id=bg-y type=shell status=(不明) description=(不明)
      ⚠️ 上のうち 2件 は status が既知の語彙のどちらでもない —— 「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
        "result": {
          "continue": true,
          "hookSpecificOutput": {
            "additionalContext": "あなたが自分で起こした背景処理が 2件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=2件、session_crons=0件）。
      - id=bg-x command=pnpm verify 出力: /tmp/out.txt
      - id=bg-y command=sleep 90 出力: /tmp/out.txt
      ⚠️ 上のうち 2件 は status が既知の語彙のどちらでもない —— 「走っている」へ倒して数えた（分からないものを「終わった」へ倒さない）。この行が出たら計器のほうを疑う — SDK が status の語彙を変えた見込みが高い。
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
            "hookEventName": "SubagentStop",
          },
        },
      }
    `);
  });

  it('1_500 文字を超えると、note も addContext も末尾から切れる。taskLines の後ろの行（案内文）が先に落ち、id / command は残る', async () => {
    const rig = await open();
    const ids = Array.from({ length: 12 }, (_, i) => `bg-long-${String(i)}`);
    for (const id of ids) {
      await register(rig, id, 'agent-1');
      await finish(rig, id);
    }
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: ids.map((id) => bg(id, 'running', { description: 'あ'.repeat(40) })),
    });
    const context = contextOf(result) ?? '';
    const note = subagentNotes(rig.events)[0]?.text ?? '';
    expect({
      contextLength: context.length,
      contextTail: context.slice(-60),
      noteLength: note.length,
      noteTail: note.slice(-60),
      noteHasDisclaimer: note.includes('空転が無かった'),
    }).toMatchInlineSnapshot(`
      {
        "contextLength": 848,
        "contextTail": "ら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
        "noteHasDisclaimer": false,
        "noteLength": 1517,
        "noteTail": "nd=pnpm verify type=shell status=running de…（上限 1500 文字で切った）",
      }
    `);
  });

  it('id の欄が無い行は mine に入らず（ownedTaskCount に数えない・待ちの対象にならない）、在庫の件数には数える', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    await finish(rig, 'bg-1');
    const result = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1'), { type: 'shell', status: 'running' }],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 1,
              "sessionTaskCount": 2,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=2件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
      - id=bg-1 command=pnpm verify type=shell status=running description=背景のシェル
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
        "result": {
          "continue": true,
          "hookSpecificOutput": {
            "additionalContext": "あなたが自分で起こした背景処理が 1件、残ったまま畳もうとしたので、**終わるまで待ってから**起こし直した。**背景処理は終わった。**（この瞬間のセッション全体の在庫=2件、session_crons=0件）。
      - id=bg-1 command=pnpm verify 出力: /tmp/out.txt
      **結果（出力）を読んでから畳むこと。** 出力の置き場所は上の行のとおり。まだ続きの背景処理を起こすなら、畳む前にまた最大 30 分は完了を待つ（それを超えると打ち切られる）。
      これはこの作業者の通算 1回目の起こし直し。",
            "hookEventName": "SubagentStop",
          },
        },
      }
    `);
  });
});

describe('待ちの結果: released（待ちの途中・前に畳まれた）', () => {
  it('待ちの途中で stop: note の全文・stall と escalate を載せない・通算を進めない・recordCutOff を通さない（Task の結果に注記が付かない）', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    const pending = fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      stop_hook_active: true,
      background_tasks: [selfEntry('agent-1'), bg('bg-1')],
    });
    await tick();
    await host?.shutdown();
    const result = await pending;
    const annotated = await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { prompt: '作業' },
      tool_response: { status: 'completed', agentId: 'agent-1', content: [] },
    });
    expect({ result, notes: viewNotes(rig.events), annotated: contextOf(annotated) })
      .toMatchInlineSnapshot(`
        {
          "annotated": undefined,
          "notes": [
            "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした** — 完了を待っている途中でセッションが畳まれた（stop / 畳み直し / 世代交代）ので、起こし直さずに返した。 stop_hook_active=true。",
          ],
          "result": {
            "continue": true,
          },
        }
      `);
  });

  it('既に stop 済み: 待たずに released の note（stop_hook_active が欠けなら、その行は無い）', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    await host?.shutdown();
    const result = await fireStop(rig, {
      ...STOP_BASE,
      stop_hook_active: undefined,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1')],
    });
    expect({ result, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした** — 完了を待っている途中でセッションが畳まれた（stop / 畳み直し / 世代交代）ので、起こし直さずに返した。",
        ],
        "result": {
          "continue": true,
        },
      }
    `);
  });
});

describe('待ちの結果: timeout（待ちの上限）', () => {
  it('1・2・3 回目の note の全文（escalate は 1・3 回目だけ）・stall・戻りは continue。通算（起こし直し済みの回数）が文言と wakeupCount に出る', async () => {
    const rig = await open();
    // 1 回起こし直しておく（通算 1）
    await register(rig, 'bg-w', 'agent-1');
    await finish(rig, 'bg-w');
    await fireStop(rig, { ...STOP_BASE, agent_id: 'agent-1', background_tasks: [bg('bg-w')] });
    rig.events.length = 0;

    await register(rig, 'bg-1', 'agent-1');
    await register(rig, 'bg-done', 'agent-1');
    const results: HookJSONOutput[] = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(
        await stopUntilLimit(rig, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          stop_hook_active: i === 0,
          session_crons: [{ id: 'c' }],
          background_tasks: [
            selfEntry('agent-1'),
            bg('bg-1', 'running', { description: '回の説明' }),
            bg('bg-done', 'completed'),
          ],
        }),
      );
    }
    expect({ results, notes: viewNotes(rig.events) }).toMatchInlineSnapshot(`
      {
        "notes": [
          {
            "escalate": true,
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "limit_reached",
              "ownedTaskCount": 1,
              "sessionTaskCount": 3,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（当人が起こしたもののうち 1件 は status が「終わった」側だったので数に入れていない）（この瞬間のセッション全体の在庫=3件、session_crons=1件）。**背景処理の完了を 30 分（待ちの上限）まで待ったが、終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 1回 起こし直し済み）。 stop_hook_active=true。
      打ち切ってから 1回目（1・3・9…回目だけクローンへ上げる）。
      - id=bg-1 command=pnpm verify type=shell status=running description=回の説明
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。
      出力の置き場所は、処理が終わったら知らせる（#1554）。
      続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。",
          },
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "limit_reached",
              "ownedTaskCount": 1,
              "sessionTaskCount": 3,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（当人が起こしたもののうち 1件 は status が「終わった」側だったので数に入れていない）（この瞬間のセッション全体の在庫=3件、session_crons=1件）。**背景処理の完了を 30 分（待ちの上限）まで待ったが、終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 1回 起こし直し済み）。 stop_hook_active=false。
      打ち切ってから 2回目（1・3・9…回目だけクローンへ上げる）。 この回はクローンの受信箱へは上げない — 日誌には残る。
      - id=bg-1 command=pnpm verify type=shell status=running description=回の説明
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。
      出力の置き場所は、処理が終わったら知らせる（#1554）。
      続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。",
          },
          {
            "escalate": true,
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "limit_reached",
              "ownedTaskCount": 1,
              "sessionTaskCount": 3,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（当人が起こしたもののうち 1件 は status が「終わった」側だったので数に入れていない）（この瞬間のセッション全体の在庫=3件、session_crons=1件）。**背景処理の完了を 30 分（待ちの上限）まで待ったが、終わらなかったため、起こし直さずに打ち切った**（この作業者の通算 1回 起こし直し済み）。 stop_hook_active=false。
      打ち切ってから 3回目（1・3・9…回目だけクローンへ上げる）。
      - id=bg-1 command=pnpm verify type=shell status=running description=回の説明
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。
      出力の置き場所は、処理が終わったら知らせる（#1554）。
      続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。",
          },
        ],
        "results": [
          {
            "continue": true,
          },
          {
            "continue": true,
          },
          {
            "continue": true,
          },
        ],
      }
    `);
  });

  it('間引き: 同じ agentId の 9 回目まで、escalate は 1・3・9 回目だけ。別の agentId は独立に数える', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    await register(rig, 'bg-2', 'agent-2');
    const escalated: Record<string, number[]> = { 'agent-1': [], 'agent-2': [] };
    const counts: Record<string, string[]> = { 'agent-1': [], 'agent-2': [] };
    const input = (agentId: string, id: string) => ({
      ...STOP_BASE,
      agent_id: agentId,
      background_tasks: [bg(id)],
    });
    for (let i = 1; i <= 9; i += 1) {
      await stopUntilLimit(rig, input('agent-1', 'bg-1'));
      const note = subagentNotes(rig.events).at(-1);
      if (note?.escalate === true) escalated['agent-1']?.push(i);
      counts['agent-1']?.push(/打ち切ってから (\d+)回目/u.exec(note?.text ?? '')?.[1] ?? '?');
    }
    await stopUntilLimit(rig, input('agent-2', 'bg-2'));
    const other = subagentNotes(rig.events).at(-1);
    expect({
      escalated: escalated['agent-1'],
      counts: counts['agent-1'],
      otherEscalate: other?.escalate,
      otherCount: /打ち切ってから (\d+)回目/u.exec(other?.text ?? '')?.[1],
      thinnedLine: subagentNotes(rig.events)[1]?.text.split('\n')[1],
    }).toMatchInlineSnapshot(`
      {
        "counts": [
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
          "9",
        ],
        "escalated": [
          1,
          3,
          9,
        ],
        "otherCount": "1",
        "otherEscalate": true,
        "thinnedLine": "打ち切ってから 2回目（1・3・9…回目だけクローンへ上げる）。 この回はクローンの受信箱へは上げない — 日誌には残る。",
      }
    `);
  });

  it('recordCutOff の中身: id と command（無ければ欄ごと省く）。id の無い行は載せない。Task の結果の注記に出る', async () => {
    const rig = await open();
    await register(rig, 'bg-c', 'agent-1');
    await register(rig, 'bg-n', 'agent-1');
    await stopUntilLimit(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        bg('bg-c', 'running', { command: 'pnpm test' }),
        { id: 'bg-n', type: 'shell', status: 'running' },
      ],
    });
    const annotated = await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { prompt: '作業' },
      tool_response: { status: 'completed', agentId: 'agent-1', content: [] },
    });
    expect(contextOf(annotated)).toMatchInlineSnapshot(`
      "⚠️ この作業者（agent_id=agent-1）は、自分で起こした背景処理を残したまま畳もうとした後、背景処理の完了を待つ上限（30分）に達したため、alteroid が打ち切った。**上の報告は完結していない可能性がある**（最後の発言が「待っています」の類でも、その待ちはもう誰も続けない）。成果（commit / push / 検証）が実際に在るかを確かめてから次を決めること。
      - id=bg-c command=pnpm test
      - id=bg-n
      出力の置き場所は、処理が終わったら知らせる（#1554）。
      続きを頼むなら、\`ToolSearch\` を \`select:SendMessage\` で読み込んでから agentId=agent-1 へ送ること——同じ文脈のまま再開できる。届くのはその作業者の次の道具の区切りで、即時ではない（読む前に動くことがある）。"
    `);
  });

  it('上限（1_500 文字）で切れる順: id / command は残り、末尾の案内（出力の置き場所・ToolSearch）が先に落ちる', async () => {
    const rig = await open();
    const ids = Array.from({ length: 12 }, (_, i) => `bg-lim-${String(i)}`);
    for (const id of ids) await register(rig, id, 'agent-1');
    await stopUntilLimit(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: ids.map((id) => bg(id, 'running', { description: 'あ'.repeat(40) })),
    });
    const note = subagentNotes(rig.events)[0];
    expect({
      length: note?.text.length,
      tail: note?.text.slice(-60),
      hasFirstId: note?.text.includes('id=bg-lim-0'),
      hasGuidance: note?.text.includes('ToolSearch'),
      escalate: note?.escalate,
    }).toMatchInlineSnapshot(`
      {
        "escalate": true,
        "hasFirstId": true,
        "hasGuidance": false,
        "length": 1517,
        "tail": "n=ああああああああああああああああああああああああああああああああああああああああ
      …（上限 1500 文字で切った）",
      }
    `);
  });
});

describe('作業者の道具の見張りの片付け（settleAgent）', () => {
  const WORKER = { agent_id: 'agent-1', agent_type: 'worker' };

  /** 20 秒の印（tool_running）を出させて、片付けで tool_end が出るのを観測できるようにする偽の時計。 */
  function fakeClock(): WorkerToolWatchClock & { advance: (ms: number) => void } {
    let nowMs = 0;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.set(id, { at: nowMs + ms, fn });
        return id;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
      advance: (ms) => {
        nowMs += ms;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= nowMs) {
            timers.delete(id);
            timer.fn();
          }
        }
      },
    };
  }

  async function beginWorkerTool(rig: Rig, clock: ReturnType<typeof fakeClock>): Promise<void> {
    await fire(rig, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 1' },
      tool_use_id: 'tu-1',
      ...WORKER,
    });
    clock.advance(WORKER_TOOL_RUNNING_AFTER_MS);
  }

  const endEvents = (events: readonly RunnerEvent[]) =>
    events.filter((event) => event.type === 'tool_end');

  it('待ちに入る前に片付く（待ちが終わるのを待たずに tool_end が出る）', async () => {
    const clock = fakeClock();
    const rig = await open({ clock });
    await register(rig, 'bg-1', 'agent-1');
    await beginWorkerTool(rig, clock);
    const pending = fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1')],
    });
    const endedWhileWaiting = endEvents(rig.events).length;
    await finish(rig, 'bg-1');
    await pending;
    expect({ endedWhileWaiting, ended: endEvents(rig.events).length }).toMatchInlineSnapshot(`
      {
        "ended": 1,
        "endedWhileWaiting": 1,
      }
    `);
  });

  it('readError の回でも片付く（先頭の片付けは try の前）', async () => {
    const clock = fakeClock();
    const rig = await open({ clock });
    await beginWorkerTool(rig, clock);
    const input: Record<string, unknown> = { ...STOP_BASE, ...WORKER };
    Object.defineProperty(input, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    await fireStop(rig, input);
    expect(endEvents(rig.events).length).toMatchInlineSnapshot(`0`);
  });

  it('agent_id が無い回は片付けない（他の作業者の見張りに触れない）', async () => {
    const clock = fakeClock();
    const rig = await open({ clock });
    await beginWorkerTool(rig, clock);
    await fireStop(rig, { ...STOP_BASE, background_tasks: [] });
    expect(endEvents(rig.events).length).toMatchInlineSnapshot(`0`);
  });
});

describe('note・emit が投げたとき（catch）', () => {
  it('woken の本文の emit が投げたら、起こし直さず continue へ倒れ、失敗の note が出る。通算は進んでいる（recordSubagentWakeup が emit より前）', async () => {
    const rig = await open({ throwOn: throwOnce(isSubagentNote) });
    await register(rig, 'bg-1', 'agent-1');
    await finish(rig, 'bg-1');
    const failed = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1')],
    });
    await register(rig, 'bg-2', 'agent-1');
    await finish(rig, 'bg-2');
    const next = await fireStop(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-2')],
    });
    expect({
      failed,
      nextFirstLine: contextOf(next)?.split('\n').at(-1),
      notes: (viewNotes(rig.events) as unknown[]).map((view) =>
        typeof view === 'string' ? view.slice(0, 60) : view,
      ),
    }).toMatchInlineSnapshot(`
      {
        "failed": {
          "continue": true,
        },
        "nextFirstLine": "これはこの作業者の通算 2回目の起こし直し。",
        "notes": [
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 1,
              "sessionTaskCount": 1,
              "wakeupCount": 1,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 1回目）。 stop_hook_active=false。
      - id=bg-1 command=pnpm verify type=shell status=running description=背景のシェル
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
          "SubagentStop の観測に失敗した: Error: emit が落ちた（テスト用）",
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "woken",
              "ownedTaskCount": 1,
              "sessionTaskCount": 1,
              "wakeupCount": 2,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この作業者が自分で起こした背景処理が 1件 残ったまま畳もうとした**（この瞬間のセッション全体の在庫=1件、session_crons=0件）。**完了を待ってから起こし直した**（この作業者の通算 2回目）。 stop_hook_active=false。
      - id=bg-2 command=pnpm verify type=shell status=running description=背景のシェル
      ⚠️ この行が出ないことは「空転が無かった」を意味しない — このフックは、作業者が畳んだ瞬間に親のターンが開いていたときにしか発火しない（#570）。",
          },
        ],
      }
    `);
  });

  it('limit_reached の emit が投げたら、recordCutOff を通らない（emit が recordCutOff より前）。通算の間引きは進んでいる', async () => {
    const rig = await open({ throwOn: throwOnce(isSubagentNote) });
    await register(rig, 'bg-1', 'agent-1');
    const failed = await stopUntilLimit(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1')],
    });
    const annotated = await fire(rig, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { prompt: '作業' },
      tool_response: { status: 'completed', agentId: 'agent-1', content: [] },
    });
    const next = await stopUntilLimit(rig, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-1')],
    });
    expect({
      failed,
      next,
      annotated: contextOf(annotated),
      notes: (viewNotes(rig.events) as unknown[]).map((view) =>
        typeof view === 'object' && view !== null && 'text' in view
          ? {
              ...(view as object),
              text: String((view as { text: string }).text).slice(0, 50),
            }
          : String(view).slice(0, 60),
      ),
    }).toMatchInlineSnapshot(`
      {
        "annotated": undefined,
        "failed": {
          "continue": true,
        },
        "next": {
          "continue": true,
        },
        "notes": [
          {
            "escalate": true,
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "limit_reached",
              "ownedTaskCount": 1,
              "sessionTaskCount": 1,
              "wakeupCount": 0,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この",
          },
          "SubagentStop の観測に失敗した: Error: emit が落ちた（テスト用）",
          {
            "stall": {
              "agentId": "agent-1",
              "agentType": "worker",
              "outcome": "limit_reached",
              "ownedTaskCount": 1,
              "sessionTaskCount": 1,
              "wakeupCount": 0,
            },
            "text": "SubagentStop（作業者: worker / agent_id=agent-1）: **この",
          },
        ],
      }
    `);
  });

  it('所有者を引けない診断の note が投げても、診断は済んだ扱い（旗は note の前に立つ）。失敗の note が 1 本出て、2 回目は出ない', async () => {
    const rig = await open({ throwOn: throwOnce(isSubagentNote) });
    const orphan = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [bg('bg-orphan')],
    };
    const first = await fireStop(rig, orphan);
    const second = await fireStop(rig, orphan);
    expect({
      first,
      second,
      notes: (viewNotes(rig.events) as string[]).map((text) => text.slice(0, 50)),
    }).toMatchInlineSnapshot(`
      {
        "first": {
          "continue": true,
        },
        "notes": [
          "SubagentStop: 背景処理の**所有者を引けなかった**（1件。id=bg-orphan ",
          "SubagentStop の観測に失敗した: Error: emit が落ちた（テスト用）",
        ],
        "second": {
          "continue": true,
        },
      }
    `);
  });

  it('終わった側だけの診断の note が投げても、診断は済んだ扱い（旗は note の前に立つ）。失敗の note が 1 本出て、2 回目は出ない', async () => {
    const rig = await open({ throwOn: throwOnce(isSubagentNote) });
    await register(rig, 'bg-s', 'agent-2');
    const settled = {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [bg('bg-s', 'completed')],
    };
    const first = await fireStop(rig, settled);
    const second = await fireStop(rig, settled);
    expect({
      first,
      second,
      notes: (viewNotes(rig.events) as string[]).map((text) => text.slice(0, 50)),
    }).toMatchInlineSnapshot(`
      {
        "first": {
          "continue": true,
        },
        "notes": [
          "SubagentStop: 当人が起こした背景処理が 1件 配列に載っていたが、**status は",
          "SubagentStop の観測に失敗した: Error: emit が落ちた（テスト用）",
        ],
        "second": {
          "continue": true,
        },
      }
    `);
  });
});

describe('待ちの解け方（#waitForBackgroundTasks）', () => {
  const stopInput = (id: string) => ({
    ...STOP_BASE,
    agent_id: 'agent-1',
    background_tasks: [bg(id)],
  });

  async function flag(promise: Promise<unknown>): Promise<{ done: boolean }> {
    const state = { done: false };
    void promise.then(() => {
      state.done = true;
    });
    return state;
  }

  it('background_tasks_changed に載っていたものが載らなくなったら解ける。載ったことが無ければ、載っていないだけでは解けない', async () => {
    const rig = await open();
    await register(rig, 'bg-never', 'agent-1');
    await register(rig, 'bg-seen', 'agent-1');
    const never = await flag(fireStop(rig, stopInput('bg-never')));
    rig.started.liveTasks([]);
    await tick();
    const neverAfterEmpty = never.done;

    const seen = await flag(fireStop(rig, stopInput('bg-seen')));
    rig.started.liveTasks(['bg-seen']);
    await tick();
    const seenWhileLive = seen.done;
    rig.started.liveTasks([]);
    await tick();
    expect({ neverAfterEmpty, seenWhileLive, seenAfterGone: seen.done }).toMatchInlineSnapshot(`
      {
        "neverAfterEmpty": false,
        "seenAfterGone": true,
        "seenWhileLive": false,
      }
    `);
  });

  it('待ちの上限の 1 ミリ秒前までは解けず、ちょうどで timeout になる', async () => {
    const rig = await open();
    await register(rig, 'bg-1', 'agent-1');
    vi.useFakeTimers();
    try {
      const state = await flag(fireStop(rig, stopInput('bg-1')));
      await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS - 1);
      const before = state.done;
      const notesBefore = subagentNotes(rig.events).length;
      await vi.advanceTimersByTimeAsync(1);
      expect({
        before,
        notesBefore,
        after: state.done,
        notesAfter: subagentNotes(rig.events).length,
      }).toMatchInlineSnapshot(`
        {
          "after": true,
          "before": false,
          "notesAfter": 1,
          "notesBefore": 0,
        }
      `);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#markProgressed を呼ばない（resume の作り直しで観測）', () => {
  // SubagentStop だけを受けた resume は「まだ手が動いていない」ままなので、そのあとセッションが黙って落ちると作り直す（resume_failed）。
  // 対照: 観測が手が動いた印を立てるなら、作り直さず closed で終わる。
  async function resumeThenStop(
    makeInput: (rig: Rig) => Promise<Record<string, unknown>>,
  ): Promise<{ resumeFailed: number; closed: number; sessions: number }> {
    const events: RunnerEvent[] = [];
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => events.push(event),
      queryFn: fn,
      env: {},
    });
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: dir,
      request: '最初の依頼',
      // 素材を 1 件渡す: 空だと作り直さない理由が `#progressed` だと確かめられない
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });
    const first = await vi.waitFor(() => {
      const found = started[0];
      if (found === undefined) throw new Error('セッションがまだ開いていない');
      return found;
    });
    const rig = { started: first, events };
    await fireStop(rig, await makeInput(rig));
    await tick();
    first.finish();
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === 'resume_failed' || e.type === 'closed')) {
        throw new Error('resume_failed も closed もまだ来ていない');
      }
    });
    return {
      resumeFailed: events.filter((e) => e.type === 'resume_failed').length,
      closed: events.filter((e) => e.type === 'closed').length,
      sessions: started.length,
    };
  }

  // 起こし直す・打ち切る回は、所有者を表へ載せる PostToolUse（Bash）が先に手が動いた印を立てるので、この方法では観測できない
  it('診断の回だけ受けても、落ちれば作り直す', async () => {
    expect(
      await resumeThenStop(async () => ({
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [bg('bg-orphan')],
      })),
    ).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });

  it('読み取りに失敗した回だけ受けても、落ちれば作り直す', async () => {
    expect(
      await resumeThenStop(async () => {
        const input: Record<string, unknown> = { ...STOP_BASE, agent_id: 'agent-1' };
        Object.defineProperty(input, 'background_tasks', {
          enumerable: true,
          get(): never {
            throw new Error('boom');
          },
        });
        return input;
      }),
    ).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });
});

describe('周回（await の位置・回数を動かさない）', () => {
  async function observe(
    rig: Rig,
    act: () => Promise<HookJSONOutput>,
    afterCall?: () => void,
  ): Promise<{ noteSync: number; notesAtTick: number[]; settledAtTick: number }> {
    const before = subagentNotes(rig.events).length;
    const promise = act();
    // フックを呼んだ直後（await なし）に出ている note の本数
    const noteSync = subagentNotes(rig.events).length - before;
    afterCall?.();
    let ticks = 0;
    let settledAtTick = -1;
    void promise.then(() => {
      settledAtTick = ticks;
    });
    const notesAtTick: number[] = [];
    while (settledAtTick < 0 && ticks < 50) {
      await Promise.resolve();
      ticks += 1;
      notesAtTick.push(subagentNotes(rig.events).length - before);
    }
    return { noteSync, notesAtTick, settledAtTick };
  }

  it('各枝の、呼んだ直後に出ている note の本数・戻りまでの周回数・周回ごとの note の本数（待ちが即座に終わる形で固定）', async () => {
    const seen: Record<string, unknown> = {};

    // 診断（所有者を引けない）・終わった側だけ・読み取りの失敗: await に入る前に返る
    {
      const rig = await open();
      seen['orphan'] = await observe(rig, () =>
        fireStop(rig, { ...STOP_BASE, agent_id: 'agent-1', background_tasks: [bg('bg-o')] }),
      );
      await host?.shutdown().catch(() => undefined);
    }
    {
      const rig = await open();
      await register(rig, 'bg-s', 'agent-1');
      seen['settledOnly'] = await observe(rig, () =>
        fireStop(rig, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [bg('bg-s', 'completed')],
        }),
      );
      await host?.shutdown().catch(() => undefined);
    }
    {
      const rig = await open();
      const input: Record<string, unknown> = { ...STOP_BASE, agent_id: 'agent-1' };
      Object.defineProperty(input, 'background_tasks', {
        enumerable: true,
        get(): never {
          throw new Error('boom');
        },
      });
      seen['failed'] = await observe(rig, () => fireStop(rig, input));
      await host?.shutdown().catch(() => undefined);
    }
    // 待ちが即座に終わる（完了通知が先に届いている）: woken
    {
      const rig = await open();
      await register(rig, 'bg-w', 'agent-1');
      await finish(rig, 'bg-w');
      seen['woken'] = await observe(rig, () =>
        fireStop(rig, { ...STOP_BASE, agent_id: 'agent-1', background_tasks: [bg('bg-w')] }),
      );
      await host?.shutdown().catch(() => undefined);
    }
    // 既に stop 済み: released（待ちに入らない）
    {
      const rig = await open();
      await register(rig, 'bg-r', 'agent-1');
      await host?.shutdown().catch(() => undefined);
      seen['releasedBeforeWait'] = await observe(rig, () =>
        fireStop(rig, { ...STOP_BASE, agent_id: 'agent-1', background_tasks: [bg('bg-r')] }),
      );
    }
    // 待ちの途中で畳まれる: released（待ちの解き → 継続）
    {
      const rig = await open();
      await register(rig, 'bg-m', 'agent-1');
      const pending = fireStop(rig, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [bg('bg-m')],
      });
      await tick();
      const before = subagentNotes(rig.events).length;
      let ticks = 0;
      let settledAtTick = -1;
      void pending.then(() => {
        settledAtTick = ticks;
      });
      // 同期の解き（畳む）のあとの周回を数える
      void host?.shutdown();
      const notesAtTick: number[] = [];
      while (settledAtTick < 0 && ticks < 80) {
        await Promise.resolve();
        ticks += 1;
        notesAtTick.push(subagentNotes(rig.events).length - before);
      }
      seen['releasedMidWait'] = {
        settledAtTick,
        firstNoteTick: notesAtTick.findIndex((n) => n > 0),
      };
    }
    // 待ちの上限: timeout（偽のタイマーを同期で進めた後の周回）
    {
      const rig = await open();
      await register(rig, 'bg-t', 'agent-1');
      vi.useFakeTimers();
      try {
        const pending = fireStop(rig, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [bg('bg-t')],
        });
        // 待ちに入るまでの周回（register の後の hook 内の await）を流す
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        const before = subagentNotes(rig.events).length;
        vi.advanceTimersByTime(SUBAGENT_BACKGROUND_WAIT_MS);
        let ticks = 0;
        let settledAtTick = -1;
        void pending.then(() => {
          settledAtTick = ticks;
        });
        const notesAtTick: number[] = [];
        while (settledAtTick < 0 && ticks < 80) {
          await Promise.resolve();
          ticks += 1;
          notesAtTick.push(subagentNotes(rig.events).length - before);
        }
        seen['timeout'] = { settledAtTick, firstNoteTick: notesAtTick.findIndex((n) => n > 0) };
      } finally {
        vi.useRealTimers();
      }
    }
    expect(seen).toMatchInlineSnapshot(`
      {
        "failed": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "orphan": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "releasedBeforeWait": {
          "noteSync": 0,
          "notesAtTick": [
            1,
            1,
            1,
            1,
          ],
          "settledAtTick": 3,
        },
        "releasedMidWait": {
          "firstNoteTick": 1,
          "settledAtTick": 4,
        },
        "settledOnly": {
          "noteSync": 1,
          "notesAtTick": [
            1,
            1,
            1,
          ],
          "settledAtTick": 2,
        },
        "timeout": {
          "firstNoteTick": 1,
          "settledAtTick": 4,
        },
        "woken": {
          "noteSync": 0,
          "notesAtTick": [
            0,
            1,
            1,
            1,
            1,
          ],
          "settledAtTick": 4,
        },
      }
    `);
  });
});
