import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type {
  BackgroundTaskSummary,
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  StopHookInput,
  SubagentStopHookInput,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

/**
 * `Stop` フックの観測口（#861）を確かめる。
 *
 * **固定するのは2つである。**
 *
 * 1. **観測だけであること。** どの入力でも戻り値は `{ continue: true }` **ちょうど**で、
 *    `decision` も `hookSpecificOutput`（`additionalContext`）も返さない。直上の
 *    `SubagentStop`（`runner-subagent-stop.test.ts`）は #570 の追跡で「起こし直す」側へ
 *    変わっているので、**こちらが同じ道を歩いていないこと**を検算する歯である。
 * 2. **在り高の内訳が値で割れること。** 所有者（マネージャー自身／作業者／委譲そのもの／
 *    引けなかった）と `status`（走っている／終わった／分からない）の4×3が、既存の
 *    `#backgroundTaskOwners` だけから引けている。
 *
 * ## ⚠️ この歯の弱さ（⛔ 書かずに置くと、次の人が守られていると思う）
 *
 * **下のフィクスチャは全部が手書きのオブジェクトリテラルである。** 実物のフック JSON を
 * 1行も読み込んでいない（この repo にそのフィクスチャは1つも無い —— 探した）。
 * ⟹ **SDK が `background_tasks` の中身の綴りを変えても、下の `it` はすべて緑のままである。**
 * `fireStop` が `input as never` で型を消して呼ぶので、フィクスチャの形が実物と食い違って
 * いても TypeScript は何も言わない。
 *
 * **だから型の歯を別に置いてある**（ファイル末尾の `describe`）。あちらは SDK の型を
 * 直接引くので、`StopHookInput` から欄が消えた・`Stop` と `SubagentStop` の
 * `background_tasks` が別の型へ分岐した、といった変化では **`pnpm typecheck` が落ちる。**
 * ⚠️ **それでも覆えるのは「型定義に現れる変化」までである** —— 型はそのままで実物の
 * JSON だけが変わる回（SDK の doc と実装がずれる回。#570 が `owned_by_subagent` で
 * 実際に踏んだ形）は、この2つのどちらでも捕まらない。**続きは #861。**
 *
 * 足場は `runner-subagent-stop.test.ts` の `fakeRunnerSdk` と同じ形である。
 */

interface Started {
  options: Options;
  finish: () => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
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

/** `options.hooks.Stop[0].hooks[0]` を直接叩く。 */
async function fireStop(options: Options, input: Record<string, unknown>): Promise<HookJSONOutput> {
  const hook = options.hooks?.Stop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('Stop フックが登録されていない');
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

/**
 * 背景タスク `taskId` の所有者を表へ登録させる。
 *
 * `agentId` を省くと**マネージャー自身**が起こしたことになる
 * （`#recordBackgroundTaskOwner` が空文字で控える取り決め）。
 */
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

const STOP_BASE = {
  hook_event_name: 'Stop',
  stop_hook_active: false,
  session_crons: [],
};

function shellTask(id: string, status = 'running') {
  return { id, type: 'shell', status, description: '背景のシェル', command: 'sleep 90' };
}

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function stopNotes(events: readonly RunnerEvent[]): NoteEvent[] {
  return noteEvents(events).filter((note) => note.text.startsWith('Stop'));
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-stop-'));
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
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

async function startSession(): Promise<{ started: Started; events: RunnerEvent[] }> {
  const s = setup();
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const started = s.started[0];
  if (started === undefined) throw new Error('セッションが開いていない');
  return { started, events: s.events };
}

describe('Stop の配線（#861）', () => {
  it('マネージャーの Options に Stop フックが1本だけ載っている', async () => {
    const { started } = await startSession();
    expect(started.options.hooks?.Stop?.length).toBe(1);
    expect(started.options.hooks?.Stop?.[0]?.hooks?.length).toBe(1);
  });

  // **配線した4本を落としていないことの検算**（この PR は足すだけで、既存の観測を
  // 1つも外していない）。
  it('既存の4本（PostToolUse / PreCompact / UserPromptSubmit / SubagentStop）はそのまま載っている', async () => {
    const { started } = await startSession();
    const hooks = started.options.hooks;
    expect(hooks?.PostToolUse?.length).toBe(1);
    expect(hooks?.PreCompact?.length).toBe(1);
    expect(hooks?.UserPromptSubmit?.length).toBe(1);
    expect(hooks?.SubagentStop?.length).toBe(1);
  });
});

describe('Stop の観測 —— 在り高が 0 の回（#861）', () => {
  it('1回目は「0件で閉じた」note を出し、戻り値は { continue: true } ちょうど', async () => {
    const { started, events } = await startSession();

    const result = await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });

    expect(result).toEqual({ continue: true });
    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('背景処理も session_crons も 0件 だった');
    expect(notes[0]?.text).toContain('通算 1回目');
    // 観測だけなので、クローンの受信箱へは上げない。
    expect(notes[0]?.escalate).toBeUndefined();
    expect(notes[0]?.stall).toBeUndefined();
  });

  it('2回目以降は出さない（1セッションに1回だけの診断）', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });

    expect(stopNotes(events).length).toBe(1);
  });

  /**
   * **間引かれた回でも通算は進む。** `#stopFirings` は `note` を出すかどうかと
   * 独立に数えている —— 進んでいなければ「`Stop` はいつ来るのか」の材料が消える。
   */
  it('間引かれた回も通算に入っている（次に在り高が出た回の note が続きの番号を名乗る）', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [] });
    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const notes = stopNotes(events);
    expect(notes.length).toBe(2);
    expect(notes[1]?.text).toContain('通算 3回目');
  });

  /**
   * `background_tasks` が空でも `session_crons` が在れば「session is done」ではない
   * （SDK の言う「paused waiting for background work to wake it」に近い側）。
   */
  it('background_tasks が空でも session_crons が在れば在り高として出す', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [],
      session_crons: [{ id: 'cron-1', schedule: '* * * * *', recurring: false, prompt: '起きろ' }],
    });

    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('背景処理 0件 / session_crons 1件');
    expect(notes[0]?.text).not.toContain('0件 だった');
  });
});

