import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

interface Started {
  options: Options;
  finish: () => void;
  /** 保留中の `emit` が無ければバッファへ積む: 素の resolve だけでは、押した直後に読まれる保証が無く取りこぼす。 */
  push: (message: SDKMessage) => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
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
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
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

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

async function firePostToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

async function firePostToolUseFailure(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const PRE_TOOL_USE_BASE = { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1' };

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
type PermissionDeniedEvent = Extract<RunnerEvent, { type: 'permission_denied' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function waitGuardNotes(events: readonly RunnerEvent[]): NoteEvent[] {
  return noteEvents(events).filter((note) => note.text.includes('Bash の呼び出しを弾いた'));
}

function permissionDeniedEvents(events: readonly RunnerEvent[]): PermissionDeniedEvent[] {
  return events.filter(
    (event): event is PermissionDeniedEvent => event.type === 'permission_denied',
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 実機の SDK が送ってくる形（`tool_input` を持たない）で作る。 */
function liveDenialAsSdkSends(tool: string, toolUseId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    tool_name: tool,
    tool_use_id: toolUseId,
    session_id: 'sess-mgr',
    uuid: `uuid-denied-${toolUseId}`,
  } as unknown as SDKMessage;
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-pre-tool-use-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function outboxRoots(): { outboxRoot: string; outboxStagedRoot: string } {
  return { outboxRoot: join(dir, 'outbox'), outboxStagedRoot: join(dir, 'outbox-staged') };
}

function setup(): { host: RunnerHost; events: RunnerEvent[]; started: Started[] } {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: DENY_ENV,
    // 既定の根（os.tmpdir() 配下の共有の名前）に触らない: runner の器では root 所有で作れず、余計な note が出るため
    ...outboxRoots(),
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

    const asRecord = result as { continue?: boolean; hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.continue).toBe(true);
    const output = asRecord.hookSpecificOutput;
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
    ['timeout でラップされている', "timeout 60 bash -c 'until true; do sleep 1; done'"],
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

describe('run_in_background を判定器へ渡す', () => {
  it('背景の gh run watch を deny し、note に形を書く', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: {
        command: 'gh run watch 35196482974 --repo takecchi/alteroid --exit-status 2>&1 | tail -60',
        run_in_background: true,
      },
    });

    const asRecord = result as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(asRecord.hookSpecificOutput?.permissionDecisionReason)).toContain('check-runs');

    const notes = waitGuardNotes(events);
    expect(notes.length).toBe(1);
    expect(notes[0]?.text).toContain('形=gh-run-watch-background');
    expect(notes[0]?.escalate).toBeUndefined();
  });

  it('同じコマンドでも run_in_background が無ければ通す', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: {
        command: 'gh run watch 35196482974 --repo takecchi/alteroid --exit-status 2>&1 | tail -60',
      },
    });
    expect(result).toEqual({ continue: true });
    expect(waitGuardNotes(events).length).toBe(0);
  });

  it('run_in_background が真偽値でなければ前景として扱う', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'gh run watch 123 --exit-status', run_in_background: 'yes' },
    });
    expect(result).toEqual({ continue: true });
    expect(waitGuardNotes(events).length).toBe(0);
  });

  it('背景でも、普通のコマンドは通す', async () => {
    const { started, events } = await startSession();
    for (const command of [
      'git status',
      'pnpm -v',
      'gh pr list --state all --limit 1000',
      'pnpm test --maxWorkers=4 > /tmp/test.log 2>&1',
      'echo "検証が緑になりました"',
    ]) {
      const result = await firePreToolUse(started.options, {
        ...PRE_TOOL_USE_BASE,
        tool_name: 'Bash',
        tool_input: { command, run_in_background: true },
      });
      expect(result).toEqual({ continue: true });
    }
    expect(waitGuardNotes(events).length).toBe(0);
  });
});

