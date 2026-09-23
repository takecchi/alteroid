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

import { createRunnerHost, TOOL_USE_FAILURE_NOTE_PREFIX, type RunnerHost } from './runner.js';

/**
 * **接頭辞は実装からの import に頼らず、ここでも逐語で固定する。**
 *
 * `failureNotes` の絞り込みと各テストの `startsWith` を `runner.ts` の
 * `TOOL_USE_FAILURE_NOTE_PREFIX` の import だけに頼ると、接頭辞そのものを
 * 変える変異（(iii)）を当てたときに、絞り込み側も同じ値へ追従してしまい、
 * 歯が赤くならない（変異試験の「比較の両側が同じ経路で同じ値へ強制される
 * と、比較そのものが恒真になる」と同じ形。`.claude/skills/mutation-testing/
 * SKILL.md`）。⟹ ここでは独立した逐語値を主・import 値を従とし、下の
 * 「配線」テストで両者が一致することも別途固定する。
 */
const EXPECTED_NOTE_PREFIX = 'tool_use_failure:';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

/**
 * `PostToolUseFailure` の配線（Issue #929）を確かめる。
 *
 * **`runner-pre-tool-use.test.ts` / `runner-subagent-stop.test.ts` と同じ
 * 足場・同じ作法**（`fakeRunnerSdk` / `setup`）。この PR が固定するのは4つ:
 *
 * 1. **配線そのもの。** `Options.hooks.PostToolUseFailure` が1本だけ載って
 *    いて、既存の6本を落としていないこと。
 * 2. **失敗は `note` として残り、`tool_use` としては残らないこと。** `text`
 *    は固定の接頭辞 `tool_use_failure:` で始まり、道具名・actor・error を
 *    含む。
 * 3. **`error` の500文字での切り詰めと、欠落・非文字列の扱い。**
 * 4. **背景タスクの所有者の控え（`#backgroundTaskOwners`）を作らないこと。**
 *    `PostToolUseFailureHookInput` には控えの材料（`tool_response` /
 *    `backgroundTaskId`）が無いため（Issue #929 の 2026-09-13 の測定コメント）。
 *
 * `#toolsSinceResult` への効果は、ここではなく `runner-wakeup.test.ts`
 * （`worker_wait.toolless` を観測できる既存の足場）に足した——ここに同じ
 * 足場を複製するより、既存の観測口を使うほうが強い。
 *
 * **`#markProgressed()` のもう1つの効果（`#progressed` を立てて `#seed` を
 * 解放すること）は、`worker_wait.toolless` からは観測できない。** それを
 * 外から確かめる歯は `runner-post-tool-use-failure-resume.test.ts`
 * （resume 失敗からの作り直しを通して観測する）に在る（Issue #929 の
 * 最新コメントの項目6）。
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

/** `options.hooks.PostToolUseFailure[0].hooks[0]` を直接叩く。 */
async function firePostToolUseFailure(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

/** `options.hooks.PostToolUse[0].hooks[0]` を直接叩く（tooth2 の対照用）。 */
async function firePostToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

/** `options.hooks.SubagentStop[0].hooks[0]` を直接叩く（tooth5 用）。 */
async function fireSubagentStop(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.SubagentStop?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('SubagentStop フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
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
type ToolUseEvent = Extract<RunnerEvent, { type: 'tool_use' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function toolUseEvents(events: readonly RunnerEvent[]): ToolUseEvent[] {
  return events.filter((event): event is ToolUseEvent => event.type === 'tool_use');
}

function failureNotes(events: readonly RunnerEvent[]): NoteEvent[] {
  return noteEvents(events).filter((note) => note.text.startsWith(EXPECTED_NOTE_PREFIX));
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-post-tool-use-failure-'));
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

describe('PostToolUseFailure の配線（Issue #929）', () => {
  it('export された TOOL_USE_FAILURE_NOTE_PREFIX は固定の逐語 "tool_use_failure:" である', () => {
    expect(TOOL_USE_FAILURE_NOTE_PREFIX).toBe(EXPECTED_NOTE_PREFIX);
  });

  it('マネージャーの Options に PostToolUseFailure フックが1本だけ載っている', async () => {
    const { started } = await startSession();
    expect(started.options.hooks?.PostToolUseFailure?.length).toBe(1);
    expect(started.options.hooks?.PostToolUseFailure?.[0]?.hooks?.length).toBe(1);
  });

  // **配線した既存の6本を落としていないことの検算**（この PR は足すだけ）。
  it('既存の6本（PreToolUse / PostToolUse / PreCompact / UserPromptSubmit / SubagentStop / Stop）はそのまま載っている', async () => {
    const { started } = await startSession();
    const hooks = started.options.hooks;
    expect(hooks?.PreToolUse?.length).toBe(1);
    expect(hooks?.PostToolUse?.length).toBe(1);
    expect(hooks?.PreCompact?.length).toBe(1);
    expect(hooks?.UserPromptSubmit?.length).toBe(1);
    expect(hooks?.SubagentStop?.length).toBe(1);
    expect(hooks?.Stop?.length).toBe(1);
  });
});

describe('歯1/2: 失敗は note を1件出し、tool_use は出さない', () => {
  it('マネージャー自身の失敗は tool_use_failure: で始まる note を1件出し、道具名・actor・error を含む', async () => {
    const { started, events } = await startSession();

    const result = await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'exit 1' },
      tool_use_id: 'tu-1',
      error: 'command failed with exit code 1',
    });

    expect(result).toEqual({ continue: true });

    const notes = failureNotes(events);
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note).toBeDefined();
    if (note === undefined) return;
    expect(note.text.startsWith(EXPECTED_NOTE_PREFIX)).toBe(true);
    expect(note.text).toContain('Bash');
    expect(note.text).toContain('manager:mgr-1');
    expect(note.text).toContain('command failed with exit code 1');
    expect(() => runnerEventSchema.parse(note)).not.toThrow();

    // **歯2: tool_use は1件も出ない**（成功の形で送らない）。
    expect(toolUseEvents(events)).toHaveLength(0);
  });

  it('作業者からの失敗は note の actor に worker: を名乗る', async () => {
    const { started, events } = await startSession();

    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_use_id: 'tu-2',
      agent_id: 'agent-xyz',
      agent_type: 'worker',
      error: 'ENOENT',
    });

    const notes = failureNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('worker:mgr-1:worker');
    expect(notes[0]?.text).toContain('Read');
    expect(notes[0]?.text).toContain('ENOENT');

    expect(toolUseEvents(events)).toHaveLength(0);
  });

  it('（対照）同じセッションで成功した道具呼び出しは、従来どおり tool_use として残る', async () => {
    const { started, events } = await startSession();

    await firePostToolUse(started.options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
      tool_response: { stdout: 'ok' },
    });

    expect(toolUseEvents(events)).toHaveLength(1);
    expect(failureNotes(events)).toHaveLength(0);
  });
});