describe('Stop の観測 —— 在り高が残っている回（#861）', () => {
  it('マネージャー自身が起こした分を owner=manager として出す', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    const result = await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [shellTask('bg-1')],
    });

    expect(result).toEqual({ continue: true });
    const notes = stopNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('マネージャー自身 1件');
    expect(notes[0]?.text).toContain('owner=manager');
    expect(notes[0]?.text).toContain('command=sleep 90');
  });

  it('作業者が起こした分を owner=worker:<agent_id> として出す', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-2', 'agent-xyz');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-2')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('作業者 1件');
    expect(text).toContain('owner=worker:agent-xyz');
  });

  /**
   * **委譲そのもの（`type=subagent`）は表に無いのが正常である** —— `PostToolUse` の
   * `backgroundTaskId` を持たないため。**「引けなかった」に混ぜない**ことがこの歯の
   * 本題で、混ぜると経路が壊れて表が空になった状態と見分けがつかなくなる。
   */
  it('type=subagent は owner=delegation として数え、「引けなかった」に混ぜない', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [
        { id: 'agent-1', type: 'subagent', status: 'running', description: '委譲' },
      ],
    });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('委譲そのもの 1件');
    expect(text).toContain('引けなかった 0件');
    expect(text).toContain('owner=delegation');
    expect(text).not.toContain('所有者を引けなかった**');
  });

  it('表に無く type も subagent でない分は owner=unresolved として、計器を疑う行を足す', async () => {
    const { started, events } = await startSession();

    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-orphan')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('引けなかった 1件');
    expect(text).toContain('owner=unresolved');
    expect(text).toContain('計器のほうを疑う');
  });

  it('status を「走っている／終わった／分からない」の3つに言い分ける', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-live');
    await registerBackgroundTask(started.options, 'bg-done');
    await registerBackgroundTask(started.options, 'bg-huh');
    await fireStop(started.options, {
      ...STOP_BASE,
      background_tasks: [
        shellTask('bg-live', 'running'),
        shellTask('bg-done', 'completed'),
        shellTask('bg-huh', 'ぬるぬる'),
      ],
    });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('走っている 1件 / 終わった 1件 / 分からない 1件');
    expect(text).toContain('status が既知の語彙のどちらでもない');
  });

  /**
   * ⭐ **同じ在り高で何度も閉じていること自体が #861 の探している署名である。**
   * だから内容が同じでも畳まない —— ここを畳むと「マネージャーが同じ背景処理を
   * 残したまま5回閉じた」が日誌の上で1回に見える。
   */
  it('同じ在り高で2回閉じたら note も2本出す（内容が同じでも畳まない）', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const notes = stopNotes(events);
    expect(notes.length).toBe(2);
    expect(notes[0]?.text).toContain('通算 1回目');
    expect(notes[1]?.text).toContain('通算 2回目');
  });

  it('note には「観測だけである」断りと、覆えない範囲の断りが両方入る', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    const text = stopNotes(events)[0]?.text ?? '';
    expect(text).toContain('これは観測だけである');
    expect(text).toContain('マネージャーが起きているときにしか来ない');
  });

  it('出した note は runnerEventSchema を通る', async () => {
    const { started, events } = await startSession();

    await registerBackgroundTask(started.options, 'bg-1');
    await fireStop(started.options, { ...STOP_BASE, background_tasks: [shellTask('bg-1')] });

    for (const note of stopNotes(events)) {
      expect(() => runnerEventSchema.parse(note)).not.toThrow();
    }
  });
});

