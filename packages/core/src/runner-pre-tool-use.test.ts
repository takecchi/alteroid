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
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

/**
 * `PreToolUse` の配線（#894 段1・案(A)）を確かめる。
 *
 * **`runner-stop.test.ts` と同じ足場・同じ作法である**（`fakeRunnerSdk` /
 * `setup` / `startSession`）。あちらが「Stop は何も判断せず、何も抑制しない」
 * ことを固定していたのに対し、こちらは向きが逆 —— **`PreToolUse` だけは
 * 実際にブロックすること**を固定する。
 *
 * **固定するのは3つである。**
 *
 * 1. **配線そのもの。** マネージャーの `Options` に `PreToolUse` フックが
 *    1本だけ載っていて、既存の6本（`PostToolUse` / `PreCompact` /
 *    `UserPromptSubmit` / `SubagentStop` / `Stop`。`canUseTool` はフックでは
 *    ないので数えない）を落としていないこと。
 * 2. **`Bash` 以外は素通しすること。** 判定器（`bash-wait-guard.ts`）は
 *    `Bash` の `command` しか読めないので、他のツールを弾く経路が無いことを
 *    検算する。
 * 3. **弾いたときの戻り値と note。** `hookSpecificOutput.permissionDecision`
 *    が `'deny'` で、理由に代替が含まれること。日誌には `escalate` を立てない
 *    `note` が1本出ること。
 *
 * ## ⚠️ この歯の弱さ（`runner-stop.test.ts` と同じ断り）
 *
 * 下のフィクスチャは手書きのオブジェクトリテラルであり、実物の SDK フック
 * JSON を読み込んでいない。`bash-wait-guard.ts` 自体の判定ロジックの網羅性は
 * `bash-wait-guard.test.ts` が持つ —— ここで固定するのは「配線」だけである。
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

/** `options.hooks.PreToolUse[0].hooks[0]` を直接叩く。 */
async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const PRE_TOOL_USE_BASE = { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1' };

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function waitGuardNotes(events: readonly RunnerEvent[]): NoteEvent[] {
  return noteEvents(events).filter((note) => note.text.includes('Bash の呼び出しを弾いた'));
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-pre-tool-use-'));
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

describe('PreToolUse の配線（#894 段1・案(A)）', () => {
  it('マネージャーの Options に PreToolUse フックが1本だけ載っている', async () => {
    const { started } = await startSession();
    expect(started.options.hooks?.PreToolUse?.length).toBe(1);
    expect(started.options.hooks?.PreToolUse?.[0]?.hooks?.length).toBe(1);
  });

  // **配線した6本を落としていないことの検算**（この PR は足すだけで、既存の
  // 観測を1つも外していない。`runner-stop.test.ts` の同名の歯と対になる）。
  it('既存の5本（PostToolUse / PreCompact / UserPromptSubmit / SubagentStop / Stop）はそのまま載っている', async () => {
    const { started } = await startSession();
    const hooks = started.options.hooks;
    expect(hooks?.PostToolUse?.length).toBe(1);
    expect(hooks?.PreCompact?.length).toBe(1);
    expect(hooks?.UserPromptSubmit?.length).toBe(1);
    expect(hooks?.SubagentStop?.length).toBe(1);
    expect(hooks?.Stop?.length).toBe(1);
  });
});

describe('Bash 以外は素通しする', () => {
  it('tool_name が Bash でなければ、command が待つだけの形でも通す', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    });
    expect(result).toEqual({ continue: true });
    expect(waitGuardNotes(events).length).toBe(0);
  });

  it('tool_input.command が文字列でなければ通す（形が崩れた入力を安全側に倒す）', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 123 },
    });
    expect(result).toEqual({ continue: true });
    expect(waitGuardNotes(events).length).toBe(0);
  });
});

describe('Bash の待つだけのループを弾く', () => {
  it('until+sleep を deny し、理由に代替を含める', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: {
        command:
          'until grep -q "^run: まとめ$" /tmp/mutation-run-865.log 2>/dev/null; do sleep 5; done',
      },
    });

    expect(result.continue).toBe(true);
    const output = (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(output?.hookEventName).toBe('PreToolUse');
    expect(output?.permissionDecision).toBe('deny');
    expect(String(output?.permissionDecisionReason)).toContain('gh run watch');

    const notes = waitGuardNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.escalate).toBeUndefined();
    expect(() => runnerEventSchema.parse(notes[0])).not.toThrow();
  });

  it('マネージャー自身の呼び出しは note の actor に manager: を名乗る', async () => {
    const { started, events } = await startSession();
    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'tail -f /tmp/run.log' },
    });

    const text = waitGuardNotes(events)[0]?.text ?? '';
    expect(text).toContain('manager:mgr-1');
    expect(text).toContain('形=tail-f');
  });

  it('作業者からの呼び出しは note の actor に worker: を名乗る', async () => {
    const { started, events } = await startSession();
    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      agent_id: 'agent-xyz',
      agent_type: 'worker',
      tool_input: { command: 'while ! test -f done.txt; do sleep 10; done' },
    });

    const text = waitGuardNotes(events)[0]?.text ?? '';
    expect(text).toContain('worker:mgr-1:worker');
    expect(text).toContain('形=while-sleep');
  });
});

describe('Bash の有界な形は通す', () => {
  const passingCommands = [
    ['timeout でラップされている', 'timeout 60 bash -c \'until true; do sleep 1; done\''],
    ['for ループ', 'for i in $(seq 1 5); do echo $i; sleep 1; done'],
    ['while read', 'while read -r line; do sleep 1; echo "$line"; done < /tmp/q.txt'],
    ['カウンタ比較', 'i=0; while [ "$i" -lt 5 ]; do sleep 1; i=$((i + 1)); done'],
    ['break が在る', 'while true; do sleep 1; if [ -f /tmp/ok ]; then break; fi; done'],
    ['ループが無い', 'gh run watch 123 --exit-status'],
    ['単独の sleep', 'sleep 3; echo done'],
  ] as const;

  for (const [label, command] of passingCommands) {
    it(`${label}: deny せず通す`, async () => {
      const { started, events } = await startSession();
      const result = await firePreToolUse(started.options, {
        ...PRE_TOOL_USE_BASE,
        tool_name: 'Bash',
        tool_input: { command },
      });
      expect(result).toEqual({ continue: true });
      expect(waitGuardNotes(events).length).toBe(0);
    });
  }
});
