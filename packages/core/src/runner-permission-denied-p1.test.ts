import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

interface Started {
  options: Options;
  finish: () => void;
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

async function firePermissionDenied(
  options: Options,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PermissionDenied フックが登録されていない');
  return hook(input as never, undefined, { signal });
}

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

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

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
type AskEvent = Extract<RunnerEvent, { type: 'ask' }>;

function noteEvents(events: readonly RunnerEvent[]): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.type === 'note');
}

function askEvents(events: readonly RunnerEvent[]): AskEvent[] {
  return events.filter((event): event is AskEvent => event.type === 'ask');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-permission-denied-p1-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function setup(env: NodeJS.ProcessEnv = DENY_ENV): {
  host: RunnerHost;
  events: RunnerEvent[];
  started: Started[];
} {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env,
  });
  return { host, events, started };
}

async function startSession(env: NodeJS.ProcessEnv = DENY_ENV): Promise<{
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
}> {
  const s = setup(env);
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const started = s.started[0];
  if (started === undefined) throw new Error('セッションが開いていない');
  return { started, events: s.events, host: s.host };
}

describe('PermissionDenied の配線（issue #1105 P1）', () => {
  it('マネージャーの Options に PermissionDenied フックが1本だけ載っている', async () => {
    const { started } = await startSession();
    expect(started.options.hooks?.PermissionDenied?.length).toBe(1);
    expect(started.options.hooks?.PermissionDenied?.[0]?.hooks?.length).toBe(1);
  });

  it('既存の7本（PreToolUse / PostToolUse / PostToolUseFailure / PreCompact / UserPromptSubmit / SubagentStop / Stop）はそのまま載っている', async () => {
    const { started } = await startSession();
    const hooks = started.options.hooks;
    expect(hooks?.PreToolUse?.length).toBe(1);
    expect(hooks?.PostToolUse?.length).toBe(1);
    expect(hooks?.PostToolUseFailure?.length).toBe(1);
    expect(hooks?.PreCompact?.length).toBe(1);
    expect(hooks?.UserPromptSubmit?.length).toBe(1);
    expect(hooks?.SubagentStop?.length).toBe(1);
    expect(hooks?.Stop?.length).toBe(1);
  });
});

describe('allow の一往復（issue #1105 P1）', () => {
  it('クローンが allow と答えると retry: true が返り、撃ち直しの PreToolUse を1回だけ通す', async () => {
    const { started, events, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo one-shot-allow-probe' },
      tool_use_id: 'tu-allow-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    const asks = askEvents(events);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.requestId).toBe('tu-allow-1');
    expect(asks[0]?.kind).toBe('permission');
    expect(asks[0]?.summary).toContain('Bash');
    expect(asks[0]?.summary).toContain('echo one-shot-allow-probe');
    expect(asks[0]?.summary).toContain('分類器が拒否した（テスト）');
    expect(() => runnerEventSchema.parse(asks[0])).not.toThrow();

    const answered = await h.answer('mgr-1', {
      requestId: 'tu-allow-1',
      decision: 'allow',
      message: 'この形なら大丈夫。1回だけ通してよい。',
    });
    expect(answered.delivered).toBe(true);

    const decision = await denialPromise;
    expect(decision).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
    });

    const allowNote = noteEvents(events).find((n) => n.text.includes('1回だけ許可した'));
    expect(allowNote?.text).toContain('担い手のモデルが決める');
    expect(allowNote?.text).toContain('manager_send');
    expect(allowNote?.text).not.toContain('撃ち直せば通る');
    expect(asks[0]?.summary).toContain('撃ち直すかは担い手が決める');

    const retryResult = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo one-shot-allow-probe' },
      tool_use_id: 'tu-allow-1-retry',
    });
    const asRecord = retryResult as {
      continue?: boolean;
      hookSpecificOutput?: Record<string, unknown>;
    };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');

    const secondAttempt = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo one-shot-allow-probe' },
      tool_use_id: 'tu-allow-1-retry-2',
    });
    expect(secondAttempt).toEqual({ continue: true });
  });

  // 書き出しの「分類器が 」は manager.ts の `CLASSIFIER_DENIAL_ASK_HEAD` が見分けに使う: 変わると、この確認にも「allow すればそのまま通る」が付いて食い違う。
  it('確認の本文は、答えたあと自動では撃ち直されないことと、撃ち直させる伝え方を言い切る（#4447）', async () => {
    const { started, events } = await startSession();

    void firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'git rm docs/old.md' },
      tool_use_id: 'tu-wording-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    const summary = askEvents(events)[0]?.summary ?? '';
    expect(summary.startsWith('分類器が ')).toBe(true);
    expect(summary).toContain('答えたあと: allow しても、この呼び出しは自動では撃ち直されない。');
    expect(summary).toContain('10分以内に1回だけ通す');
    expect(summary).toContain(
      'allow の後に manager_send で decision を付けない追加指示として「同じ入力で撃ち直してよい」と伝える。',
    );
    expect(summary).toContain('この許可で通るかは確かめていない。');
  });

  it('入力が1文字違えば通さない', async () => {
    const { started, events, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo digest-exact-match' },
      tool_use_id: 'tu-digest-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', {
      requestId: 'tu-digest-1',
      decision: 'allow',
      message: 'どうぞ',
    });
    await denialPromise;

    const mismatched = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo digest-exact-match!' },
      tool_use_id: 'tu-digest-1-retry',
    });
    expect(mismatched).toEqual({ continue: true });

    const exact = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo digest-exact-match' },
      tool_use_id: 'tu-digest-1-retry-2',
    });
    const asRecord = exact as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');

    expect(noteEvents(events).some((n) => n.text.includes('上書きした'))).toBe(true);
  });

  it('別の担い手（作業者）なら通さない', async () => {
    const { started, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo actor-scoped-probe' },
      tool_use_id: 'tu-actor-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', { requestId: 'tu-actor-1', decision: 'allow', message: 'どうぞ' });
    await denialPromise;

    const fromWorker = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo actor-scoped-probe' },
      tool_use_id: 'tu-actor-1-retry',
      agent_id: 'agent-xyz',
      agent_type: 'worker',
    });
    expect(fromWorker).toEqual({ continue: true });

    const fromManager = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo actor-scoped-probe' },
      tool_use_id: 'tu-actor-1-retry-2',
    });
    const asRecord = fromManager as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});