describe('Stop は何も判断せず、何も抑制しない（#861 の段1。⛔ ここを反転させる PR は #861 を読むこと）', () => {
  /**
   * **`runner-subagent-stop.test.ts` が PR #594 で持っていた歯と同じ形である。**
   * あちらは #570 の追跡で反転した（`additionalContext` を返す側になった）。
   * **こちらは反転していない** —— 反転させるなら #861 の段2 として、実データを
   * 見たうえで、同じ3点セット（変更した事実・なぜ必要になったか・なぜ保証が
   * 弱くなっていないか）を PR 本文に書くこと（AGENTS.md「テストを弱めずに直す」）。
   */
  const cases: { name: string; input: Record<string, unknown> }[] = [
    { name: '在り高 0', input: { ...STOP_BASE, background_tasks: [] } },
    { name: '背景処理あり', input: { ...STOP_BASE, background_tasks: [shellTask('bg-1')] } },
    {
      name: 'stop_hook_active=true',
      input: { ...STOP_BASE, stop_hook_active: true, background_tasks: [shellTask('bg-1')] },
    },
    { name: 'background_tasks が無い', input: { hook_event_name: 'Stop' } },
    { name: 'background_tasks が配列でない', input: { ...STOP_BASE, background_tasks: 'ごみ' } },
  ];

  for (const c of cases) {
    it(`${c.name}: 戻り値は { continue: true } ちょうど（decision も hookSpecificOutput も無い）`, async () => {
      const { started } = await startSession();
      const result = await fireStop(started.options, c.input);
      expect(result).toEqual({ continue: true });
    });
  }

  it('入力が null でも落ちず、continue: true を返す', async () => {
    const { started } = await startSession();
    const result = await fireStop(started.options, null as unknown as Record<string, unknown>);
    expect(result).toEqual({ continue: true });
  });
});

/**
 * **SDK の型に直接当てる歯。** 上の `it` 群はすべて手書きのフィクスチャなので、SDK が
 * 形を変えても緑のままである（ファイル冒頭の「この歯の弱さ」）。ここだけは SDK の型を
 * 引くので、**壊れると `pnpm typecheck` が落ちる**（実行時ではなくコンパイル時）。
 *
 * `runner-subagent-stop.test.ts` 末尾の「SDK の status の語彙の前提」と同じ作法である。
 */
describe('SDK の型の前提（腐ったら typecheck が落ちる）', () => {
  /** `#onStop` が `StopHookInput` から読んでいる3つの欄。 */
  type ReadFields = 'background_tasks' | 'session_crons' | 'stop_hook_active';
  type MissingFields = Exclude<ReadFields, keyof StopHookInput>;

  it('#onStop が読む欄は StopHookInput に在る', () => {
    const noMissing: MissingFields extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });

  /**
   * ⭐ **#861 が「乗ってよい」と言っている唯一の等式。**
   * `Stop.background_tasks[].id` は `SubagentStop.background_tasks[].id` と同じ
   * `BackgroundTaskSummary` 型であり、後者は #570 が生 JSON で実測済みである。
   * **SDK が2つを別の型へ分岐させたら、ここで落ちる。**
   */
  type StopTask = NonNullable<StopHookInput['background_tasks']>[number];
  type SubagentStopTask = NonNullable<SubagentStopHookInput['background_tasks']>[number];
  type SameTaskType = [StopTask] extends [SubagentStopTask]
    ? [SubagentStopTask] extends [StopTask]
      ? true
      : false
    : false;

  it('Stop と SubagentStop の background_tasks[] は同じ要素型である', () => {
    const same: SameTaskType = true;
    expect(same).toBe(true);
  });

  it('その要素型は BackgroundTaskSummary である', () => {
    const isSummary: [StopTask] extends [BackgroundTaskSummary] ? true : false = true;
    expect(isSummary).toBe(true);
  });

  /** `#renderStopTaskLine` / `#stopTaskOwnerKind` が読んでいる欄。 */
  type ReadTaskFields = 'id' | 'type' | 'status' | 'description' | 'command';
  type MissingTaskFields = Exclude<ReadTaskFields, keyof BackgroundTaskSummary>;

  it('1行に描く欄は BackgroundTaskSummary に在る', () => {
    const noMissing: MissingTaskFields extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });
});
