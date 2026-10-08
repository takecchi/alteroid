import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  SDKTaskUpdatedMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, SUBAGENT_BACKGROUND_WAIT_MS } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

/**
 * `SubagentStop` フックの観測口（#357 / #570）を確かめる。
 *
 * **「当人が起こしたものだけを出す」ことが本題である。**
 * 実測（SDK 0.3.247。#570 に生 JSON）で分かったのは3つ:
 *
 * 1. `background_tasks` には**畳もうとしている当人**が必ず入る（`id` = `agent_id`）
 * 2. **兄弟の作業者**も入る（何も待っていない作業者の配列にも載る）
 * 3. ⟹ **件数では「この作業者が待っている」が言えない。**所有者は
 *    `PostToolUse` の `tool_response.backgroundTaskId` と `agent_id` から引く
 *
 * だからここで固定するのは「**誤爆しないこと**」が中心である —— 当人だけ・
 * 兄弟だけでは何も返さない。起こし直す（`additionalContext` を返す）のは、
 * 当人が自分で起こした背景処理が残っているときだけである。
 *
 * ## ⚠️ 変更した事実（このファイルはこの PR で反転させた）
 *
 * **以前はここで「どのケースでも戻り値は必ず `{ continue: true }`
 * （挙動を変えない。`decision` も `additionalContext` も返さない）」を
 * 固定していた（PR #594。観測専用だった時期）。この PR はその固定を反転
 * させた** —— 当人が自分で起こした背景処理が残っているとき（`mine.length
 * > 0`）は、起こし直しの上限に達するまで `hookSpecificOutput.additionalContext`
 * を返し、作業者をその場で継続させる。
 *
 * **なぜ必要になったか。** #570 のクローズコメントに逐語で「この Issue が
 * 閉じたのは『ターンが閉じた瞬間の値が器から使えるようになったか』で
 * あって、『空転が止まったか』ではない」とあるとおり、観測専用のままでは
 * 検出できていても委譲は黙って止まったままだった。
 *
 * **なぜ保証が弱くなっていないか。** `mine.length === 0`（当人だけ・
 * 兄弟だけ・別の作業者の分・マネージャー自身の分）の4本の歯は一切変えて
 * いない —— それらは今もそのまま `{ continue: true }` ちょうどを固定して
 * おり、**起こし直しの対象を広げていないこと**を検算する（下の各テストの
 * doc に経緯を追記した）。
 *
 * ## ⚠️ さらに反転させた事実（Issue #3008。起こし直しの回数の上限を外した）
 *
 * **以前は、起こし直しの回数の上限（背景処理1本あたり2回・作業者の通算8回）をここで固定して
 * いた。** 回数で暴走を止める形は AGENTS.md の地雷（追加の実行回数制限）に当たり、8 の根拠は
 * 実測ではなかったので、上限を外した。いまここで固定するのは次の形である。
 *
 * 1. **フックは待つ。** 当人が起こした背景処理が running のまま残っていると、フックは**返らない**。
 *    その作業者の背景処理が全部終わる（`task_notification` が来る、または
 *    `background_tasks_changed` で載っていたものが載らなくなる）と、**1回だけ**起こし直す。
 * 2. **待ちには時間の上限がある**（`SUBAGENT_BACKGROUND_WAIT_MS` = 30分。偽の時計で進める）。
 *    達したら `limit_reached` の経路（note・間引いた escalate・`recordCutOff`）を通る。
 * 3. **回数では止めない。** 旧い上限（8）を超える回数でも、背景処理が毎回本当に終わっていれば
 *    毎回起こし直す。
 * 4. **待ちの途中でセッションが畳まれたら、フックは起こし直さずに返る。**
 * 5. **別の作業者の背景処理は、待ちの条件に入らない。**
 *
 * 実時間の待ちは使わない（偽の時計・完了通知で進める）。
 *
 * `agent-session-options.test.ts` の `fakeRunnerSdk`（`host.start` が同期に
 * `queryFn` を呼ぶことを利用して `options` を捕まえる形）と同じ足場を使う。
 */
interface Started {
  options: Options;
  finish: () => void;
  /**
   * もう一度 `init`（`case 'session_started'`、`runner.ts`）を流す。
   * **ターンをまたいでも `#subagentWakeups` の上限が再装填されないこと**
   * （#643 の形）を確かめるためだけに足した——`fakeRunnerSdk` は元々
   * 1回 `init` を出したあとブロックするだけだったので、2本目を送る経路が
   * 無かった。`runner-background-tasks.test.ts` の `FakeSession.restart` と
   * 同じ形（`sessionId` を明示させ、同じ値なら「ターンの頭が来ただけ」、
   * 違う値なら「器が入れ替わった」を表す）。
   */
  restart: (sessionId: string) => void;
  /**
   * `system/task_notification` を1件流す（#901）。`task_notification` には
   * 対応するフックが無い（`hook_event_name` を持つ SDK の全種を静的に確認
   * 済み——`runner.ts` の `#pendingCutOffNotifications` の doc）ので、
   * `PostToolUse`/`SubagentStop` のようにフックを直接叩く形では再現できない。
   * `restart` と同じ要領で、生の `SDKMessage` をストリームへ流す。
   *
   * **`extra`（Issue #1554）——既定の欄を上書きする。** `output_file` を
   * 落とした形（`{ output_file: undefined }`）を確かめる歯で使う。
   */
  notify: (taskId: string, extra?: Record<string, unknown>) => void;
  /**
   * `system/background_tasks_changed` を1件流す（Issue #3008）。`liveBackgroundTasks`
   * （REPLACE 意味論）を `ids` へ入れ替える。**フックの中で待っている者の「終わった」の主な
   * 材料**（載っているのを見たあとで載らなくなる）を作る。
   */
  liveTasks: (ids: readonly string[]) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      restart: (sessionId: string) =>
        emit?.({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          uuid: `uuid-restart-${sessionId}`,
        } as unknown as SDKMessage),
      notify: (taskId: string, extra: Record<string, unknown> = {}) =>
        emit?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
          output_file: '/tmp/does-not-exist.txt',
          summary: '完了',
          session_id: `sess-${started.length}`,
          uuid: `uuid-task-notification-${taskId}`,
          ...extra,
        } as unknown as SDKMessage),
      liveTasks: (ids: readonly string[]) =>
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
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