describe('inputHead — PreToolUse が見た入力を拒否の合図へ運ぶ（issue #1105）', () => {
  it('Bash 以外（Edit）でも、拒否より前に見た入力が inputHead に乗る', async () => {
    const { started, events } = await startSession();

    await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tu-edit-1',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'apps/web/app/routes/chat.test.tsx',
        old_string: 'x',
        new_string: 'y',
      },
    });

    started.push(liveDenialAsSdkSends('Edit', 'tu-edit-1'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.inputHead).toBe(
      '{"file_path":"apps/web/app/routes/chat.test.tsx","old_string":"x","new_string":"y"}',
    );
    expect(denials[0]?.input).toBeUndefined();
    expect(() => runnerEventSchema.parse(denials[0])).not.toThrow();
  });

  it('伏せ字済みで乗る（ダミーの GitHub トークン）', async () => {
    const { started, events } = await startSession();
    const dummyToken = `ghp_${'1234567890abcdef1234567890abcdef1234'}`; // ダミー。本物ではない。

    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: {
        command: `curl -H "Authorization: token ${dummyToken}" https://api.github.com`,
      },
    });

    started.push(liveDenialAsSdkSends('Bash', 'tu-1'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.inputHead).not.toContain(dummyToken);
    expect(denials[0]?.inputHead).toContain('[REDACTED]');
  });

  it('160字を超える入力は切られる（末尾に … が付く）', async () => {
    const { started, events } = await startSession();
    const longCommand = `echo ${'x'.repeat(300)}`;

    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: longCommand },
    });

    started.push(liveDenialAsSdkSends('Bash', 'tu-1'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    const head = denials[0]?.inputHead;
    expect(head).toBeDefined();
    expect(head).toBe(`${longCommand.slice(0, 160)}…`);
  });

  it('成功した呼びの分は帳面から消える（PostToolUse の後の拒否には inputHead が乗らない）', async () => {
    const { started, events } = await startSession();

    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    await firePostToolUse(started.options, {
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tu-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { output: 'hi' },
    });

    started.push(liveDenialAsSdkSends('Bash', 'tu-1'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.inputHead).toBeUndefined();
  });

  it('失敗（PostToolUseFailure）で決着した分も帳面から消える', async () => {
    const { started, events } = await startSession();

    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    await firePostToolUseFailure(started.options, {
      hook_event_name: 'PostToolUseFailure',
      tool_use_id: 'tu-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      error: '中断された',
    });

    started.push(liveDenialAsSdkSends('Bash', 'tu-1'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.inputHead).toBeUndefined();
  });

  it('PreToolUse を経由しなかった回（toolUseId が取れない）は inputHead を作り物で埋めない', async () => {
    const { started, events } = await startSession();

    started.push(liveDenialAsSdkSends('Bash', 'tu-never-seen'));
    await tick();

    const denials = permissionDeniedEvents(events);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.inputHead).toBeUndefined();
  });
});

describe('ガードの deny は、判定の周りの例外で消えない（issue #1960）', () => {
  function setupWithThrowingNoteEmit(): { host: RunnerHost; started: Started[] } {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => {
        if (event.type === 'note') throw new Error('emit が落ちた（テスト用）');
      },
      queryFn: fn,
      env: DENY_ENV,
      ...outboxRoots(),
    });
    return { host, started };
  }

  it('弾く形の Bash は、note の送り出しが投げても deny を返す', async () => {
    const s = setupWithThrowingNoteEmit();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'tail -f /tmp/run.log' },
    });

    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('対照: 弾かない形の Bash は、note の送り出しが投げる設定でも今までどおり通す', async () => {
    const s = setupWithThrowingNoteEmit();
    await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const started = s.started[0];
    if (started === undefined) throw new Error('セッションが開いていない');

    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });

    expect(result).toEqual({ continue: true });
  });
});

describe('Bash のツールの timeout 引数を引き上げる（#2088）', () => {
  function timeoutNotes(events: readonly RunnerEvent[]): NoteEvent[] {
    return noteEvents(events).filter((note) => note.text.includes('形=bash-tool-timeout-raised'));
  }

  it('引数が未指定で、コマンドの中の timeout が既定を超えるなら、入力の timeout だけを引き上げる', async () => {
    const { started, events } = await startSession();
    const toolInput = { command: 'timeout 300 pnpm test', description: 'テストを回す' };
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: toolInput,
    });
    expect(result).toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          command: 'timeout 300 pnpm test',
          description: 'テストを回す',
          timeout: 310_000,
        },
      },
    });
    const output = (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(output).not.toHaveProperty('permissionDecision');
    expect(String(output?.additionalContext)).toContain('310000ms');
    expect(toolInput).toEqual({ command: 'timeout 300 pnpm test', description: 'テストを回す' });

    const notes = timeoutNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('manager:mgr-1');
    expect(notes[0]?.text).toContain('未指定→310000ms');
  });

  it('作業者の呼び出しは note の actor に worker: を名乗る', async () => {
    const { started, events } = await startSession();
    await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'timeout 300 pnpm test', timeout: 120_000 },
      agent_id: 'agent-1',
      agent_type: 'worker',
    });
    const notes = timeoutNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('worker:');
    expect(notes[0]?.text).toContain('120000ms→310000ms');
  });

  it('引数が既に十分なら何もしない', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'timeout 300 pnpm test', timeout: 600_000 },
    });
    expect(result).toEqual({ continue: true });
    expect(timeoutNotes(events)).toHaveLength(0);
  });

  it('run_in_background の呼び出しには触らない', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'timeout 300 pnpm test', run_in_background: true },
    });
    expect(result).toEqual({ continue: true });
    expect(timeoutNotes(events)).toHaveLength(0);
  });

  it('ガードが弾く呼び出しは弾くだけで、書き換えない', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Bash',
      tool_input: { command: 'tail -f /tmp/x; timeout 300 sleep 1' },
    });
    const output = (result as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(output?.permissionDecision).toBe('deny');
    expect(output).not.toHaveProperty('updatedInput');
    expect(timeoutNotes(events)).toHaveLength(0);
  });

  it('Bash 以外には触らない', async () => {
    const { started, events } = await startSession();
    const result = await firePreToolUse(started.options, {
      ...PRE_TOOL_USE_BASE,
      tool_name: 'Read',
      tool_input: { file_path: '/x', command: 'timeout 300 x' },
    });
    expect(result).toEqual({ continue: true });
    expect(timeoutNotes(events)).toHaveLength(0);
  });
});