describe('歯3: error の500文字での切り詰めと、欠落・非文字列の扱い', () => {
  it('500文字を超える error は切り詰められ、切ったと分かる印が末尾に付く', async () => {
    const { started, events } = await startSession();
    const longError = 'E'.repeat(600);

    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-3',
      error: longError,
    });

    const notes = failureNotes(events);
    expect(notes).toHaveLength(1);
    const text = notes[0]?.text ?? '';
    // 全文（600文字ぶんの E）はそのまま載っていない。
    expect(text).not.toContain(longError);
    // 切り詰めた先頭部分（500文字ぶん）は載っている。
    expect(text).toContain('E'.repeat(500));
    // 「切った」と分かる印（`excerpt.ts` の書式）が付く。
    expect(text).toContain('文字省略');
    expect(text).toContain('全 600 文字');
  });

  it('500文字ちょうど・未満の error は切り詰められない', async () => {
    const { started, events } = await startSession();
    const shortError = 'short failure message';

    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-4',
      error: shortError,
    });

    const text = failureNotes(events)[0]?.text ?? '';
    expect(text).toContain(shortError);
    expect(text).not.toContain('文字省略');
  });

  it('error が欠けている場合も落ちずに (不明) で出す', async () => {
    const { started, events } = await startSession();

    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-5',
      // error を渡さない。
    });

    const notes = failureNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('(不明)');
  });

  it('error が文字列でない場合も落ちずに (不明) で出す', async () => {
    const { started, events } = await startSession();

    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-6',
      error: 12345,
    });

    const notes = failureNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('(不明)');
  });
});

describe('歯5: 所有者の控えを作らない（材料が無い。#929 の測定）', () => {
  it('backgroundTaskId 風の値を tool_response に混ぜても、所有者の控えは増えない（SubagentStop が起こし直さない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    // **実際の `PostToolUseFailureHookInput` には無い欄だが、念のため混ぜる**
    // （実装が誤って `hook.tool_response` を読んでいないかを確かめるため）。
    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'tu-7',
      agent_id: 'agent-1',
      agent_type: 'worker',
      error: 'timed out',
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-1' },
    });

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

    // **控えが無い ⟹ `mine.length === 0` ⟹ 起こし直さない**（`additionalContext`
    // を返さない、厳密に `{ continue: true }`）——Issue #929 の測定コメントの
    // 「本番（控え ❌）」と同じ形。
    expect(result).toEqual({ continue: true });
  });

  it('（対照）成功した PostToolUse（Bash）なら同じ形で起こし直す — 控えの仕組み自体は生きている', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    await firePostToolUse(started.options, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 90', run_in_background: true },
      tool_response: { stdout: '', stderr: '', backgroundTaskId: 'bg-2' },
      agent_id: 'agent-2',
      agent_type: 'worker',
    });

    const result = await fireSubagentStop(started.options, {
      ...STOP_BASE,
      agent_id: 'agent-2',
      background_tasks: [
        selfEntry('agent-2'),
        {
          id: 'bg-2',
          type: 'shell',
          status: 'running',
          description: 'pnpm verify を実行中',
          command: 'pnpm verify',
        },
      ],
    });

    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop' },
    });
  });
});