/** `options.hooks.SubagentStop[0].hooks[0]` を直接叩く。 */
async function fireSubagentStop(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.SubagentStop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('SubagentStop フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

/** `options.hooks.PostToolUse[0].hooks[0]` を直接叩く（所有者の表を作る側）。 */
async function firePostToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

/** 作業者（`agentId`）が背景タスク `taskId` を起こしたことを、表へ登録させる。 */
async function registerBackgroundTask(
  options: Options,
  taskId: string,
  agentId?: string,
): Promise<void> {
  await firePostToolUse(options, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 90', run_in_background: true },
    tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
    ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
  });
}

/**
 * `system/task_notification` を1件流し、`runner.ts` の内部で処理されるまで
 * 待つ（#901）。`Started.notify` は同期にストリームへ流すだけなので、
 * メッセージループが1周してから戻す一呼吸を入れる（`runner-wakeup.test.ts` の
 * `taskNotification` と同じ形）。
 */
async function fireTaskNotification(
  started: Started,
  taskId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  started.notify(taskId, extra);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `SubagentStop` を発火し（フックは背景処理の完了を**待つ**。Issue #3008）、`finishIds` の
 * 完了通知（`task_notification`）を流してから、フックの結果を返す。
 * **フックの Promise は、完了通知が来るまで返らない**（待つ形を呼び出し側から見えるようにする）。
 */
async function stopAfterFinish(
  started: Started,
  input: Record<string, unknown>,
  finishIds: readonly string[],
): Promise<HookJSONOutput> {
  const pending = fireSubagentStop(started.options, input);
  for (const id of finishIds) await fireTaskNotification(started, id);
  return pending;
}

/**
 * `SubagentStop` を発火し、**待ちの上限（`SUBAGENT_BACKGROUND_WAIT_MS`）まで偽の時計を進めて**
 * 打ち切らせる（実時間は待たない）。完了通知は流さない。
 */
async function stopUntilWaitLimit(
  started: Started,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  vi.useFakeTimers();
  try {
    const pending = fireSubagentStop(started.options, input);
    await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/**
 * `stopAfterFinish` の簡便版: 入力の `background_tasks` のうち、当人（`id === agent_id`）以外の
 * 全部の完了通知を流す（＝残っていた背景処理が全部終わった）。status が「終わった」側のものを
 * 混ぜた入力でも、通知は流す（待つ対象に入らないものへ流しても無害）。
 */
async function stopAfterAllFinish(
  started: Started,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const tasks = (input['background_tasks'] ?? []) as { id?: unknown }[];
  const ids = tasks
    .map((task) => task.id)
    .filter((id): id is string => typeof id === 'string' && id !== input['agent_id']);
  return stopAfterFinish(started, input, ids);
}

/** フックが返ったか（返っていなければ `false`）を、1回の microtask 周回だけ待って見る。 */
async function settledWithin(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

/**
 * `system/background_tasks_changed` を1件流し、`runner.ts` の内部で処理されるまで待つ
 * （`fireTaskNotification` と同じ形。Issue #3008）。
 */
async function fireLiveTasks(started: Started, ids: readonly string[]): Promise<void> {
  started.liveTasks(ids);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 当人（`type=subagent`。`id` は `agent_id` と同じ値になる）。 */
function selfEntry(agentId: string) {
  return {
    id: agentId,
    type: 'subagent',
    status: 'running',
    description: '当人',
    agent_type: 'worker',
  };
}

const STOP_BASE = {
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_transcript_path: '/tmp/does-not-exist.jsonl',
  agent_type: 'worker',
  session_crons: [],
};

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-subagent-stop-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function setup(): { host: RunnerHost; events: RunnerEvent[]; started: Started[] } {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
  });
  return { host, events, started };
}

describe('SubagentStop の観測（#357 / #570）', () => {
  // ⚠️ `mine.length === 0` の4本（この歯を含む）は、起こし直しを足した
  // この PR でも一切変えていない —— 起こし直しの対象を広げていないことの
  // 検算（ファイル冒頭の doc の「なぜ保証が弱くなっていないか」）。
  it('当人だけが載った配列では note を出さない（当人は必ず入るので、それは署名ではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1')],
    });

    expect(result).toEqual({ continue: true });
    console.log('DBGNOTE', JSON.stringify(noteEvents(s.events)));
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  // ⚠️ 同上（`mine.length === 0` は不変）。
  it('兄弟の作業者が走っているだけでは note を出さない（誤爆しないこと）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'agent-2',
          type: 'subagent',
          status: 'running',
          description: '兄弟',
          agent_type: 'worker',
        },
      ],
    });

    expect(result).toEqual({ continue: true });
    console.log('DBGNOTE', JSON.stringify(noteEvents(s.events)));
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  /**
   * **待つ形の歯（Issue #3008）。** 当人が起こした背景処理が running のまま残っていると、
   * フックは**返らない**。その背景処理の完了通知が届くと、**1回だけ**起こし直す
   * （`additionalContext`）。`note` 側の主張（件数・type/status/command・発火条件の断り）は
   * 変えていない。
   */
  it('当人が自分で起こした背景処理が残っていれば、終わるまでフックは返らず、終わったら1回だけ起こし直す。note にも type と status と command が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'shell',
          status: 'running',
          description: 'pnpm verify を実行中',
          command: 'pnpm verify',
        },
      ],
    });

    // **(a) 終わるまで返らない。** 通知を流す前は、note も出ていない。
    expect(await settledWithin(pending)).toBe(false);
    expect(noteEvents(s.events)).toHaveLength(0);

    // 完了通知（`output_file` つき）が届くと、1回だけ起こし直す。
    await fireTaskNotification(started, 'bg-1', { output_file: '/tmp/out-3008.txt' });
    const result = await pending;

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('1件');
    expect(additionalContext).toContain('背景処理は終わった');
    expect(additionalContext).toContain('結果（出力）を読んでから畳むこと');
    // **終わった背景処理の id・command・出力の置き場所が載る。**
    expect(additionalContext).toContain('id=bg-1 command=pnpm verify');
    expect(additionalContext).toContain('出力: /tmp/out-3008.txt');
    expect(additionalContext).toContain('これはこの作業者の通算 1回目の起こし直し');
    // 回数の上限の文言は無い（上限は外した）。
    expect(additionalContext).not.toContain('通し上限');
    expect(additionalContext).not.toContain('1本あたりの上限');
    expect(additionalContext).not.toContain('文字で切った');

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('id=bg-1');
    expect(text).toContain('type=shell');
    expect(text).toContain('status=running');
    expect(text).toContain('command=pnpm verify');
    expect(text).toContain('1件 残ったまま畳もうとした');
    expect(text).toContain('在庫=2件');
    expect(text).toContain('完了を待ってから起こし直した');
    expect(text).toContain('この作業者の通算 1回目');
    // 発火条件の断りを本文にも書く（doc だけに書くと、片方しか読まない人が誤る）。
    expect(text).toContain('空転が無かった');
    expect(notes[0]?.escalate).toBeUndefined();
    expect(text).not.toContain('文字で切った');

    expect(notes[0]?.stall).toEqual({
      agentId: 'agent-1',
      agentType: 'worker',
      ownedTaskCount: 1,
      sessionTaskCount: 2,
      wakeupCount: 1,
      outcome: 'woken',
    });
  });

  // ⚠️ 同上（`mine.length === 0` は不変。所有者が一致しないので当人の分が無い）。
  it('別の作業者が起こした背景処理では note を出さない（所有者が違う）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-2');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toEqual({ continue: true });
    console.log('DBGNOTE', JSON.stringify(noteEvents(s.events)));
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  // ⚠️ 同上（`mine.length === 0` は不変。マネージャー自身の分は空文字所有者）。
  it('マネージャー自身が起こした背景処理では note を出さない（agent_id が付かない実行）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // `agent_id` を渡さない = マネージャー自身の実行（実測でそうなる）。
    await registerBackgroundTask(started.options, 'bg-1');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toEqual({ continue: true });
    console.log('DBGNOTE', JSON.stringify(noteEvents(s.events)));
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  // ⚠️ 同上（`mine.length === 0`。`bg-unknown` は誰の所有としても表に無い）。
  it('所有者を引けない背景処理が在ると診断が出る。ただしセッションに1回だけ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const input = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      // `bg-unknown` は表に無い（＝ `PostToolUse` の経路が壊れたときの顔）。
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-unknown', type: 'shell', status: 'running' },
      ],
    };

    const first = await fireSubagentStop(started.options, input);
    expect(first).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('所有者を引けなかった');
    expect(text).toContain('bg-unknown');
    // 読んだ人が次に何をすればよいかを書く（値を出すだけにしない）。
    expect(text).toContain('#570');

    const second = await fireSubagentStop(started.options, input);
    expect(second).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(1);
  });

  /**
   * ⭐ **判定は「性質」を測る。「実例」ではない**（#570）。
   *
   * 所有者を控えられるのは `OWNER_RECORDABLE_TASK_TYPES`（いまは `shell` だけ）で、
   * `Monitor` / `Workflow` / 遠隔の `Task` はどれも `tool_response` に
   * `backgroundTaskId` を持たない ⟹ **表に載らないのが正常であり、診断の対象ではない。**
   *
   * **PR #594 の除外（`type !== 'subagent'`）はこの4件を落としていた** —— 除外が
   * 「表に無いのが正常」という性質ではなく、その実例の1つ（委譲そのもの）を測って
   * いたためである。⟹ `Monitor` を1度でも起こしたセッションでは、**設計どおりに
   * 動いているのに「所有者を引く経路が壊れた」という診断が出ていた。**
   *
   * ⛔ **直下の（対照）と対で読むこと。** こちらだけなら、診断そのものを消しても緑になる。
   * ⛔ **1件では足りない。** 種類を1つだけ挙げると、同じ形の誤り（実例を測る条件）がまた通る。
   */
  it.each(['monitor', 'workflow', 'local_workflow', 'remote_agent'])(
    'type=%s が表に無くても診断は出さない（控えられないのが正常）',
    async (type) => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [selfEntry('agent-1'), { id: `bg-${type}`, type, status: 'running' }],
      });

      expect(result).toEqual({ continue: true });
      expect(noteEvents(s.events)).toHaveLength(0);
    },
  );

  // ⭐ 直上の対照。**診断そのものを消していない**ことを測る —— これが無いと、
  // 直上の4本は「`#noteOwnerLookupFailure` を常に無音にする」変異でも緑になる。
  it('（対照）同じ形でも type=shell なら診断が出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-shell', type: 'shell', status: 'running' },
      ],
    });

    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('所有者を引けなかった');
    expect(notes[0]?.text).toContain('bg-shell');
  });

  // ⚠️ 同上（`mine.length === 0`）。
  it('当人・兄弟しか無いときは、診断も出さない（引けないのではなく、引く対象が無い）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'agent-2', type: 'subagent', status: 'running', description: '兄弟' },
      ],
    });

    expect(noteEvents(s.events)).toHaveLength(0);
  });

  /**
   * ⚠️ **反転させた歯（この PR）。** `mine.length > 0` なので、この呼び出し
   * （`agent-1` にとって最初の1回）でも起こし直しが起きる。上限の対象は
   * `note.text` だけでなく `additionalContext` にも掛けている
   * （`#truncateSubagentStopText` を両方が使う）ので、両方が切られることを見る。
   */
  it('text が長すぎる入力では note も additionalContext も上限で切られ、切ったことが末尾に書かれる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const longDescription = 'あ'.repeat(5_000);
    // `additionalContext` には description ではなく command が載る（終わった背景処理の行）ので、
    // 両方を長くして、note と additionalContext の両方が切られることを見る。
    const result = await stopAfterFinish(
      started,
      {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          {
            id: 'bg-1',
            type: 'shell',
            status: 'running',
            description: longDescription,
            command: longDescription,
          },
        ],
      },
      ['bg-1'],
    );

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    // 元の説明をそのまま含めば5,000文字を超えるはずなので、上限より十分短い
    // ことを確かめれば「切られた」ことになる。
    expect(additionalContext.length).toBeLessThan(longDescription.length);
    expect(additionalContext).toContain('文字で切った');

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text.length).toBeLessThan(longDescription.length);
    expect(text).toContain('文字で切った');
  });

  /**
   * Issue #1554: 上限に達した note へ足した2行（「出力の置き場所は、処理が
   * 終わったら知らせる」・続きを頼む案内）は、`id=` / `command=`（`taskLines`）
   * より**後ろ**に置いてある——切られるなら、読み手がいちばん要る具体的な
   * 材料（id / command）ではなく、この2行が先に切られる側へ倒す設計である
   * ことを、実際に上限を超える長さの入力で確かめる。
   */
  it('待ちの上限に達した note が長すぎて切られても、id / command は生き残り、切られるのは末尾の案内文である', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    // description を長くして、note 全体を `SUBAGENT_STOP_NOTE_TEXT_LIMIT` より確実に超えさせる。
    const longDescription = 'あ'.repeat(5_000);
    const overLimitResult = await stopUntilWaitLimit(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'monitor',
          status: 'running',
          command: 'pnpm test',
          description: longDescription,
        },
      ],
    });
    expect(overLimitResult).toEqual({ continue: true });

    const escalated = noteEvents(s.events).at(-1);
    expect(escalated?.text).toContain('文字で切った');
    // **生き残る側 —— id / command は taskLines の一部で、末尾の案内文より
    // 前に置いてあるので切られない。**
    expect(escalated?.text).toContain('id=bg-1');
    expect(escalated?.text).toContain('command=pnpm test');
    // **切られる側 —— 末尾に置いた2行は、この長さでは残らない。**
    expect(escalated?.text).not.toContain('出力の置き場所は');
    expect(escalated?.text).not.toContain('SendMessage');
  });

  /**
   * **回数では止めない（Issue #3008）。** 旧い通し上限（8）を超える回数でも、背景処理が
   * 毎回**本当に終わっていれば**、毎回起こし直す（打ち切りは起きない）。毎回別の背景処理を
   * 起こして畳む作業者（穴A）も、各回は「背景処理が終わった後の1ターン」なので止めない。
   * `note.stall.wakeupCount`（観測専用の通算）は増え続ける。
   */
  it('旧い上限（8）を超える回数でも、背景処理が毎回終わっていれば毎回起こし直す（打ち切りは起きない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const attempts = Array.from({ length: 12 }, (_unused, i) => i + 1);
    for (const n of attempts) {
      await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
      const result = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-${n}`, type: 'monitor', status: 'running', description: `CI の見張り ${n}` },
          ],
        },
        [`bg-${n}`],
      );
      expect(result).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: 'SubagentStop' },
      });
      const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      expect(additionalContext).toContain(`これはこの作業者の通算 ${String(n)}回目の起こし直し`);
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(attempts.length);
    expect(notes[0]?.text).toContain('type=monitor');
    expect(notes.at(-1)?.text).toContain(`CI の見張り ${String(attempts.length)}`);
    // **全部 woken。limit_reached も escalate も無い。**
    for (const note of notes) {
      expect(note.stall?.outcome).toBe('woken');
      expect(note.escalate).toBeUndefined();
    }
    expect(notes.at(-1)?.stall?.wakeupCount).toBe(attempts.length);
  });

  /**
   * **(f) 別の作業者の背景処理は、待ちの条件に入らない（Issue #3008）。** 待つのは、畳もうと
   * している当人（`agent-1`）が起こした背景処理だけである。兄弟（`agent-2`）が起こした背景処理が
   * 走り続けていても、`agent-1` の背景処理が終われば `agent-1` は起こし直される。
   */
  it('別の作業者の背景処理は待ちの条件に入らない（当人の分が終われば、兄弟の分が走っていても起こし直す）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-mine', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-sibling', 'agent-2');

    const result = await stopAfterFinish(
      started,
      {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-mine', type: 'shell', status: 'running', command: 'pnpm test' },
          // 兄弟の背景処理。これは終わらせない。
          { id: 'bg-sibling', type: 'shell', status: 'running', command: 'pnpm lint' },
        ],
      },
      ['bg-mine'],
    );

    expect(result).toHaveProperty('hookSpecificOutput');
    const context = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('id=bg-mine');
    // 兄弟の分は、起こし直しの文面にも載らない。
    expect(context).not.toContain('bg-sibling');
  });

  /**
   * 1回に複数の背景処理が残っていたら、**全部**が終わるまで返らない（先頭の1本が終わっただけでは
   * 起こし直さない）。全部終わった1回で、全件の id・出力の置き場所を渡す。
   */
  it('1回に複数の背景処理が残っていたら、全部が終わるまで返らず、全部終わったら1回だけ起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-x', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-y', 'agent-1');

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-x', type: 'monitor', status: 'running' },
        { id: 'bg-y', type: 'monitor', status: 'running' },
      ],
    });

    await fireTaskNotification(started, 'bg-x', { output_file: '/tmp/x.txt' });
    // **2本のうち1本が終わっただけでは返らない。**
    expect(await settledWithin(pending)).toBe(false);

    await fireTaskNotification(started, 'bg-y', { output_file: '/tmp/y.txt' });
    const second = await pending;
    const context = (second as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('2件');
    expect(context).toContain('id=bg-x');
    expect(context).toContain('/tmp/x.txt');
    expect(context).toContain('id=bg-y');
    expect(context).toContain('/tmp/y.txt');
    expect(noteEvents(s.events)).toHaveLength(1);
  });

  /**
   * **(a・主) `background_tasks_changed`（`liveBackgroundTasks`）が、完了通知なしでも「終わった」の
   * 材料になる。** 載っているのを見たあとで載らなくなったら、終わったとする。
   */
  it('background_tasks_changed で載っていた背景処理が載らなくなったら、完了通知が無くても起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireLiveTasks(started, ['bg-1']);

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    // 載っている間は返らない。
    expect(await settledWithin(pending)).toBe(false);
    await fireLiveTasks(started, ['bg-1']);
    expect(await settledWithin(pending)).toBe(false);

    // 載らなくなった（完了）。
    await fireLiveTasks(started, []);
    expect(await pending).toHaveProperty('hookSpecificOutput');
  });

  /**
   * ⚠️ **「載っていない」だけでは終わりとしない。** 載っていたことを見ていない id は、
   * `background_tasks_changed` の id 空間が違う（誰も実測していない）場合と区別が付かない。
   * ここを「載っていない＝終わった」にすると、待たずに毎回起こし直す＝回数の上限が無い
   * 状態で空転が無限になる。
   */
  it('liveBackgroundTasks に載っていたことが無い背景処理は、載っていないだけでは終わったとしない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    // 別の id だけが載っている（bg-1 は一度も載らない）。
    await fireLiveTasks(started, ['something-else']);

    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    await fireLiveTasks(started, []);
    expect(await settledWithin(pending)).toBe(false);

    // 完了通知が来て初めて終わる。
    await fireTaskNotification(started, 'bg-1');
    expect(await pending).toHaveProperty('hookSpecificOutput');
  });

  /** フックの発火より**前**に届いていた完了通知も「終わった」として数える（待たずに起こす）。 */
  it('フックの発火より前に完了通知が届いていた背景処理は、待たずに起こし直す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireTaskNotification(started, 'bg-1', { output_file: '/tmp/early.txt' });

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    const context = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('/tmp/early.txt');
  });

  /**
   * **待ちの上限（30分。偽の時計）に達したら、起こし直さず `limit_reached` で打ち切る。**
   * 追加の文脈は返さず、`escalate: true` の `note`（1回目は必ず上げる。#1385）を出し、
   * 残っていた背景処理の id / command を `recordCutOff` 経由で控える（#1475 / #1502 / #1554）。
   * `outcome` のスキーマは変えていない。
   */
  describe('待ちの上限（30分）に達したら', () => {
    it('起こし直さず、escalate な limit_reached の note が出る。文言は「待ちの上限」である', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      const result = await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running', command: 'pnpm test' },
        ],
      });

      // **起こし直さない ⟹ `additionalContext` を返さない。**
      expect(result).toEqual({ continue: true });

      const notes = noteEvents(s.events);
      expect(notes).toHaveLength(1);
      const escalated = notes[0];
      expect(escalated?.escalate).toBe(true);
      expect(escalated?.text).toContain('起こし直さずに打ち切った');
      expect(escalated?.text).toContain('30 分（待ちの上限）');
      // 回数の上限の文言は無い。
      expect(escalated?.text).not.toContain('通し上限');
      expect(escalated?.text).not.toContain('1本あたりの上限');
      // **Issue #1554: 打ち切った note にも id / command が載る。**
      expect(escalated?.text).toContain('id=bg-1');
      expect(escalated?.text).toContain('command=pnpm test');
      expect(escalated?.text).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
      expect(escalated?.text).toContain('ToolSearch');
      expect(escalated?.text).toContain('select:SendMessage');
      expect(escalated?.text).toContain('agentId=agent-1');
      expect(escalated?.text).toContain('即時ではない');
      // `wakeupCount` は起こし直した回数（0）のまま。スキーマの意味を変えない。
      expect(escalated?.stall).toEqual({
        agentId: 'agent-1',
        agentType: 'worker',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: 0,
        outcome: 'limit_reached',
      });
    });

    it('待ちの上限ちょうどの1ミリ秒前までは返らない（上限は SUBAGENT_BACKGROUND_WAIT_MS）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      vi.useFakeTimers();
      try {
        const pending = fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-1', type: 'monitor', status: 'running' },
          ],
        });
        let returned = false;
        void pending.then(() => {
          returned = true;
        });
        await vi.advanceTimersByTimeAsync(SUBAGENT_BACKGROUND_WAIT_MS - 1);
        expect(returned).toBe(false);
        expect(noteEvents(s.events)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(returned).toBe(true);
        expect(noteEvents(s.events).at(-1)?.stall?.outcome).toBe('limit_reached');
      } finally {
        vi.useRealTimers();
      }
    });

    /** 別の agentId は、待ちも打ち切りの数えも独立している。 */
    it('agent_id が違えば独立している（一方が打ち切られても、他方は完了を待って起こし直される）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'a1-bg-1', 'agent-1');
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-1', type: 'monitor', status: 'running' },
        ],
      });

      await registerBackgroundTask(started.options, 'a2-bg-1', 'agent-2');
      const agent2 = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-2',
          background_tasks: [
            selfEntry('agent-2'),
            { id: 'a2-bg-1', type: 'monitor', status: 'running' },
          ],
        },
        ['a2-bg-1'],
      );
      expect(agent2).toHaveProperty('hookSpecificOutput');
      const last = noteEvents(s.events).at(-1);
      expect(last?.stall?.agentId).toBe('agent-2');
      expect(last?.stall?.outcome).toBe('woken');
      expect(last?.escalate).toBeUndefined();
    });

    /**
     * **打ち切ったあとの再試行は、また最大30分待つ。** 打ち切ったことで以降の待ちが
     * 無くなる（旧い「上限に達したら二度と起こさない」）形ではない。
     */
    it('打ち切った後でも、同じ作業者が背景処理を残して畳もうとすれば、また完了を待って起こし直す', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running' },
        ],
      });
      await registerBackgroundTask(started.options, 'bg-2', 'agent-1');
      const result = await stopAfterFinish(
        started,
        {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-2', type: 'monitor', status: 'running' },
          ],
        },
        ['bg-2'],
      );
      expect(result).toHaveProperty('hookSpecificOutput');
    });
  });

  /**
   * **(d) 待ちの途中でセッションが stop されたら、waiter が解けてフックが返る。** 起こし直さず
   * （`additionalContext` なし）、打ち切りでもない（`recordCutOff` を通さない＝後で
   * #901 の「打ち切られていた」注記が出ない）。跡は stall を持たない note で残る。
   */
  it('待っている途中で stop されたら、フックは起こし直さずに返る（打ち切りの注記も出さない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    const pending = fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    expect(await settledWithin(pending)).toBe(false);

    await s.host.shutdown();

    expect(await pending).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('セッションが畳まれた');
    expect(notes[0]?.text).toContain('起こし直さずに返した');
    expect(notes[0]?.stall).toBeUndefined();
    expect(notes[0]?.escalate).toBeUndefined();
  });

  it('既に stop 済みのセッションで発火したフックは、待たずに返る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await s.host.shutdown();

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });
    expect(result).toEqual({ continue: true });
  });

  /**
   * **`#backgroundTaskOwners` の LRU 上限**（`runner.ts` の
   * `BACKGROUND_TASK_OWNER_LIMIT`。直上の歯と同じ形——超えたら「いちばん古い
   * もの」から捨てる）。**この定数も `export` していない**（`export` を求められて
   * いるのは `SUBAGENT_WAKEUP_LIMIT_PER_TASK` / `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`
   * だけ）ので、直上の歯と同じ理由で値を直書きする。ずれたらこの歯が壊れる
   * 形自体が、直書きしたことの検算になる。
   *
   * **`#backgroundTaskOwners` は private なので、中身は直接覗けない。**
   * 観測できるのは `#onSubagentStop` の振る舞いの変化だけである —— 所有者を
   * 引けているあいだは `mine.length > 0` になり起こし直し側
   * （`hookSpecificOutput.additionalContext`）へ落ちるが、表から追い出された
   * 瞬間に `mine.length === 0` へ倒れ、`#noteOwnerLookupFailure` の診断
   * （「所有者を引けなかった」note。1セッションに1回だけ出る）へ落ちる。
   * **この2つの分岐を行き来することそのものが、追い出しが起きたことの証拠に
   * なる**（直上の歯の「カウントが0から再スタートする」と同じ間接観測の形）。
   *
   * **登録は `PostToolUse` だけでよい。** 直上の歯（`#subagentWakeups`）は
   * `SubagentStop` を経由してしか増えないので登録のたびに `fireSubagentStop`
   * も挟んでいたが、`#backgroundTaskOwners` は `#onPostToolUse` から
   * （`registerBackgroundTask` 経由で）増える表なので、`fireSubagentStop` は
   * 最後の観測の1回だけで足りる。
   *
   * **⚠️ 対照が要る。** 直後の歯で、501件積まなければ同じ形の呼び出しが
   * 起こし直し側へ落ちることを確かめる —— 対照が無いと、この歯は
   * `#recordBackgroundTaskOwner` の `while` ループそのものを壊して
   * 「何も捨てなくなる」変異にしか強くならない。
   */
  it('#backgroundTaskOwners は上限（500件）を超えたら、いちばん古い所有者から捨てる（引けなくなる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const ownerLimit = 500;

    // `bg-owner-1` を含む 501 件の所有者を登録する。
    for (let n = 1; n <= ownerLimit + 1; n += 1) {
      await registerBackgroundTask(started.options, `bg-owner-${n}`, `agent-owner-${n}`);
    }

    // **501件目を登録した時点で、いちばん古い `bg-owner-1` の所有者が表から
    // 捨てられているはず。** `agent-owner-1` が `bg-owner-1` を残して畳もうと
    // しても、所有者を引けないので「自分の分」に数えられず、
    // `#noteOwnerLookupFailure` の診断へ落ちる。
    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-owner-1',
      background_tasks: [
        selfEntry('agent-owner-1'),
        { id: 'bg-owner-1', type: 'shell', status: 'running' },
      ],
    });

    // 起こし直し側（`hookSpecificOutput`）へは落ちない —— 所有者が引けない
    // ので `mine.length === 0` のまま、素の `{ continue: true }` を返す。
    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('所有者を引けなかった');
    expect(notes[0]?.text).toContain('bg-owner-1');
  });

  // 直上の歯の対照。501件積まなければ、同じ形の呼び出しで所有者が引けて
  // 起こし直し側（`hookSpecificOutput.additionalContext`）へ落ちる ——
  // これが無いと、直上の歯は LRU の `while` ループを丸ごと壊す変異にしか
  // 強くならない。
  it('（対照）501件積まなければ、同じ所有者は引けて起こし直し側へ落ちる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-owner-1', 'agent-owner-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-owner-1',
      background_tasks: [
        selfEntry('agent-owner-1'),
        { id: 'bg-owner-1', type: 'shell', status: 'running' },
      ],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    // 所有者を引けている（＝ LRU に捨てられていない）ので、追い出し時の
    // 診断（直上の歯が見ているもの）とは別の note（起こし直しの記録）になる。
    expect(notes[0]?.text).not.toContain('所有者を引けなかった');
  });

  /**
   * **`stop_hook_active`（`SubagentStopHookInput` の欄）は取れたときだけ載せる。**
   * 既存のすべてのテストは `STOP_BASE` 経由で常に `false`（＝取れている）を
   * 渡していたので、「取れない」側（欄そのものが無い）を通す歯がここまで
   * 一本も無かった。AGENTS.md 地雷「取れない軸に0の行を作る」——欄が無いのに
   * `stop_hook_active=false` のような既定値の行を作っていないかをここで見る。
   */
  it('stop_hook_active が取れないときは note にその行を作らない（既定値を作らない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const withoutStopHookActive: Record<string, unknown> = { ...STOP_BASE };
    delete withoutStopHookActive.stop_hook_active;
    const result = await stopAfterAllFinish(started, {
      ...withoutStopHookActive,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toHaveProperty('hookSpecificOutput');
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).not.toContain('stop_hook_active');
  });

  /**
   * **`stop_hook_active` が取れているとき（`true`/`false` どちらも）は載せる。**
   * 直上の歯と対にして、「取れたときは載る／取れないときは載らない」の両側を
   * 固定する。
   */
  it('stop_hook_active が取れているときは note にその値を載せる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      stop_hook_active: true,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', status: 'running' }],
    });

    expect(result).toHaveProperty('hookSpecificOutput');
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('stop_hook_active=true');
  });

  /**
   * **例外経路（`catch`）。** フックの入力を防御的に読んでいても、`hook.*` への
   * プロパティアクセス自体が投げる形（プロキシ・getter）は、`as` によるキャスト
   * では防げない。既存の実装もこの `catch` を持っていたが、いままで一度も
   * 通す歯が無かった。**起こし直さず、失敗を `note` として上げ、必ず
   * `{ continue: true }` を返す**ことを確かめる（`additionalContext` の組み立てで
   * 例外が出ても起こし直さない、という doc の主張の歯）。
   */
  it('入力の読み取りで例外が出ても、起こし直さず { continue: true } へ倒れ、失敗が note に残る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const throwing: Record<string, unknown> = { ...STOP_BASE, agent_id: 'agent-1' };
    Object.defineProperty(throwing, 'background_tasks', {
      enumerable: true,
      get(): never {
        throw new Error('boom-test-570');
      },
    });

    const result = await fireSubagentStop(started.options, throwing);

    expect(result).toEqual({ continue: true });
    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('SubagentStop の観測に失敗した');
    expect(notes[0]?.text).toContain('boom-test-570');
    expect(notes[0]?.escalate).toBeUndefined();
    // **`catch` は観測の失敗であって空転の記録ではない**——`stall` は載らない
    // （`manager.ts` の `case 'note'` が `exchange` へ落とす側のまま）。
    expect(notes[0]?.stall).toBeUndefined();
  });
});

