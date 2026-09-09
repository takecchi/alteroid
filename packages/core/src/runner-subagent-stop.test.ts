import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  SDKTaskUpdatedMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRunnerHost,
  type RunnerHost,
  SUBAGENT_WAKEUP_LIMIT_PER_AGENT,
  SUBAGENT_WAKEUP_LIMIT_PER_TASK,
} from './runner.js';
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
 * ## ⚠️ さらに反転させた事実（この PR。#570 の追跡の続き）
 *
 * **起こし直しの予算の単位が `agent_id` 単体から「作業者 × 背景処理」の
 * 組へ変わった。** 以前は `SUBAGENT_WAKEUP_LIMIT`（作業者ぶん通算2回）
 * だけで、複数の背景処理を順に起こす作業者は最初の1本にしか起こし直しを
 * 受けられなかった（依頼者の日誌、2026-09-08 — 背景処理を4本
 * A→B→D→C の順に起こした作業者のうち、起こし直しを受けたのは A だけ
 * だった）。いまは `SUBAGENT_WAKEUP_LIMIT_PER_TASK`（背景処理1本あたり）
 * と `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`（作業者の通算。単位を背景処理にした
 * ことで開く2つの穴の保険——詳細は `runner.ts` の同名の doc）の2段になった。
 * `SUBAGENT_WAKEUP_LIMIT` という名前そのものは消してある——意味が変わった
 * のに名前を残すと嘘になるためである。**下の「当人の背景処理が残るたびに
 * note が出て起こし直す」「起こし直しが上限に達したら」の各テストの doc に
 * この PR での変更点を追記した。**
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
   *
   * ⚠️ **この PR で文言の形が変わった（`SUBAGENT_WAKEUP_LIMIT_PER_TASK` /
   * `SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の doc）。** 通算（この作業者の
   * 通算 n回目 / 通し上限）と、1本あたり（この背景処理では n回目 / 1本
   * あたりの上限）の**両方**を文言から読めることを、ここで確かめる。
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
    // **通算（per-agent）の文言。** 単位が「作業者 × 背景処理」へ変わった
    // ので、通算の1回目であることを名乗る形も変わった。
    expect(additionalContext).toContain(
      `これはこの作業者の通算 1回目（通し上限 ${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}）`,
    );
    // **1本あたり（per-task）の文言も同じ additionalContext に載る**
    // （`taskLines` を additionalContext にも足しているため）。
    expect(additionalContext).toContain(
      `この背景処理では 1回目 / 1本あたりの上限 ${SUBAGENT_WAKEUP_LIMIT_PER_TASK}`,
    );
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
    expect(text).toContain(`この作業者の通算 1回目 / 通し上限 ${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}`);
    expect(text).toContain(
      `この背景処理では 1回目 / 1本あたりの上限 ${SUBAGENT_WAKEUP_LIMIT_PER_TASK}`,
    );
    // 発火条件の断りを本文にも書く（doc だけに書くと、片方しか読まない人が誤る）。
    expect(text).toContain('空転が無かった');
    // escalate は立たない（上限に達していないので、あくまで起こし直し）。
    expect(notes[0]?.escalate).toBeUndefined();
    // 直上の additionalContext と対にして、note 側も短ければ切られないことを見る。
    expect(text).not.toContain('文字で切った');

    /**
     * **型付き種別（`journalEntrySchema` の `subagent_stall`）へ渡す構造欄。**
     * `manager.ts` の `case 'note'` はこの `stall` の有無で日誌の種別を
     * 振り分ける（`stall` が有れば `subagent_stall`、無ければ `exchange`）。
     * ここで固定するのは「上限未満（起こし直した）分岐」が正しい形の
     * `stall` を載せることである。
     */
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
   * ⚠️ **反転させた歯（PR #594 →この PR で二重に反転している）。** 元々は
   * ここで「戻り値は必ず `{ continue: true }`」を固定していた（1回目の
   * 反転で「`SUBAGENT_WAKEUP_LIMIT` 回まではどちらも起こし直しの対象」に
   * 変わった——このときは毎回**別の**背景処理 id（`bg-1` / `bg-2` / …）を
   * 使っていて、それでも通算2回で尽きる形を固定していた。**それ自体が
   * 現行の欠陥を仕様として固定していた**（依頼者の日誌 2026-09-08 —— 1体の
   * 作業者が背景処理を4本 A→B→D→C の順に起こしたが、起こし直しを受けた
   * のは A だけで、B・D・C は20分にわたって一度も待たれなかった。予算が
   * `agent_id` 単位の通算2回で、背景処理ごとには配られていなかったため）。
   *
   * **この PR での反転:** 期待値を「**通算は増えるが、各背景処理では
   * 毎回1回目**」へ反転する。ループは `SUBAGENT_WAKEUP_LIMIT_PER_TASK`
   * ではなく `SUBAGENT_WAKEUP_LIMIT_PER_AGENT` 回まわす——毎回**別の**
   * 背景処理を使うので、per-task の上限には一度も触れず、通し上限
   * ちょうどまでは毎回「起こし直される」側になる。**なぜ保証が弱くなって
   * いないか**: 「当人の分が残っていれば毎回起こし直す」という主張
   * そのものは維持したまま、単位を「背景処理ごとに独立している」ことを
   * 明示する側へ強めている——以前の版は「別の背景処理でも回数が共有される」
   * ことを検算していなかった。
   */
  it('当人の背景処理が残るたびに note が出て起こし直す（最初の1回だけ、ではない。通算は増えるが各背景処理では毎回1回目）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const attempts = Array.from({ length: SUBAGENT_WAKEUP_LIMIT_PER_AGENT }, (_unused, i) => i + 1);
    for (const n of attempts) {
      // **毎回別の背景処理**（`bg-${n}`）。これが本題——別々の背景処理には
      // 別々の per-task 予算が配られるので、`n` が増えても per-task の
      // カウントは常に「1回目」のままである。
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
      // **通算（per-agent）は n 回目まで増える。**
      expect(additionalContext).toContain(`これはこの作業者の通算 ${String(n)}回目`);
      // **per-task は毎回「1回目」——別の背景処理だからである。**
      expect(additionalContext).toContain('この背景処理では 1回目');
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(attempts.length);
    expect(notes[0]?.text).toContain('type=monitor');
    expect(notes[0]?.text).toContain('この背景処理では 1回目');
    expect(notes[0]?.text).toContain(
      `この作業者の通算 1回目 / 通し上限 ${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}`,
    );
    expect(notes.at(-1)?.text).toContain(`CI の見張り ${String(attempts.length)}`);
    // **最後の回でも per-task は「1回目」のまま**（別の背景処理なので）。
    expect(notes.at(-1)?.text).toContain('この背景処理では 1回目');
    expect(notes.at(-1)?.text).toContain(
      `この作業者の通算 ${String(attempts.length)}回目 / 通し上限 ${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}`,
    );
    expect(notes.at(-1)?.stall?.wakeupCount).toBe(attempts.length);
    // 通し上限ちょうどまではどの回も escalate しない。
    for (const note of notes) expect(note.escalate).toBeUndefined();
  });

  /**
   * ⭐ **背景処理が違えば予算は別に配られる（この PR の本体）。**
   * 直上の歯が「毎回別の背景処理」を通算の側から確かめるのに対し、
   * こちらは「1本の背景処理を使い切っても、別の背景処理は影響を受けない」
   * ことを、`escalate` の手前まで踏み込んで確かめる。
   */
  it('背景処理 A を1本あたりの上限まで使い切っても、新しい背景処理 B はまた起こし直される（B では「1回目」）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // 背景処理 A（`bg-a`）を1本あたりの上限まで使い切る。
    await registerBackgroundTask(started.options, 'bg-a', 'agent-1');
    for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK; n += 1) {
      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-a', type: 'monitor', status: 'running' },
        ],
      });
      expect(result).toHaveProperty('hookSpecificOutput');
    }
    // A はもう1本あたりの上限に達している（escalate になることを前提として
    // 確かめる——ここが崩れていたら下の B の検算そのものが無意味になる）。
    const aOver = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-a', type: 'monitor', status: 'running' }],
    });
    expect(aOver).toEqual({ continue: true });
    expect(noteEvents(s.events).at(-1)?.escalate).toBe(true);

    // **新しい背景処理 B が残って畳もうとしたら、また起こし直される
    // （B では「1回目」）** —— A を使い切ったことは B の予算に影響しない。
    await registerBackgroundTask(started.options, 'bg-b', 'agent-1');
    const bFirst = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-b', type: 'monitor', status: 'running' }],
    });
    expect(bFirst).toHaveProperty('hookSpecificOutput');
    const notes = noteEvents(s.events);
    expect(notes.at(-1)?.escalate).toBeUndefined();
    expect(notes.at(-1)?.text).toContain('この背景処理では 1回目');
  });

  /**
   * ⭐ **変異試験で開いた穴を塞いだ歯（この PR）。**
   *
   * **1回の `SubagentStop` に残っている背景処理が複数あるとき、加算は
   * 「残っている全件」に効く**（`runner.ts` の `#onSubagentStop` —— 逐語は
   * `grep -Fn -- '「全件」（`underPerTask` だけではない）なのは' packages/core/src/runner.ts`）。
   * その回に「待たされた」のは残っている背景処理の全部だからである。
   *
   * **この歯は、変異試験で「生存」が出たあとに足した。** 加算を
   * `remainingIds` から `remainingIds.slice(0, 1)`（＝先頭1件だけ）へ変える
   * 変異が、**この歯を足す前は全 5,028 件を素通りした**（生存の4分類の
   * 2「歯が無い」）。**残っている背景処理が複数ある回を撃つ歯が1本も
   * 無かった** —— 他の歯はどれも「残り1件」の形でしか発火させていない。
   *
   * **測り方**: 1回目に2件（`bg-x` / `bg-y`）を同時に残して起こし直させ、
   * 2回目は**2件目の `bg-y` だけ**を残して撃つ。全件を数えていれば
   * `bg-y` は既に1回使っているので「2回目」になる。**先頭1件しか数えて
   * いなければ `bg-y` は0のままなので「1回目」になる。**
   * ⚠️ **確かめるのは2件目でなければならない** —— 先頭の `bg-x` は
   * どちらの実装でも数えられるので、`bg-x` で見るとこの歯は何も測らない。
   */
  it('1回に複数の背景処理が残っていたら、その全部の回数が増える（先頭1件だけではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await registerBackgroundTask(started.options, 'bg-x', 'agent-1');
    await registerBackgroundTask(started.options, 'bg-y', 'agent-1');

    // 1回目 —— 2件とも残したまま畳もうとした。
    const first = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-x', type: 'monitor', status: 'running' },
        { id: 'bg-y', type: 'monitor', status: 'running' },
      ],
    });
    expect(first).toHaveProperty('hookSpecificOutput');

    // 2回目 —— **2件目の `bg-y` だけ**を残して撃つ。
    const second = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-y', type: 'monitor', status: 'running' }],
    });
    expect(second).toHaveProperty('hookSpecificOutput');
    const context = (second as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('この背景処理では 2回目');
  });

  /**
   * **上限に達したら起こし直しをやめる。** `additionalContext` は返さず、
   * `escalate: true` の `note` を出す（`manager.ts` の `case 'note'` が
   * これを見て受信箱へも1本上げる）。
   *
   * ⚠️ **単位が「作業者 × 背景処理」になったので、上限は2段になった**
   * （`SUBAGENT_WAKEUP_LIMIT_PER_TASK` / `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`
   * の doc）。下の3本（既存の反転2本＋新規1本）は per-task 側を、
   * 「通し上限（穴A）」「優先順位」の2本は per-agent 側を確かめる。
   */
  describe('起こし直しが上限に達したら', () => {
    /**
     * ⚠️ **反転させた歯（この PR）。** 以前は毎回**別の**背景処理 id
     * （`bg-${n}`）を使っていて、それでも `agent_id` 単位の通算だけで
     * 上限に到達する形を固定していた——**これが現行の欠陥そのものだった**
     * （ファイル冒頭の doc の #570 続報。単位が `agent_id` 単体だと、
     * 別の背景処理を起こしても予算が共有されてしまう）。
     *
     * **この PR での反転:** **同じ背景処理 id を使う形へ変える**（そうしない
     * と per-task の上限に到達しない——`agent_id` 単体が単位だった以前とは
     * 違い、いまは背景処理ごとに別の予算が要るので、上限へ到達させるには
     * 同じ背景処理を繰り返し残す必要がある）。**これは緩めではなく「対象を
     * スコープして特定する」側である**——以前は「`agent_id` の通算」を見て
     * いたが、いまは「特定の1本の背景処理を使い切る」という、より狭く
     * 具体的な状況を再現している。主張（上限に達したら起こし直さず
     * escalate する）は変えていない。
     */
    it('同じ背景処理で1本あたりの上限まで起こし直したあと、次の回は起こし直さず escalate な note が出る（per-task）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      // **同じ背景処理（bg-1）** を1本あたりの上限ちょうどまで残し続ける。
      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK; n += 1) {
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-1', type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // 上限+1回目 —— 同じ背景処理はもう1本あたりの上限に達しているので、
      // 通し上限（M=8）にはまだ余裕があっても起こし直さない。
      const overLimitResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running' },
        ],
      });

      // **起こし直さない ⟹ `additionalContext` を返さない。**
      expect(overLimitResult).toEqual({ continue: true });

      const notes = noteEvents(s.events);
      expect(notes).toHaveLength(SUBAGENT_WAKEUP_LIMIT_PER_TASK + 1);
      const escalated = notes.at(-1);
      expect(escalated?.escalate).toBe(true);
      expect(escalated?.text).toContain('起こし直さなかった');
      // **per-task の文言を名乗ること。** 通し上限（per-agent）にはまだ
      // 達していない（total=2<8）ので、理由は「残っている背景処理はどれも
      // 1本あたりの上限に達した」側になる。
      expect(escalated?.text).toContain(
        `残っている背景処理はどれも1本あたりの上限（${SUBAGENT_WAKEUP_LIMIT_PER_TASK}回）に達したため`,
      );
      expect(escalated?.text).not.toContain('この作業者の通し上限');
      // それより前の回は escalate していない。
      for (const note of notes.slice(0, -1)) expect(note.escalate).toBeUndefined();

      /**
       * **上限到達分岐の `stall`。** `outcome: 'limit_reached'` で、
       * `wakeupCount` はスキーマの doc（「この `agent_id` を起こし直した
       * 回数（今回を含む）」）どおり、この作業者の**通算**（今回は同じ
       * 背景処理だけを使ったので `SUBAGENT_WAKEUP_LIMIT_PER_TASK` と
       * 同じ値になる）——起こし直していないのでこの回のぶんは足されない。
       */
      expect(escalated?.stall).toEqual({
        agentId: 'agent-1',
        agentType: 'worker',
        ownedTaskCount: 1,
        sessionTaskCount: 2,
        wakeupCount: SUBAGENT_WAKEUP_LIMIT_PER_TASK,
        outcome: 'limit_reached',
      });
      // 上限未満の回（起こし直した側）は `outcome: 'woken'` のまま。
      for (const note of notes.slice(0, -1)) expect(note.stall?.outcome).toBe('woken');
    });

    /**
     * ⚠️ **反転させた歯（この PR）。** 以前は `agent-1` 側も毎回別の
     * 背景処理 id（`a1-bg-${n}`）を使っていた。**この PR での反転:** 同じ
     * 背景処理 id を使う形へ変える（同上の理由——per-task の上限に到達
     * させるため）。**主張（上限は `agent_id` ごとに独立している）は
     * 変えていない。**
     */
    it('agent_id が違えば上限は独立している', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      // `agent-1` は同じ背景処理を使い切る（per-task の上限に到達させる）。
      await registerBackgroundTask(started.options, 'a1-bg-1', 'agent-1');
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK; n += 1) {
        await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'a1-bg-1', type: 'monitor', status: 'running' },
          ],
        });
      }
      // `agent-1` はもう a1-bg-1 について上限に達している（escalate になる）
      // ことを前提として確かめる。
      const agent1Over = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'a1-bg-1', type: 'monitor', status: 'running' },
        ],
      });
      expect(agent1Over).toEqual({ continue: true });

      // 別の `agent-2` は、これが初回なので起こし直される——`agent-1` の
      // per-task 上限到達とは独立している。
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
      expect(additionalContext).toContain('この作業者の通算 1回目');
    });

    /**
     * ⚠️ **反転させた歯（この PR）。** 以前は毎回別の背景処理 id を使って
     * いた。**この PR での反転:** 同じ背景処理 id を使う形へ変える（同上の
     * 理由）。**主張（ターン境界を挟んでも上限は再装填されない）は変えて
     * いない。**
     *
     * **ターン境界（`session_started`。#643 の形）を挟んでも上限は再装填
     * されない。** `#subagentWakeups` / `#subagentWakeupTotals` は
     * `runner.ts` の doc に書いたとおりリセットしない設計——ここで実際に
     * `init` をもう一度流し、それでも「起こし直しても進まなかった」が
     * 正しく積み上がることを見る。
     */
    it('ターン（session_started）をまたいでも起こし直しの上限は再装填されない', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK; n += 1) {
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-1', type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // **同じセッションのまま、次のターンの頭が来る**（`sess-1` を明示的に
      // 再送。`runner.ts` の `case 'session_started'` は同じ `sessionId` なら
      // `#liveBackgroundTasks` すら空へ戻さない——`#subagentWakeups` /
      // `#subagentWakeupTotals` はそもそもどの分岐からも触られない）。
      started.restart('sess-1');
      // フックへの直接呼び出しとは別径路（メッセージストリーム）なので、
      // 処理が飲み込まれるだけの猶予を与える。
      await new Promise((resolve) => setTimeout(resolve, 0));

      const overLimitResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-1', type: 'monitor', status: 'running' },
        ],
      });

      // **もし `#subagentWakeups` がターンの頭でリセットされていたら、ここは
      // また起こし直されて `hookSpecificOutput` が付く。** 付かないことが
      // 「リセットしていない」ことの歯である。
      expect(overLimitResult).toEqual({ continue: true });
      const notes = noteEvents(s.events);
      expect(notes.at(-1)?.escalate).toBe(true);
    });

    /**
     * ⭐ **新規（この PR で足した歯）。通し上限（`SUBAGENT_WAKEUP_LIMIT_PER_AGENT`）
     * の歯 —— 穴A の検算。** 同じ作業者が**毎回違う**背景処理 id で通し
     * 上限ちょうどまで起こし直された後、M+1回目は起こし直さない。**この
     * とき使った背景処理はどれも per-task の上限（2回）に達していない**
     * （全部「1回目」で終わっている）ので、`escalate` の理由は必ず
     * `'per-agent'` でなければならない——per-task の文言が出たらこの歯が
     * 間違った理由を検算していることになる。
     */
    it('通し上限（per-agent）に達したら、毎回違う背景処理でも起こし直さない（穴A）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_AGENT; n += 1) {
        await registerBackgroundTask(started.options, `bg-hole-a-${n}`, 'agent-1');
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-hole-a-${n}`, type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // M+1回目 —— さらに新しい（まだ一度も使っていない）背景処理でも、
      // 通し上限に達しているので起こし直さない。
      const overId = `bg-hole-a-${String(SUBAGENT_WAKEUP_LIMIT_PER_AGENT + 1)}`;
      await registerBackgroundTask(started.options, overId, 'agent-1');
      const overResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: overId, type: 'monitor', status: 'running' },
        ],
      });

      expect(overResult).toEqual({ continue: true });
      const notes = noteEvents(s.events);
      const escalated = notes.at(-1);
      expect(escalated?.escalate).toBe(true);
      // **per-agent の文言を名乗ること。**
      expect(escalated?.text).toContain(
        `この作業者の通し上限（${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}回）に達したため`,
      );
      expect(escalated?.text).not.toContain('残っている背景処理はどれも1本あたりの上限');
      expect(escalated?.stall?.outcome).toBe('limit_reached');
      expect(escalated?.stall?.wakeupCount).toBe(SUBAGENT_WAKEUP_LIMIT_PER_AGENT);
    });

    /**
     * ⭐ **新規（この PR で足した歯）。優先順位の歯。** 通し上限（M）と
     * 1本あたりの上限（N）が**同時に**成り立つときは、`'per-agent'` を
     * 名乗る（`SUBAGENT_WAKEUP_LIMIT_PER_AGENT` の doc「優先順位」）——
     * 通し上限のほうが重い歯なので。
     */
    it('通し上限（M）と1本あたりの上限（N）が同時に成り立つときは per-agent を名乗る（優先順位）', async () => {
      const s = setup();
      await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
      const started = s.started[0];
      if (started === undefined) throw new Error('セッションが開いていない');

      // まず別々の背景処理で通算を M - N まで積む（それぞれ per-task は
      // 1回しか使わないので、この段階では per-task の上限に触れない）。
      const warmups = SUBAGENT_WAKEUP_LIMIT_PER_AGENT - SUBAGENT_WAKEUP_LIMIT_PER_TASK;
      for (let n = 1; n <= warmups; n += 1) {
        await registerBackgroundTask(started.options, `bg-warmup-${n}`, 'agent-1');
        await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: `bg-warmup-${n}`, type: 'monitor', status: 'running' },
          ],
        });
      }

      // 同じ背景処理（bg-priority）を per-task の上限ちょうどまで使う。
      // これで通算も同時に M へ到達する。
      await registerBackgroundTask(started.options, 'bg-priority', 'agent-1');
      for (let n = 1; n <= SUBAGENT_WAKEUP_LIMIT_PER_TASK; n += 1) {
        const result = await fireSubagentStop(started.options, {
          ...STOP_BASE,
          agent_id: 'agent-1',
          background_tasks: [
            selfEntry('agent-1'),
            { id: 'bg-priority', type: 'monitor', status: 'running' },
          ],
        });
        expect(result).toHaveProperty('hookSpecificOutput');
      }

      // ここで通算は M、bg-priority の per-task も N ちょうど —— 両方が
      // 同時に上限へ達している。
      const overResult = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: 'bg-priority', type: 'monitor', status: 'running' },
        ],
      });
      expect(overResult).toEqual({ continue: true });

      const notes = noteEvents(s.events);
      const escalated = notes.at(-1);
      expect(escalated?.escalate).toBe(true);
      // **両方成り立つので `'per-agent'` を名乗る。**
      expect(escalated?.text).toContain(
        `この作業者の通し上限（${SUBAGENT_WAKEUP_LIMIT_PER_AGENT}回）に達したため`,
      );
      expect(escalated?.text).not.toContain('残っている背景処理はどれも1本あたりの上限');
    });
  });

  /**
   * ⭐ **書き直した歯（この PR）。** 鍵が `agent_id` 単体から「作業者 ×
   * 背景処理」の組へ変わったので、以前の形（501番目で追い出し、**別の**
   * 新しい背景処理 id で revisit して「1回目」を見る）はもう何も検算
   * しない——revisit に使う id が最初から存在しない新しい鍵である以上、
   * 枝刈りが1件も効いていなくても「1回目」になる（キーを1回も見た
   * ことが無いのだから当然である）。**この PR ではこの穴を塞ぎ、
   * revisit にも同じ鍵（同じ `agent_id` + 同じ背景処理 id）を使うことで、
   * FIFO と LRU を実際に見分けられる形へ書き直した。**
   *
   * **`#subagentWakeups` の枝刈りは FIFO であって LRU ではない**
   * （`runner.ts` の `pruneOldestEntries` の doc。`SUBAGENT_WAKEUP_TRACKING_LIMIT`
   * = 500。**この定数は `export` していない**——`export` を求められている
   * のは `SUBAGENT_WAKEUP_LIMIT_PER_TASK` / `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`
   * だけ——なので、ここでは値を直書きする。ずれたらこの歯が壊れる形自体が、
   * 直書きしたことの検算になる）。
   *
   * **手順（この順序が歯の本体）:**
   * 1. `(agent-1, bg-1)` を1回起こし直す（この鍵が Map の先頭に入る）
   * 2. 別の499件（別々の agent。背景処理 id は使い回す——下の実装コメント
   *    参照）を1回ずつ起こし直す（Map は500件でまだ枝刈りされない）
   * 3. `(agent-1, bg-1)` をもう1回（count=2。`Map.set()` は既存鍵の順を
   *    変えないので、FIFO なら位置は先頭のまま／LRU なら末尾へ動く）
   * 4. さらに1件（501件目）入れて枝刈りを起こす
   * 5. **併せて、2番目に入れた鍵**（この歯では `agent-fifo-2` /
   *    `bg-shared`）**が落ちていないことを見る**（LRU ならそちらが落ちる
   *    側なので、両側から挟める）。**⚠️ 実装ではこの確認を次の6より先に
   *    行う**——6 は削られた鍵を新規挿入として復活させるので、それ自体が
   *    もう一段の枝刈りを引き起こし、そのとき最も古い鍵（＝まだ確認前なら
   *    ちょうどこの鍵）を道連れにしてしまう。先に読んでおけば、後で
   *    壊れても確認そのものは汚染されない。
   * 6. ⟹ **FIFO なら `(agent-1, bg-1)` が落ちる ⟹ もう一度撃つと「1回目」
   *    に戻って起こし直される。LRU なら生き残っていて count=2 ＝ per-task
   *    上限なので escalate になる。**
   *
   * **落ちるのはいちばん長く空転している鍵で、それはいちばん残したい
   * ものである。落ちた鍵はカウント0から再スタートするので、その作業者の
   * 予算だけが黙って再装填される。**
   */
  it('#subagentWakeups の枝刈りは FIFO であって LRU ではない（Map.set() は既存鍵の順を変えない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const trackingLimit = 500;
    // **`#backgroundTaskOwners`（別の表。この PR では触っていない）も同じ
    // 500件で自前の FIFO を持つ**——499件の filler がそれぞれ違う背景処理 id
    // で所有者登録すると、その表自身が先に枝刈りされ、`bg-1` の所有権が
    // （この歯が確かめたいものとは無関係な理由で）落ちてしまう。**それを
    // 避けるため、filler は同じ背景処理 id（`bg-shared`）を使い回す**——
    // `#backgroundTaskOwners` は id をキーにした表なので、同じ id を
    // 使い回す限り何度登録してもその表は1件しか消費しない。一方
    // `#subagentWakeups` の鍵は `agentId + taskId` の組なので、agent が
    // 違えば同じ `bg-shared` でもちゃんと別々の鍵になる。
    const sharedTaskId = 'bg-shared';

    // 1) (agent-1, bg-1) を1回起こし直す —— この鍵が Map の先頭に入る。
    await registerBackgroundTask(started.options, 'bg-1', 'agent-1');
    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'monitor', status: 'running' }],
    });

    // 2) 別の499件（別々の agent。id は使い回し）を1回ずつ起こし直す。
    //    `#subagentWakeups` は500件でまだ枝刈りされない。最初に入れる鍵
    //    （agent-fifo-2, bg-shared）を後で確かめる。
    for (let n = 2; n <= trackingLimit; n += 1) {
      const agentId = `agent-fifo-${n}`;
      await registerBackgroundTask(started.options, sharedTaskId, agentId);
      await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: agentId,
        background_tasks: [
          selfEntry(agentId),
          { id: sharedTaskId, type: 'monitor', status: 'running' },
        ],
      });
    }

    // 3) (agent-1, bg-1) をもう1回 —— count=2。FIFO ならこの鍵はまだ
    //    先頭のまま（LRU なら末尾へ動く）。
    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'monitor', status: 'running' }],
    });

    // 4) さらに1件（501件目。agent-fifo-over, bg-shared）入れて枝刈りを起こす。
    await registerBackgroundTask(started.options, sharedTaskId, 'agent-fifo-over');
    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-fifo-over',
      background_tasks: [
        selfEntry('agent-fifo-over'),
        { id: sharedTaskId, type: 'monitor', status: 'running' },
      ],
    });

    // 5) **併せて、2番目に入れた鍵（agent-fifo-2, bg-shared）が落ちていない
    //    ことを先に確かめる**（LRU ならそちらが落ちる側なので、両側から
    //    挟める）。**⚠️ この確認は次の6)より先に行う必要がある** ——
    //    6) は削られた `(agent-1, bg-1)` を**新しい鍵として**マップへ
    //    再挿入するので、その時点でまた500件を超えて枝刈りが起こり、
    //    今度は「そのとき最も古い鍵」（＝ちょうど agent-fifo-2、まだ更新して
    //    いなければ）が落ちる。先に読んでおけば、その値を後から6)が壊しても
    //    問題にならない。
    //    `bg-shared` の所有権はステップ4で `agent-fifo-over` へ上書きされて
    //    いるので、確かめる直前に `agent-fifo-2` へ登録し直す——これは
    //    `#backgroundTaskOwners`（1件しか使っていない）を書き換えるだけで、
    //    `#subagentWakeups` 側のカウントには一切触れない。生きていれば、
    //    まだ1回しか使っていないのでこの呼び出しは「2回目」になる。
    await registerBackgroundTask(started.options, sharedTaskId, 'agent-fifo-2');
    await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-fifo-2',
      background_tasks: [
        selfEntry('agent-fifo-2'),
        { id: sharedTaskId, type: 'monitor', status: 'running' },
      ],
    });
    expect(noteEvents(s.events).at(-1)?.text).toContain('この背景処理では 2回目');

    // 6) **FIFO なら (agent-1, bg-1) が落ちる ⟹ もう一度撃つと「1回目」に
    //    戻って起こし直される。** `bg-1` は他の誰とも共有していないので、
    //    その所有権（`#backgroundTaskOwners`）は最初の登録のまま生きている。
    const revisit = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [selfEntry('agent-1'), { id: 'bg-1', type: 'monitor', status: 'running' }],
    });
    expect(revisit).toHaveProperty('hookSpecificOutput');
    const revisitContext = (revisit as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(revisitContext).toContain('この背景処理では 1回目');
    expect(noteEvents(s.events).at(-1)?.text).toContain('この背景処理では 1回目');
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

    const result = await fireSubagentStop(started.options, {
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

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-1',
      background_tasks: [
        selfEntry('agent-1'),
        { id: 'bg-live', type: 'shell', status: 'running', description: '走っている門' },
        { id: 'bg-done', type: 'shell', status: 'completed', description: '終わった門' },
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
    expect(additionalContext).toContain('走っている門');
    expect(additionalContext).not.toContain('終わった門');

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

    const result = await fireSubagentStop(started.options, {
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

    const result = await fireSubagentStop(started.options, {
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
