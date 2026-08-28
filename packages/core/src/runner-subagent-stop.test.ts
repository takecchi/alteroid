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

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * `SubagentStop` フックの観測口（#357 / #570）を確かめる。
 *
 * **観測専用であることと、「当人が起こしたものだけを出す」ことが本題である。**
 * 実測（SDK 0.3.247。#570 に生 JSON）で分かったのは3つ:
 *
 * 1. `background_tasks` には**畳もうとしている当人**が必ず入る（`id` = `agent_id`）
 * 2. **兄弟の作業者**も入る（何も待っていない作業者の配列にも載る）
 * 3. ⟹ **件数では「この作業者が待っている」が言えない。**所有者は
 *    `PostToolUse` の `tool_response.backgroundTaskId` と `agent_id` から引く
 *
 * だからここで固定するのは「**誤爆しないこと**」が中心である —— 当人だけ・
 * 兄弟だけでは `note` を出さない。出すのは、当人が自分で起こした背景処理が
 * 残っているときだけである。
 *
 * どのケースでも戻り値は必ず `{ continue: true }`（挙動を変えない。`decision`
 * も `additionalContext` も返さない）。
 *
 * `agent-session-options.test.ts` の `fakeRunnerSdk`（`host.start` が同期に
 * `queryFn` を呼ぶことを利用して `options` を捕まえる形）と同じ足場を使う。
 */
interface Started {
  options: Options;
  finish: () => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let finish: (() => void) | undefined;
    const record: Started = {
      options: input.options,
      finish: () => finish?.(),
    };
    started.push(record);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
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
  return { id: agentId, type: 'subagent', status: 'running', description: '当人', agent_type: 'worker' };
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

  it('当人が自分で起こした背景処理が残っていれば note が1本出て、type と status と command が載る', async () => {
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

    expect(result).toEqual({ continue: true });

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    expect(text).toContain('type=shell');
    expect(text).toContain('status=running');
    expect(text).toContain('command=pnpm verify');
    // 当人が起こした分の件数と、セッション全体の在庫の件数を両方載せる。
    expect(text).toContain('1件 残ったまま畳んだ');
    expect(text).toContain('在庫=2件');
    // 発火条件の断りを本文にも書く（doc だけに書くと、片方しか読まない人が誤る）。
    expect(text).toContain('空転が無かった');
  });

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

  it('所有者を引けない背景処理が在ると診断が出る。ただしセッションに1回だけ', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const input = {
      ...STOP_BASE,
      agent_id: 'agent-1',
      // `bg-unknown` は表に無い（＝ `PostToolUse` の経路が壊れたときの顔）。
      background_tasks: [selfEntry('agent-1'), { id: 'bg-unknown', type: 'shell', status: 'running' }],
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

  it('text が長すぎる入力では上限で切られ、切ったことが末尾に書かれる', async () => {
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

    expect(result).toEqual({ continue: true });

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    // 元の説明をそのまま含めば5,000文字を超えるはずなので、上限より十分短い
    // ことを確かめれば「切られた」ことになる。
    expect(text.length).toBeLessThan(longDescription.length);
    expect(text).toContain('文字で切った');
  });

  /**
   * **この1本が無いと、条件1（当人の分が在れば毎回）が固定されない。**
   * 「最初の1回だけ出す」だけの実装でも上は緑になりうるので、ここで撃ち分ける。
   */
  it('当人の背景処理が残るたびに note が出る（最初の1回だけ、ではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    for (const n of [1, 2]) {
      await registerBackgroundTask(started.options, `bg-${n}`, 'agent-1');
      const result = await fireSubagentStop(started.options, {
        ...STOP_BASE,
        agent_id: 'agent-1',
        background_tasks: [
          selfEntry('agent-1'),
          { id: `bg-${n}`, type: 'monitor', status: 'running', description: `CI の見張り ${n}` },
        ],
      });
      expect(result).toEqual({ continue: true });
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toContain('type=monitor');
    expect(notes[1]?.text).toContain('CI の見張り 2');
  });
});