/**
 * `note.stall`（Issue #357）の境界のスキーマ。デーモンと runner の間は
 * HTTP（JSON）なので、`permission-denied.test.ts` の
 * 「runner から降ろす出来事が境界のスキーマを通る」と同じ理由・同じ形で
 * `JSON.parse(JSON.stringify(...))` を通す —— 同一プロセスのテストは
 * `undefined` の欄がキーごと落ちる境界の壊れ方を再現しない
 * （`runner-protocol.ts` の冒頭の doc）。
 */
describe('note.stall のスキーマ（境界を越える形。Issue #357）', () => {
  it('stall 無しの note は今までどおり境界を通る（後方互換）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '旧 runner からの note',
        }),
      ),
    );
    expect(parsed.success).toBe(true);
  });

  it('stall 付きの note（agentType 有り）が境界を通り、値がそのまま保たれる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '起こし直した（1回目 / 上限 2）。',
          stall: {
            agentId: 'agent-1',
            agentType: 'worker',
            ownedTaskCount: 1,
            sessionTaskCount: 2,
            wakeupCount: 1,
            outcome: 'woken',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'note') {
      expect(parsed.data.stall).toEqual({
        agentId: 'agent-1',
        agentType: 'worker',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: 1,
        outcome: 'woken',
      });
    }
  });

  /**
   * `agentType` が取れない回（`hook.agent_type` が無かった実測。ファイル
   * 冒頭の doc）でも、キー自体が無い形で境界を通る——`undefined` を
   * 渡すのではなく、`JSON.stringify` がキーごと落とす実機の形を
   * `JSON.parse(JSON.stringify(...))` で再現する。
   */
  it('stall.agentType が無くても境界を通る（取れなかった回の実機の形）', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '起こし直さなかった。',
          stall: {
            agentId: 'agent-1',
            ownedTaskCount: 1,
            sessionTaskCount: 1,
            wakeupCount: 2,
            outcome: 'limit_reached',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'note') {
      expect(parsed.data.stall).not.toHaveProperty('agentType');
    }
  });

  /**
   * **必須欄が欠けると落ちる。** `stall` を名乗った以上、`ownedTaskCount`
   * のような構造の欄を省いた不完全な形まで通してしまうと、`manager.ts` の
   * `case 'note'` がその不完全な値をそのまま日誌へ書き込むことになる。
   */
  it('stall の必須欄（ownedTaskCount）が欠けると境界のスキーマで落ちる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: '不完全な stall。',
          stall: {
            agentId: 'agent-1',
            sessionTaskCount: 1,
            wakeupCount: 1,
            outcome: 'woken',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(false);
  });

  /** `outcome` は列挙値。未知の値は落ちる（2値を潰さない設計の検算）。 */
  it('stall.outcome が未知の値だと境界のスキーマで落ちる', () => {
    const parsed = runnerEventSchema.safeParse(
      JSON.parse(
        JSON.stringify({
          type: 'note',
          managerId: 'mgr-1',
          text: 'おかしな outcome。',
          stall: {
            agentId: 'agent-1',
            ownedTaskCount: 1,
            sessionTaskCount: 1,
            wakeupCount: 1,
            outcome: 'unknown_outcome',
          },
        }),
      ),
    );
    expect(parsed.success).toBe(false);
  });
});