describe('同じ型の別の作業者には許可を使わせない（issue #1105 P1）', () => {
  it('agent_type が同じでも agent_id が違えば通さず、許可を受けた作業者自身なら通す', async () => {
    const { started, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo same-type-probe' },
      tool_use_id: 'tu-same-type-1',
      reason: '分類器が拒否した（テスト）',
      agent_id: 'agent-a',
      agent_type: 'worker',
    });
    await tick();
    await h.answer('mgr-1', { requestId: 'tu-same-type-1', decision: 'allow', message: 'どうぞ' });
    await denialPromise;

    const fromOther = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo same-type-probe' },
      tool_use_id: 'tu-same-type-1-other',
      agent_id: 'agent-b',
      agent_type: 'worker',
    });
    expect(fromOther).toEqual({ continue: true });

    const fromSelf = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo same-type-probe' },
      tool_use_id: 'tu-same-type-1-self',
      agent_id: 'agent-a',
      agent_type: 'worker',
    });
    const asRecord = fromSelf as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});

describe('deny では retry を返さない（issue #1105 P1）', () => {
  it('クローンが deny と答えると no-retry になり、一言を note として降ろす', async () => {
    const { started, events, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /some/path' },
      tool_use_id: 'tu-deny-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', {
      requestId: 'tu-deny-1',
      decision: 'deny',
      message: 'それは駄目。別の形にして。',
    });

    const decision = await denialPromise;
    expect(decision).toEqual({ continue: true });

    const notes = noteEvents(events);
    expect(notes.some((n) => n.text.includes('それは駄目。別の形にして。'))).toBe(true);

    const retry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /some/path' },
      tool_use_id: 'tu-deny-1-retry',
    });
    expect(retry).toEqual({ continue: true });
  });
});

describe('フックの持ち時間切れは安全側（issue #1105 本文の設計判断5）', () => {
  it('時間切れでは retry を返さず、遅れて届いた allow は構造的に捨てられる', async () => {
    const { started, events, host: h } = await startSession();
    const controller = new AbortController();

    const denialPromise = firePermissionDenied(
      started.options,
      {
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'echo timeout-probe' },
        tool_use_id: 'tu-timeout-1',
        reason: '分類器が拒否した（テスト）',
      },
      controller.signal,
    );
    await tick();

    controller.abort();
    const decision = await denialPromise;
    expect(decision).toEqual({ continue: true });

    expect(noteEvents(events).some((n) => n.text.includes('フックの持ち時間切れ'))).toBe(true);

    const lateAnswer = await h.answer('mgr-1', {
      requestId: 'tu-timeout-1',
      decision: 'allow',
      message: '遅れてごめん、やっぱり許可する。',
    });
    expect(lateAnswer.delivered).toBe(false);

    const retry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo timeout-probe' },
      tool_use_id: 'tu-timeout-1-retry',
    });
    expect(retry).toEqual({ continue: true });
  });
});

