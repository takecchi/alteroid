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
 * `SubagentStop` フックの観測口（#357）を確かめる。
 *
 * **観測専用であることが本題である。** ここで固定したいのは3つ:
 * 1. `background_tasks` が非空なら `note` が出て、`text` に各タスクの `type` /
 *    `status` が載ること
 * 2. `background_tasks` が空の入力では、そのセッションで最初の1回だけ `note`
 *    が出て、2回目以降は出ないこと（「1度も発火していない」と「発火している
 *    が常に空」を日誌の上で区別するための1回。`runner.ts` の `#onSubagentStop`
 *    の doc）
 * 3. `text` に上限が掛かっていて、超えたら切り、切ったことを末尾に書くこと
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

describe('SubagentStop の観測（#357）', () => {
  it('background_tasks が非空なら note が1本出て、text に type と status が載る', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await fireSubagentStop(started.options, {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'agent-1',
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      agent_type: 'worker',
      background_tasks: [
        { id: 'bg-1', type: 'shell', status: 'running', description: 'pnpm verify を実行中' },
      ],
      session_crons: [],
    });

    expect(result).toEqual({ continue: true });

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('type=shell');
    expect(notes[0]?.text).toContain('status=running');
    expect(notes[0]?.text).toContain('background_tasks=1件');
  });

  it('空配列の入力では最初の1回だけ note が出て、2回目は出ない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const emptyInput = {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'agent-1',
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      agent_type: 'worker',
      background_tasks: [],
      session_crons: [],
    };

    const first = await fireSubagentStop(started.options, emptyInput);
    expect(first).toEqual({ continue: true });
    expect(noteEvents(s.events)).toHaveLength(1);

    const second = await fireSubagentStop(started.options, emptyInput);
    expect(second).toEqual({ continue: true });
    // 2回目は増えない（1回目のままである）。
    expect(noteEvents(s.events)).toHaveLength(1);
  });

  it('text が長すぎる入力では上限で切られ、切ったことが末尾に書かれる', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const longDescription = 'あ'.repeat(5_000);
    const result = await fireSubagentStop(started.options, {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'agent-1',
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      agent_type: 'worker',
      background_tasks: [
        { id: 'bg-1', type: 'shell', status: 'running', description: longDescription },
      ],
      session_crons: [],
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
   * **この1本が無いと、条件1（非空なら毎回）が固定されない。**
   * 「最初の1回だけ出す」だけの実装でも、上の3本はすべて緑になる
   * （上は非空を1度しか撃っていないため）。ここで撃ち分ける。
   */
  it('非空の入力は2回目以降も毎回 note が出る（最初の1回だけ、ではない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const base = {
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_id: 'agent-1',
      agent_transcript_path: '/tmp/does-not-exist.jsonl',
      agent_type: 'worker',
      session_crons: [],
    };

    // 1回目は空 — 「最初の発火」の枠をここで使い切っておく。
    await fireSubagentStop(started.options, { ...base, background_tasks: [] });
    expect(noteEvents(s.events)).toHaveLength(1);

    // 2回目・3回目は非空 — 「最初の発火」ではないので、条件1でしか出ない。
    for (const n of [1, 2]) {
      const result = await fireSubagentStop(started.options, {
        ...base,
        background_tasks: [
          { id: `bg-${n}`, type: 'monitor', status: 'running', description: `CI の見張り ${n}` },
        ],
      });
      expect(result).toEqual({ continue: true });
    }

    const notes = noteEvents(s.events);
    expect(notes).toHaveLength(3);
    expect(notes[1]?.text).toContain('type=monitor');
    expect(notes[2]?.text).toContain('CI の見張り 2');
  });
});