/**
 * **`status` を読むこと**（#570 の追跡。この PR で足した歯）。
 *
 * `mine`（当人が起こしたもの）は「まだ走っているもの」ではない。`status` を
 * 読まないと、SDK が畳み終えた背景処理を `background_tasks` に載せてくる回に、
 * **もう終わっている門の完了を待たせる形で作業者を起こし直す**。
 *
 * ⚠️ **測ったこと（2026-09-09、直す前の版）:** `status` を
 * `running`/`completed`/`failed`/`killed`/`done`/`succeeded` の6語で振っても、
 * 在庫はどれも `1件`・起こし直しは `true` だった（＝判定が `status` を
 * 見ていなかった）。下の歯はその6語のうち「終わった」側で分岐が変わることを
 * 固定する。
 *
 * ⚠️ **この歯が言っていないこと。** 「SDK が `running` のまま腐った値を送る
 * 経路が無い」ことは、ここでは測れない（送られた値をそのまま信じる側の歯で
 * ある）。
 */
describe('status で「走っている／終わった／分からない」を分ける（#570 の追跡）', () => {
  /** 当人のものが全部「終わった」側なら、起こし直さない。 */
  it('status が終わった側の1件だけなら additionalContext を返さない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-1',
          type: 'shell',
          status: 'completed',
          description: '門',
          command: 'pnpm verify',
        },
      ],
    });

    expect(result).toEqual({ continue: true });
  });

  /** 黙らない —— 起こし直さない代わりに、診断を1本だけ日誌へ出す。 */
  it('起こし直さない代わりに診断を出す（黙って「きれいに畳んだ」に化けない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-1', type: 'shell', status: 'completed', description: '門' },
      ],
    });

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('status は全部「終わった」側だった');
    expect(notes[0]?.text).toContain('status=completed');
    // `stall` を載せない（`outcome` の2語のどちらでもないため）。
    expect(notes[0]?.stall).toBeUndefined();
  });

  /** 診断は1セッションに1回だけ（`#noteOwnerLookupFailure` と同じ形）。 */
  it('診断は1セッションに1回だけ出る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-2', 'agent-2');

    for (const [agentId, taskId] of [
      ['agent-1', 'bg-1'],
      ['agent-2', 'bg-2'],
    ] as const) {
      await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: agentId,
        background_tasks: [
          selfEntry(agentId),
          { id: taskId, type: 'shell', status: 'killed', description: '門' },
        ],
      });
    }

    expect(noteEvents(s.events)).toHaveLength(1);
  });

  /** 終わった分は件数から外し、外したこと自体を書く（数を潰さない）。 */
  it('走っているものと終わったものが混ざったら、終わった分を数に入れず、そう書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-live', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-done', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        {
          id: 'bg-live',
          type: 'shell',
          status: 'running',
          description: '走っている門',
          command: 'live-cmd',
        },
        {
          id: 'bg-done',
          type: 'shell',
          status: 'completed',
          description: '終わった門',
          command: 'done-cmd',
        },
      ],
    });

    // 直上と同じ理由（キャストの前に欄の存在を断言する）。
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('背景処理が 1件');
    expect(additionalContext).toContain('1件 は status が「終わった」側だった');
    // 終わった側は一覧に載らない（残っているものだけを見せる）。
    expect(additionalContext).toContain('id=bg-live command=live-cmd');
    expect(additionalContext).not.toContain('bg-done');
    expect(additionalContext).not.toContain('done-cmd');

    const notes = noteEvents(s.events);
    expect(notes[0]?.text).toContain('背景処理が 1件 残ったまま');
    expect(notes[0]?.stall?.ownedTaskCount).toBe(1);
  });

  /**
   * **`'unknown'` は「走っている」へ倒す。** 倒す先を間違えると、SDK が
   * 語彙を変えた瞬間に起こし直しが黙って効かなくなる（能力が消える）。
   */
  it('未知の status は「走っている」へ倒して起こし直し、分からなかったことを書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-1', type: 'shell', status: 'とつぜんの新語', description: '門' },
      ],
    });

    // **キャストの前に、欄が在ることを断言しておく。** 変異試験で m2
    // （`'unknown'` を `'settled'` へ倒す）を撃ったとき、赤が
    // `AssertionError` ではなく `TypeError`（`undefined` の
    // `additionalContext` を読んだ）で出た —— **キャストが嘘をつく形**で、
    // 赤の出どころが自分のアサーションではなくなっていた。
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('背景処理が 1件');
    expect(additionalContext).toContain('status が既知の語彙のどちらでもない');
    expect(noteEvents(s.events)[0]?.text).toContain('status が既知の語彙のどちらでもない');
  });

  /** `status` の欄そのものが無い（型が変わった）ときも「走っている」側へ倒す。 */
  it('status の欄が無ければ「走っている」へ倒す', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');

    const result = await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'shell', description: '門' }],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
  });
});