describe('畳んで解いた確認は取り下げとして残し、クローンの判断として書かない（issue #2448）', () => {
  it('ask の後に stop() すると settled に withdrawn が載り、「許可を出さなかった」の note は出ない', async () => {
    const { started, events, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo withdrawn-probe' },
      tool_use_id: 'tu-withdrawn-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    expect(askEvents(events).some((e) => e.requestId === 'tu-withdrawn-1')).toBe(true);

    await h.stop('mgr-1');
    const decision = await denialPromise;
    expect(decision).toEqual({ continue: true });

    const settled = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'settled' }> =>
        event.type === 'settled' && event.requestId === 'tu-withdrawn-1',
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.withdrawn?.reason).toBe('デーモンから停止を指示された。');
    expect(runnerEventSchema.parse(settled[0])).toMatchObject({
      withdrawn: { reason: 'デーモンから停止を指示された。' },
    });

    const notes = noteEvents(events);
    expect(notes.some((n) => n.text.includes('への1回だけの許可を出さなかった'))).toBe(false);
    expect(notes.some((n) => n.text.includes('デーモンから停止を指示された。'))).toBe(false);
  });
});

describe('bash-wait-guard の deny が1回だけの許可より先に効く（issue #1105 P1。`ALTEROID_BASH_GUARD=deny` の設定）', () => {
  it('無限に待つだけの Bash は、1回だけの許可が出ていても弾く', async () => {
    const { started, events, host: h } = await startSession();
    const waitingCommand =
      'until grep -q "^run: まとめ$" /tmp/mutation-run-1105.log 2>/dev/null; do sleep 5; done';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: waitingCommand },
      tool_use_id: 'tu-guard-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', {
      requestId: 'tu-guard-1',
      decision: 'allow',
      message: 'どうぞ（テスト用。本来は許可すべきではない形）',
    });
    await denialPromise;

    const retry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: waitingCommand },
      tool_use_id: 'tu-guard-1-retry',
    });
    const asRecord = retry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(asRecord.hookSpecificOutput?.permissionDecisionReason)).toContain('gh run watch');

    expect(noteEvents(events).some((n) => n.text.includes('上書きした'))).toBe(false);
  });
});

describe('bash-wait-guard の確認（ask、既定）は、クローンの1回だけの許可が開ける（issue #2884）', () => {
  it('1回だけの許可が出ていれば、同じ入力の撃ち直しは確認に上げず allow で通す。許可は1回で使い切る', async () => {
    const { started, host: h } = await startSession({});
    const waitingCommand = 'tail -f /tmp/run-2884.log';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: waitingCommand },
      tool_use_id: 'tu-ask-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', { requestId: 'tu-ask-1', decision: 'allow', message: '見張ってよい' });
    await denialPromise;

    const fire = () =>
      firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: waitingCommand },
        tool_use_id: 'tu-ask-1-retry',
      }) as Promise<{ hookSpecificOutput?: Record<string, unknown> }>;

    expect((await fire()).hookSpecificOutput?.permissionDecision).toBe('allow');
    expect((await fire()).hookSpecificOutput?.permissionDecision).toBe('ask');
  });
});

describe('1回だけの許可には寿命が付く（issue #1105 本文の設計判断3）', () => {
  it('寿命（10分）を過ぎていたら allow を返さない', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const denialPromise = firePermissionDenied(started.options, {
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-probe' },
        tool_use_id: 'tu-ttl-1',
        reason: '分類器が拒否した（テスト）',
      });
      await tick();
      await h.answer('mgr-1', { requestId: 'tu-ttl-1', decision: 'allow', message: 'どうぞ' });
      await denialPromise;

      nowSpy.mockReturnValue(now + 10 * 60 * 1000 + 1);

      const retry = await firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-probe' },
        tool_use_id: 'tu-ttl-1-retry',
      });
      expect(retry).toEqual({ continue: true });
      expect(noteEvents(events).some((n) => n.text.includes('期限切れ'))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('寿命の範囲内なら allow を返す（対照・1ms 手前）', async () => {
    const { started, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const denialPromise = firePermissionDenied(started.options, {
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-ok-probe' },
        tool_use_id: 'tu-ttl-2',
        reason: '分類器が拒否した（テスト）',
      });
      await tick();
      await h.answer('mgr-1', { requestId: 'tu-ttl-2', decision: 'allow', message: 'どうぞ' });
      await denialPromise;

      nowSpy.mockReturnValue(now + 10 * 60 * 1000 - 1);

      const retry = await firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-ok-probe' },
        tool_use_id: 'tu-ttl-2-retry',
      });
      const asRecord = retry as { hookSpecificOutput?: Record<string, unknown> };
      expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('寿命ちょうど（境界の1点）では allow を返さない', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const denialPromise = firePermissionDenied(started.options, {
        hook_event_name: 'PermissionDenied',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-exact-probe' },
        tool_use_id: 'tu-ttl-3',
        reason: '分類器が拒否した（テスト）',
      });
      await tick();
      await h.answer('mgr-1', { requestId: 'tu-ttl-3', decision: 'allow', message: 'どうぞ' });
      await denialPromise;

      nowSpy.mockReturnValue(now + 10 * 60 * 1000);

      const retry = await firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo ttl-exact-probe' },
        tool_use_id: 'tu-ttl-3-retry',
      });
      expect(retry).toEqual({ continue: true });
      expect(noteEvents(events).some((n) => n.text.includes('期限切れ'))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('#1603 と同じ形の検出——allow を返した呼び出しがそれでも拒否された（issue #1105 P1）', () => {
  it('1回だけの許可で allow を返した直後の呼び出しが、それでも拒否されたら note に残す', async () => {
    const { started, events, host: h } = await startSession();

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command: 'echo funneled-probe' },
      tool_use_id: 'tu-funneled-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', { requestId: 'tu-funneled-1', decision: 'allow', message: 'どうぞ' });
    await denialPromise;

    const retry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo funneled-probe' },
      tool_use_id: 'tu-funneled-1',
    });
    const asRecord = retry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');

    started.push(liveDenialAsSdkSends('Bash', 'tu-funneled-1'));
    await tick();

    const notes = noteEvents(events);
    expect(
      notes.some((n) => n.text.includes('allow を') && n.text.includes('それでも拒否された')),
    ).toBe(true);
  });
});

