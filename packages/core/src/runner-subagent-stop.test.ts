import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRunnerHost, type RunnerHost, SUBAGENT_WAKEUP_LIMIT } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

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
 * > 0`）は、起こし直しの上限（`SUBAGENT_WAKEUP_LIMIT`）に達するまで
 * `hookSpecificOutput.additionalContext` を返し、作業者をその場で継続
 * させる。
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
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-subagent-stop-'));
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
    expect(noteEvents(s.events)).toHaveLength(0);
  });

  /**
   * ⚠️ **反転させた歯（この PR）。** 以前は「戻り値は必ず `{ continue: true }`」
   * を固定していた。いまは `mine.length > 0` かつ上限未満（この呼び出しが
   * `agent-1` にとって最初の1回）なので、`hookSpecificOutput.additionalContext`
   * を返して起こし直す側になる。**なぜ必要になったか／なぜ保証が弱く
   * なっていないか**はファイル冒頭の doc を見よ。`note` 側の主張（件数・
   * type/status/command・発火条件の断り）は反転させていない——起こし直しは
   * `note` を置き換えるのではなく足す側の変更である。
   */
  it('当人が自分で起こした背景処理が残っていれば起こし直し、note にも type と status と command が載る', async () => {
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
          status: 'running',
          description: 'pnpm verify を実行中',
          command: 'pnpm verify',
        },
      ],
    });

    // **起こし直した（1回目）。** `additionalContext` を返す。
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
    const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain('1件');
    expect(additionalContext).toContain('親のセッション');
    expect(additionalContext).toContain('自動では再開しない');
    expect(additionalContext).toContain('背景処理を残したまま終える');
    expect(additionalContext).toContain(`1回目（上限 ${SUBAGENT_WAKEUP_LIMIT}）`);
    // **短い本文は切られない。** 「上限以下なら早期 return する」側の歯
    // （変異試験 #570 で見つかった穴 — 早期 return を壊しても、この否定の
    // 断言が無いと `slice` がそのまま全文を返すぶん気づけなかった）。
    expect(additionalContext).not.toContain('文字で切った');

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('type=shell');
    expect(text).toContain('status=running');
    expect(text).toContain('command=pnpm verify');
    // 当人が起こした分の件数と、セッション全体の在庫の件数を両方載せる。
    expect(text).toContain('1件 残ったまま畳もうとした');
    expect(text).toContain('在庫=2件');
    // **起こし直したことが note の字面からも分かる。**
    expect(text).toContain('起こし直した');
    expect(text).toContain(`1回目 / 上限 ${SUBAGENT_WAKEUP_LIMIT}`);
    // 発火条件の断りを本文にも書く（doc だけに書くと、片方しか読まない人が誤る）。
    expect(text).toContain('空転が無かった');
    // escalate は立たない（上限に達していないので、あくまで起こし直し）。
    expect(notes[0]?.escalate).toBeUndefined();
    // 直上の additionalContext と対にして、note 側も短ければ切られないことを見る。
    expect(text).not.toContain('文字で切った');
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
    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-1', type: 'shell', status: 'running', description: longDescription },
      ],
    });

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
   * **この1本が無いと、条件1（当人の分が在れば毎回）が固定されない。**
   * 「最初の1回だけ出す」だけの実装でも上は緑になりうるので、ここで撃ち分ける。
   *
   * ⚠️ **反転させた歯（この PR）。** `SUBAGENT_WAKEUP_LIMIT` 回まではどちらも
   * 起こし直しの対象なので、この歯の回数（上限ちょうど）では両方とも
   * `additionalContext` を返す側になる。上限を超えて起こし直さなくなる
   * ケースは別の歯（下の「起こし直しが上限に達したら」describe）が持つ。
   */
  it('当人の背景処理が残るたびに note が出て起こし直す（最初の1回だけ、ではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const attempts = Array.from({ length: SUBAGENT_WAKEUP_LIMIT }, (_unused, i) => i + 1);
    for (const n of attempts) {
      await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: `bg-${n}`, type: 'monitor', status: 'running', description: `CI の見張り ${n}` },
        ],
      });
      expect(result).toMatchObject({
        continue: true,
        hookSpecificOutput: { hookEventName: 'SubagentStop' },
      });
      const additionalContext = (result as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      expect(additionalContext).toContain(`${String(n)}回目（上限 ${SUBAGENT_WAKEUP_LIMIT}）`);
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(attempts.length);
    expect(notes[0]?.text).toContain('type=monitor');
    expect(notes[0]?.text).toContain(`1回目 / 上限 ${SUBAGENT_WAKEUP_LIMIT}`);
    expect(notes.at(-1)?.text).toContain(`CI の見張り ${String(attempts.length)}`);
    expect(notes.at(-1)?.text).toContain(
      `${String(attempts.length)}回目 / 上限 ${SUBAGENT_WAKEUP_LIMIT}`,
    );
    // 上限ちょうどまではどの回も escalate しない。
    for (const note of notes) expect(note.escalate).toBeUndefined();
  });

  /**
   * **上限（`SUBAGENT_WAKEUP_LIMIT`）に達したら起こし直しをやめる。**
   * `additionalContext` を返さず、`escalate: true` の `note` を出す
   * （`manager.ts` の `case 'note'` がこれを見て受信箱へも1本上げる）。
   */
  describe('起こし直しが上限に達したら', () => {
    it('同じ agent_id で上限まで起こし直したあと、次の回は起こし直さず escalate な note が出る', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      // 上限ちょうどまでは起こし直される（直上の歯と同じ回数）。
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT; n += 1) {
        await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-${n}`, type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // 上限+1回目 —— 起こし直さない。
      const overLimitId = `bg-${String(SUBAGENT_WAKEUP_LIMIT + 1)}`;
      await registerBackgroundTask(started.options, overLimitId, 'agent-1');
      const overLimitResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: overLimitId, type: 'monitor', status: 'running' },
        ],
      });

      // **起こし直さない ⟹ `additionalContext` を返さない。**
      expect(overLimitResult).toEqual({ continue: true });

      const notes = noteEvents(s.events);
      expect(notes).toHaveLength(SUBAGENT_WAKEUP_LIMIT + 1);
      const escalated = notes.at(-1);
      expect(escalated?.escalate).toBe(true);
      expect(escalated?.text).toContain('起こし直さなかった');
      expect(escalated?.text).toContain(`上限（${SUBAGENT_WAKEUP_LIMIT}回）`);
      // それより前の回は escalate していない。
      for (const note of notes.slice(0, -1)) expect(note.escalate).toBeUndefined();
    });

    it('agent_id が違えば上限は独立している', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      // `agent-1` を上限まで使い切る。
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT; n += 1) {
        await registerBackgroundTask(started.options, `a1-bg-${n}`, 'agent-1');
        await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `a1-bg-${n}`, type: 'monitor', status: 'running' },
          ],
        });
      }
      // `agent-1` はもう上限に達している（escalate になる）ことを前提として確かめる。
      await registerBackgroundTask(started.options, 'a1-bg-over', 'agent-1');
      const agent1Over = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-over', type: 'monitor', status: 'running' },
        ],
      });
      expect(agent1Over).toEqual({ continue: true });

      // 別の `agent-2` は、これが初回なので起こし直される。
      await registerBackgroundTask(started.options, 'a2-bg-1', 'agent-2');
      const agent2First = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-2',
        background_tasks: [
          selfEntry('agent-2'),
          { id: 'a2-bg-1', type: 'monitor', status: 'running' },
        ],
      });
      expect(agent2First).toHaveProperty('hookSpecificOutput');
      const additionalContext = (
        agent2First as { hookSpecificOutput: { additionalContext: string } }
      ).hookSpecificOutput.additionalContext;
      expect(additionalContext).toContain(`1回目（上限 ${SUBAGENT_WAKEUP_LIMIT}）`);
    });

    /**
     * **ターン境界（`session_started`。#643 の形）を挟んでも上限は再装填
     * されない。** `#subagentWakeups` は `runner.ts` の doc に書いたとおり
     * リセットしない設計——ここで実際に `init` をもう一度流し、それでも
     * 「起こし直しても進まなかった」が正しく積み上がることを見る。
     */
    it('ターン（session_started）をまたいでも起こし直しの上限は再装填されない', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT; n += 1) {
        await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-${n}`, type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // **同じセッションのまま、次のターンの頭が来る**（`sess-1` を明示的に
      // 再送。`runner.ts` の `case 'session_started'` は同じ `sessionId` なら
      // `#liveBackgroundTasks` すら空へ戻さない——`#subagentWakeups` は
      // そもそもどの分岐からも触られない）。
      started.restart('sess-1');
      // フックへの直接呼び出しとは別径路（メッセージストリーム）なので、
      // 処理が飲み込まれるだけの猶予を与える。
      await new Promise((resolve) => setTimeout(resolve, 0));

      const overLimitId = `bg-${String(SUBAGENT_WAKEUP_LIMIT + 1)}`;
      await registerBackgroundTask(started.options, overLimitId, 'agent-1');
      const overLimitResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: overLimitId, type: 'monitor', status: 'running' },
        ],
      });

      // **もし `#subagentWakeups` がターンの頭でリセットされていたら、ここは
      // また起こし直されて `hookSpecificOutput` が付く。** 付かないことが
      // 「リセットしていない」ことの歯である。
      expect(overLimitResult).toEqual({ continue: true });
      const notes = noteEvents(s.events);
      expect(notes.at(-1)?.escalate).toBe(true);
    });
  });

  /**
   * **`#subagentWakeups` の LRU 上限**（`runner.ts` の `SUBAGENT_WAKEUP_TRACKING_LIMIT`。
   * `BACKGROUND_TASK_OWNER_LIMIT` と同じ形——超えたら「いちばん古いもの」から
   * 捨てる）。**この定数は `export` していない**（`export` を求められているのは
   * `SUBAGENT_WAKEUP_LIMIT` だけ）ので、ここでは値を直書きする。ずれたら
   * この歯が壊れる形自体が、直書きしたことの検算になる。
   *
   * 観測できるのは中身ではなく振る舞いだけなので、「捨てられた `agent_id` は
   * カウント0から再スタートする」ことで間接的に確かめる —— 501番目の
   * 別の agent を登録して1番目を押し出し、その後で1番目を改めて呼ぶと、
   * 「2回目」ではなく「1回目」に戻っていることを見る。
   */
  it('#subagentWakeups は上限（500件）を超えたら、いちばん古い agent_id から捨てる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const trackingLimit = 500;

    // `agent-1` を含む 501 件を登録する（1件ずつ「1回目」として起こし直させる）。
    for (let n = 1; n <= trackingLimit + 1; n += 1) {
      const agentId = `agent-lru-${n}`;
      const taskId = `bg-lru-${n}`;
      await registerBackgroundTask(started.options, taskId, agentId);
      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: agentId,
        background_tasks: [selfEntry(agentId), { id: taskId, type: 'monitor', status: 'running' }],
      });
      expect(result).toHaveProperty('hookSpecificOutput');
    }

    // **501件目を登録した時点で、いちばん古い `agent-lru-1` が表から捨てられて
    // いるはず。** 改めて呼ぶと、カウントが残っていれば「2回目」になるが、
    // 捨てられていれば0から再スタートして「1回目」になる。
    const revisitTaskId = 'bg-lru-1-revisit';
    await registerBackgroundTask(started.options, revisitTaskId, 'agent-lru-1');
    const revisit = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-lru-1',
      background_tasks: [
        selfEntry('agent-lru-1'),
        { id: revisitTaskId, type: 'monitor', status: 'running' },
      ],
    });

    expect(revisit).toHaveProperty('hookSpecificOutput');
    const additionalContext = (revisit as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(additionalContext).toContain(`1回目（上限 ${SUBAGENT_WAKEUP_LIMIT}）`);
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
    const result = await fireSubagentStop(started.options, {
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

    const result = await fireSubagentStop(started.options, {
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
  });
});