/**
 * **上限に達した後の `note` を間引く（#1385）。**
 *
 * 症状: `#onSubagentStop` が `limit_reached` に落ちるたびに `escalate: true`
 * を立てていたので、同じ agentId が上限に達したまま何度も `SubagentStop` を
 * 送ってくると、`manager.ts` の `case 'note'` が同じ内容の report をクローンの
 * 受信箱へ積み続けていた（`escalate` の有無で受信箱行きを決める分岐は
 * `manager.ts` 側にあり、この PR では触れない——`packages/core/src/manager.ts`
 * は別セッションの open PR が触っている）。
 *
 * 決まった形: `manager.ts` の `shouldEscalateDenial`（1・3・9・27…と3倍ごとに
 * だけ上げる）と同じ規則を `runner.ts` 側に複製し（`grep -Fn --
 * 'function shouldEscalateSubagentLimitReachedNote' packages/core/src/runner.ts`）、
 * `note` 自体は毎回 emit したまま `escalate` だけを間引く。
 *
 * 証拠 — このファイルの3本の歯:
 * 1. 同じ agentId で `limit_reached` の `note` を10回出すと、10件とも
 *    出るが `escalate: true` は1・3・9回目の3件だけ。
 * 2. 別の agentId は独立に数えられる。
 * 3. 完了を待って起こし直した（`woken`）回はこの数に入らない——既存の歯
 *    （`待ちの上限（30分）に達したら`）がそのまま緑であることで示す。
 */