describe('撃ち直されないまま期限切れになった1回だけの許可は note に残る（#2352 の点3）', () => {
  const TTL = 10 * 60 * 1000;
  const UNUSED = '撃ち直されないまま';

  async function grantOnce(
    started: Started,
    h: RunnerHost,
    command: string,
    toolUseId: string,
  ): Promise<void> {
    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: toolUseId,
      reason: '分類器が拒否した（テスト）',
    });
    await tick();
    await h.answer('mgr-1', { requestId: toolUseId, decision: 'allow', message: 'どうぞ' });
    await denialPromise;
  }

  const unrelatedPreToolUse = (started: Started, id: string) =>
    firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: `echo unrelated-${id}` },
      tool_use_id: id,
    });

  it('撃ち直しが来て consume されたときは、期限が過ぎても出ない', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await grantOnce(started, h, 'echo unused-a', 'tu-unused-a');
      const retry = await firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo unused-a' },
        tool_use_id: 'tu-unused-a-retry',
      });
      const asRecord = retry as { hookSpecificOutput?: Record<string, unknown> };
      expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');

      nowSpy.mockReturnValue(now + TTL + 1);
      await unrelatedPreToolUse(started, 'tu-other-a');
      expect(noteEvents(events).some((n) => n.text.includes(UNUSED))).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('撃ち直しが来ないまま TTL を過ぎたら、次の道具呼び出しで1回だけ出る', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await grantOnce(started, h, 'echo unused-b', 'tu-unused-b');

      nowSpy.mockReturnValue(now + TTL - 1);
      await unrelatedPreToolUse(started, 'tu-other-b0');
      expect(noteEvents(events).some((n) => n.text.includes(UNUSED))).toBe(false);

      nowSpy.mockReturnValue(now + TTL);
      const other = await unrelatedPreToolUse(started, 'tu-other-b1');
      expect(other).toEqual({ continue: true });
      await unrelatedPreToolUse(started, 'tu-other-b2');

      const unused = noteEvents(events).filter((n) => n.text.includes(UNUSED));
      expect(unused).toHaveLength(1);
      expect(unused[0]?.text).toContain('manager:mgr-1・Bash');
      expect(unused[0]?.text).toContain('担い手のモデルが決める');
      expect(unused[0]?.text).toContain('確かめていない');
      expect(unused[0]?.text).not.toContain('unused-b');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('同じ入力の撃ち直しが期限後に来たときは、従来の「期限切れだった」だけで、未使用の note は重ねない', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await grantOnce(started, h, 'echo unused-c', 'tu-unused-c');
      nowSpy.mockReturnValue(now + TTL + 1);
      const retry = await firePreToolUse(started.options, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo unused-c' },
        tool_use_id: 'tu-unused-c-retry',
      });
      expect(retry).toEqual({ continue: true });
      const notes = noteEvents(events);
      expect(notes.filter((n) => n.text.includes('期限切れだったので使わなかった'))).toHaveLength(
        1,
      );
      expect(notes.some((n) => n.text.includes(UNUSED))).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('次の拒否の入口でも出る', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await grantOnce(started, h, 'echo unused-d', 'tu-unused-d');
      nowSpy.mockReturnValue(now + TTL + 1);
      await grantOnce(started, h, 'echo unused-d2', 'tu-unused-d2');
      expect(noteEvents(events).filter((n) => n.text.includes(UNUSED))).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