describe('上限に達した後の note を間引く（#1385）', () => {
  /**
   * ⚠️ **実装前にこのファイルへ足して走らせ、赤であることを確認した
   * （報告に生の出力を残す）。** 実装前は `#onSubagentStop` が
   * `limit_reached` のたびに無条件で `escalate: true` を立てていたので、
   * 10件とも `escalate === true` になり、下の
   * `expect(escalateFlags).toEqual([...])` が失敗していた。
   */
  it('待ちの上限に達した同じ agentId で SubagentStop を10回鳴らすと、note は10件出て escalate は1・3・9回目だけ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // **ここから10回、同じ背景処理を残したまま畳もうとする** —— 毎回、待ちの上限
    // （偽の時計で30分）まで待って打ち切られる（`additionalContext` を返さない）。
    await registerBackgroundTask(started.options, 'bg-over', 'agent-1');
    const before = noteEvents(s.events).length;
    for (let n = 1; n <= 10; n += 1) {
      const result = await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-over', type: 'monitor', status: 'running' },
        ],
      });
      expect(result).toEqual({ continue: true });
    }

    const notes = noteEvents(s.events).slice(before);
    // **歯1（日誌の全件性）— note は10件とも出る。間引くのは escalate だけ
    // であって、note の発行そのものではない。**
    expect(notes).toHaveLength(10);
    for (const note of notes) expect(note.stall?.outcome).toBe('limit_reached');

    // **escalate は1・3・9回目の3件だけ。**
    const escalateFlags = notes.map((note) => note.escalate === true);
    expect(escalateFlags).toEqual([
      true, // 1回目
      false, // 2回目
      true, // 3回目
      false, // 4回目
      false, // 5回目
      false, // 6回目
      false, // 7回目
      false, // 8回目
      true, // 9回目
      false, // 10回目
    ]);

    // **歯4 — text に「N回目」の行が載る。**
    for (const [index, note] of notes.entries()) {
      const n = index + 1;
      expect(note.text).toContain(
        `打ち切ってから ${String(n)}回目（1・3・9…回目だけクローンへ上げる）`,
      );
    }
  });

  /**
   * **歯2 — 別の agentId は独立に数えられる。**
   *
   * `agent-1` を `limit_reached` の9回目（escalate する回）まで進めた
   * *直後*に、`agent-2` の1回目を送る。**もし数える単位が agentId ではなく
   * 全体で1本だったら**（変異(iii)）、`agent-2` の1回目は通算では10回目に
   * なり、10は1・3・9…の並びに無いので escalate しない——この歯はその
   * 崩れを撃つ。
   */
  it('別の agentId は独立に数えられる（片方が上限後9回目でも、もう片方の1回目は escalate）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // agent-1: limit_reached（待ちの上限での打ち切り）を9回連続で送る。
    await registerBackgroundTask(started.options, 'a1-bg-over', 'agent-1');
    for (let n = 1; n <= 9; n += 1) {
      await stopUntilWaitLimit(started, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-over', type: 'monitor', status: 'running' },
        ],
      });
    }
    const agent1Notes = noteEvents(s.events).filter(
      (note) => note.stall?.agentId === 'agent-1' && note.stall?.outcome === 'limit_reached',
    );
    expect(agent1Notes).toHaveLength(9);
    // 前提の検算——9回目が escalate する回であること（そうでなければ下の
    // agent-2 の検算自体が無意味になる）。
    expect(agent1Notes.at(-1)?.escalate).toBe(true);

    // agent-2: limit_reached の1回目を送る。
    await registerBackgroundTask(started.options, 'a2-bg-over', 'agent-2');
    await stopUntilWaitLimit(started, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [
        selfEntry('agent-2'),
        { id: 'a2-bg-over', type: 'monitor', status: 'running' },
      ],
    });
    const agent2Notes = noteEvents(s.events).filter(
      (note) => note.stall?.agentId === 'agent-2' && note.stall?.outcome === 'limit_reached',
    );
    expect(agent2Notes).toHaveLength(1);
    // **本体の主張** —— agent-1 が直前に9回目（escalate する回）を消費して
    // いても、agent-2 の1回目は独立して escalate する。
    expect(agent2Notes[0]?.escalate).toBe(true);
    expect(agent2Notes[0]?.text).toContain(
      '打ち切ってから 1回目（1・3・9…回目だけクローンへ上げる）',
    );
  });
});

/**
 * **SDK の status の語彙が動いたら `pnpm typecheck` が落ちる歯。**
 *
 * `BackgroundTaskSummary.status` は `status: string`（自由文字列）で語彙を
 * 名乗っていない。⟹ `runner.ts` の `SETTLED_BACKGROUND_TASK_STATUSES` /
 * `LIVE_BACKGROUND_TASK_STATUSES` が置いている「6語で全部」という前提は、
 * 同じ `TaskState` の status を運ぶ `SDKTaskUpdatedMessage.patch.status`
 * の型から借りている。
 *
 * **逐語の印（`runner.ts` に付けた `check-sdk-quotes` の印）だけでは足りない** ——
 * あれは文言が変わったときに落ちるが、**語彙が増えたことは文言の変化として
 * 検出できるとは限らない**（`check-sdk-quotes-core.mjs` の「この検査が
 * 言えないこと」）。だから型でも当てる。
 *
 * 語彙が増えたら `Extra` が `never` でなくなり、この行が型エラーになる。
 */
describe('SDK の status の語彙の前提（腐ったら typecheck が落ちる）', () => {
  type TaskStatus = NonNullable<SDKTaskUpdatedMessage['patch']['status']>;
  type Assumed = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'killed';
  type Extra = Exclude<TaskStatus, Assumed>;
  type Missing = Exclude<Assumed, TaskStatus>;

  it('想定した6語で全部である', () => {
    const noExtra: Extra extends never ? true : false = true;
    const noMissing: Missing extends never ? true : false = true;
    expect(noExtra).toBe(true);
    expect(noMissing).toBe(true);
  });
});

/**
 * 作業者 `agentId` を、背景処理の完了を待つ上限（30分。偽の時計）まで待たせて `SubagentStop` で
 * 打ち切る（#901 / Issue #3008）。`打ち切った作業者の Task の結果に注記する（#901）` と
 * `task_notification 経由で判明した打ち切りにも注記する（#901）` の両方が使う
 * ——後者は「同期の `Task` ではなく `task_notification` で完了が届く」経路を
 * 確かめるだけで、**打ち切り自体の起こし方は同じ**である。
 */
async function cutOff(started: Started, agentId: string): Promise<void> {
  await registerBackgroundTask(started.options, `bg-${agentId}`, agentId);
  await stopUntilWaitLimit(started, {
    ...STOP_BASE,
    agent_id: agentId,
    background_tasks: [
      selfEntry(agentId),
      // **command 付き**（Issue #1554）——打ち切られた瞬間に控える
      // `RunnerCutOffWorkers.cutOffTasks` の内容を、この helper を使う
      // #901 のテスト群からも確かめられるようにする。
      { id: `bg-${agentId}`, type: 'monitor', status: 'running', command: 'sleep 90' },
    ],
  });
}

/** 同期の `Task`（`status:'completed'`）の結果（#901）。 */
function taskResult(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { prompt: '作業' },
    tool_response: { status: 'completed', agentId, content: [], ...extra },
  };
}

/**
 * #901: 起こし直しの上限で打ち切った作業者の `Task` の結果に、マネージャー向けの注記を付ける。
 *
 * `Task` の結果（`AgentOutput`）は打ち切りも正常な完了も同じ `status: 'completed'` の顔で
 * 返る。打ち切ったのは alteroid 自身なので、`SubagentStop` の `agent_id` を控え、
 * マネージャー側の `PostToolUse` で `tool_response.agentId` と突き合わせる。
 */
describe('打ち切った作業者の Task の結果に注記する（#901）', () => {
  it('待ちの上限で打ち切った作業者の Task の結果には additionalContext が付き、note も残る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    const result = await firePostToolUse(started.options, taskResult('agent-1'));

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('完結していない可能性がある');
    // **Issue #1554: 打ち切られた瞬間に残っていた背景処理の id / command と、
    // 出力の置き場所・続きを頼む案内が載る。**
    expect(context).toContain('id=bg-agent-1');
    expect(context).toContain('command=sleep 90');
    expect(context).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(noteEvents(s.events).at(-1)?.text).toContain('Task の結果に注記した（#901）');
  });

  it('注記は1回だけ（同じ agentId の2回目の結果には付かない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await firePostToolUse(started.options, taskResult('agent-1'));
    expect(await firePostToolUse(started.options, taskResult('agent-1'))).toEqual({
      continue: true,
    });
  });

  it('打ち切っていない作業者の結果には付かない（完了を待って起こし直しただけの作業者も含む）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-2', 'agent-2');
    await stopAfterAllFinish(started, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [selfEntry('agent-2'), { id: 'bg-2', type: 'monitor', status: 'running' }],
    });
    expect(await firePostToolUse(started.options, taskResult('agent-2'))).toEqual({
      continue: true,
    });
    expect(await firePostToolUse(started.options, taskResult('agent-3'))).toEqual({
      continue: true,
    });
  });

  it('作業者の中で発火した PostToolUse（agent_id 付き）や、completed 以外の結果には付けない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    expect(
      await firePostToolUse(started.options, {
        ...taskResult('agent-1'),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    expect(
      await firePostToolUse(started.options, taskResult('agent-1', { status: 'async_launched' })),
    ).toEqual({ continue: true });
    // 控えは消えていない —— 正しい形の結果が来れば注記する。
    expect(await firePostToolUse(started.options, taskResult('agent-1'))).toHaveProperty(
      'hookSpecificOutput',
    );
  });
});

/**
 * #901: 背景委譲（`async_launched`。既定）の打ち切りは `PostToolUse` を経由しない
 * ——完了は `system/task_notification` としてだけ届く。`task_notification` に
 * `additionalContext` を注げるフックは無い（`hook_event_name` を持つ SDK の
 * 全種を静的に確認済み。`runner.ts` の `#pendingCutOffNotifications` の doc）
 * ので、`#onTaskNotification` で「未配達の打ち切り注記」として控え、次に
 * マネージャー自身のどの道具が動いても（`PostToolUse` 経由で）相乗りする。
 *
 * `push()` は使わない —— 作業者の完了を契機に呼ぶと SDK 側の自己継続と
 * 二重にターンが回る（`push` 自身の doc、`runner-wakeup.test.ts` の
 * 「`task_notification` を受けても `#input` へは1件も積まれない」）。
 */
describe('task_notification 経由で判明した打ち切りにも注記する（#901）', () => {
  /** マネージャー自身の、`Task` 以外の任意の道具呼び出し。道具の種類を問わないことを示す。 */
  function anyManagerTool(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: { content: 'ok' },
      ...extra,
    };
  }

  it('次のマネージャー自身の PostToolUse（道具の種類は問わない）に additionalContext が付く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('task-notification');
    expect(context).toContain('完結していない可能性がある');
    // **Issue #1554: こちら（task_notification 経由）にも id / command と、
    // 出力の置き場所・続きを頼む案内が載る。**
    expect(context).toContain('id=bg-agent-1');
    expect(context).toContain('command=sleep 90');
    expect(context).toContain('出力の置き場所は、処理が終わったら知らせる（#1554）');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(noteEvents(s.events).at(-1)?.text).toContain(
      'Task の結果に注記した（#901・task_notification 経由）',
    );
  });

  it('1回だけ（配達したら控えは空になる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    await firePostToolUse(started.options, anyManagerTool());
    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('打ち切られていない task_notification には何も控えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await fireTaskNotification(started, 'agent-2');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('同期経路（PostToolUse）で先に消費されていれば、後から届く task_notification では二重に控えない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    // 同期の Task 結果が先に届いて消費する（#annotateCutOffWorker）。
    await firePostToolUse(started.options, taskResult('agent-1'));
    // 同じ agent-1 の task_notification が後から届いても、もう #cutOffWorkers に無い。
    await fireTaskNotification(started, 'agent-1');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('作業者内（agent_id あり）の PostToolUse には配達されない（控えは残ったまま）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await fireTaskNotification(started, 'agent-1');

    // 作業者内で発火した PostToolUse（agent_id 付き）には乗らない。
    expect(
      await firePostToolUse(started.options, {
        ...anyManagerTool(),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    // 控えは消えていない —— マネージャー自身の呼び出しが来れば配達する。
    expect(await firePostToolUse(started.options, anyManagerTool())).toHaveProperty(
      'hookSpecificOutput',
    );
  });
});

/**
 * Issue #1554: 打ち切った後も背景処理そのものは走り続け、いずれ終わる。
 * その完了（`task_notification` の `output_file`）は、上の2つの経路
 * （#901 —— 作業者〈subagent〉自身の完了）とは**別の id 空間**で届く——
 * `task_id` が `background_tasks[].id`（`RunnerSession#recordBackgroundTaskOwner`
 * が控える id）と同じ値になる。ここで固定するのは「その完了を、打ち切った
 * 作業者の分だとどう結び、どう配達するか」である。
 */
describe('打ち切った作業者が残した背景処理そのものの完了を配達する（Issue #1554）', () => {
  /** マネージャー自身の、任意の道具呼び出し。道具の種類を問わないことを示す。 */
  function anyManagerTool(extra: Record<string, unknown> = {}) {
    return {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: { content: 'ok' },
      ...extra,
    };
  }

  /** 作業者 `agentId` が背景の Bash（`command`）を起こしたことを登録する。 */
  async function registerWorkerBash(
    options: Options,
    taskId: string,
    agentId: string,
    command: string,
  ): Promise<void> {
    await firePostToolUse(options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId },
      agent_id: agentId,
      agent_type: 'worker',
    });
  }

  it('打ち切った作業者が起こした背景の Bash が終わると、次のマネージャー自身の道具呼び出しに id・command・出力の在り処と再開の案内が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    // 打ち切られた agent-1 は、起こし直しの予算に使った bg-agent-1 とは
    // **別の**背景処理（`pnpm test`）も残していた。
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');

    // その背景処理自身が完了した（output_file 付き）。
    await fireTaskNotification(started, 'bg-test-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('agent_id=agent-1');
    expect(context).toContain('id=bg-test-1');
    expect(context).toContain('command=pnpm test');
    expect(context).toContain('/tmp/does-not-exist.txt');
    expect(context).toContain('ToolSearch');
    expect(context).toContain('select:SendMessage');
    expect(context).toContain('agentId=agent-1');
    expect(context).toContain('即時ではない');
    expect(noteEvents(s.events).at(-1)?.text).toContain(
      '打ち切った作業者の背景処理が終わった（#1554）',
    );
  });

  it('1回だけ（配達したら控えは空になる）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1');

    await firePostToolUse(started.options, anyManagerTool());
    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('output_file が読めない task_notification では、パスを作らず「取れなかった」と書く', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    // `output_file` を落とした形で届く（読めなかった、を再現する）。
    await fireTaskNotification(started, 'bg-test-1', { output_file: undefined });

    const result = await firePostToolUse(started.options, anyManagerTool());
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    expect(context).toContain('id=bg-test-1');
    expect(context).toContain('取れなかった');
    expect(context).not.toContain('/tmp/does-not-exist.txt');
  });

  it('打ち切られていない作業者の背景処理が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // agent-2 は起こし直しの上限に達していない（打ち切られていない）。
    await registerWorkerBash(started.options, 'bg-test-2', 'agent-2', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-2');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('所有者を控えていない背景処理（id を登録していない）が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    // `bg-unknown` は一度も `PostToolUse` で登録していない——所有者を引けない。
    await fireTaskNotification(started, 'bg-unknown');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('マネージャー自身が起こした背景処理（所有者が空文字）が終わっても、何も配達されない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    // `agent_id` を渡さない = マネージャー自身が起こした背景処理。
    await firePostToolUse(started.options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-manager-1' },
    });
    await fireTaskNotification(started, 'bg-manager-1');

    expect(await firePostToolUse(started.options, anyManagerTool())).toEqual({ continue: true });
  });

  it('作業者内（agent_id あり）の PostToolUse には配達されない（控えは残ったまま）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    await fireTaskNotification(started, 'bg-test-1');

    expect(
      await firePostToolUse(started.options, {
        ...anyManagerTool(),
        agent_id: 'agent-9',
        agent_type: 'worker',
      }),
    ).toEqual({ continue: true });
    expect(await firePostToolUse(started.options, anyManagerTool())).toHaveProperty(
      'hookSpecificOutput',
    );
  });

  it('#901（作業者自身の完了）と #1554（背景の Bash の完了）が同じ配達に両方載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await cutOff(started, 'agent-1');
    await registerWorkerBash(started.options, 'bg-test-1', 'agent-1', 'pnpm test');
    // 順序は問わないことを示すため、背景の Bash の完了を先に、
    // 作業者自身（agent-1）の完了を後に届ける。
    await fireTaskNotification(started, 'bg-test-1');
    await fireTaskNotification(started, 'agent-1');

    const result = await firePostToolUse(started.options, anyManagerTool());
    const context = (result as { hookSpecificOutput?: { additionalContext?: string } })
      .hookSpecificOutput?.additionalContext;
    // #901（同じ agent_id の「打ち切られていた」注記）と #1554（背景処理の
    // 完了）が両方、同じ additionalContext に連結されて載る。
    expect(context).toContain('task-notification');
    expect(context).toContain('が残した背景処理');
    expect(context).toContain('id=bg-test-1');
    expect(
      noteEvents(s.events).some((note) =>
        note.text.includes('打ち切った作業者の背景処理が終わった'),
      ),
    ).toBe(true);
  });
});
