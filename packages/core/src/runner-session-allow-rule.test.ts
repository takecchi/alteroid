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
import {
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH,
  DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE,
} from './classifier-denial-streak.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// クローンが分類器の拒否に allow した Bash 呼び出しを、同じ入力の1回だけ通す一時規則としてセッションに足す（#4905）

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };
const TTL = 10 * 60 * 1000;

interface Started {
  options: Options;
  finish: () => void;
  push: (message: SDKMessage) => void;
  /** `applyFlagSettings` に渡った `permissions.allow` の並び（呼ばれた順）。 */
  flagAllows: string[][];
}

interface FakeOptions {
  /** false なら Query に `applyFlagSettings` を生やさない（口を持たないセッション）。 */
  withApplyFlagSettings?: boolean;
  /** 渡すと、その回の `applyFlagSettings` を失敗させる（0 始まりの回数）。 */
  failApplyAt?: ReadonlySet<number>;
  /** 渡すと、その回の `applyFlagSettings` を答えないままにする（0 始まりの回数）。 */
  hangApplyAt?: ReadonlySet<number>;
  /** 置き直しを待つ期限（ms）。省けば既定。 */
  sessionAllowRulesTimeoutMs?: number;
}

function fakeRunnerSdk(fake: FakeOptions = {}): { fn: typeof sdkQuery; started: Started[] } {
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
      flagAllows: [],
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

    let applyCount = 0;
    const applyFlagSettings = async (settings: { permissions?: { allow?: string[] } }) => {
      const at = applyCount;
      applyCount += 1;
      if (fake.failApplyAt?.has(at) === true)
        throw new Error('control channel が閉じている（テスト）');
      if (fake.hangApplyAt?.has(at) === true) await new Promise<never>(() => undefined);
      record.flagAllows.push([...(settings.permissions?.allow ?? [])]);
    };

    return Object.assign(generate(), {
      close: () => record.finish(),
      interrupt: async () => undefined,
      ...(fake.withApplyFlagSettings === false ? {} : { applyFlagSettings }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

type Hook = 'PermissionDenied' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';

async function fire(
  options: Options,
  hookName: Hook,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.[hookName]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${hookName} フックが登録されていない`);
  return hook({ hook_event_name: hookName, ...input } as never, undefined, {
    signal: new AbortController().signal,
  });
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

const notesOf = (events: readonly RunnerEvent[]) =>
  events.filter((event): event is NoteEvent => event.type === 'note').map((n) => n.text);
const asksOf = (events: readonly RunnerEvent[]) =>
  events.filter((event): event is AskEvent => event.type === 'ask');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const ADDED = '一時規則としてこのセッションに足した';
const PASSED = '分類器を通った';
const DENIED_AGAIN = 'それでも拒否された';
const SUSPECT = 'セッションに許可規則を足すこの口が、分類器に効いていない疑いがある';
const EXPIRED = '分の期限が切れたので外した';
const REFUSED = '一時規則としてセッションに足せなかった';

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-session-allow-rule-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

async function startSession(fake: FakeOptions = {}): Promise<{
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
}> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk(fake);
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: DENY_ENV,
    ...(fake.sessionAllowRulesTimeoutMs === undefined
      ? {}
      : { sessionAllowRulesTimeoutMs: fake.sessionAllowRulesTimeoutMs }),
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  return { started: first, events, host };
}

/** 分類器の拒否 → クローンの allow までを流す。retry が返ることも確かめる。 */
async function denyThenAllow(
  started: Started,
  h: RunnerHost,
  input: {
    toolName?: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    agentId?: string;
  },
): Promise<void> {
  const denial = fire(started.options, 'PermissionDenied', {
    tool_name: input.toolName ?? 'Bash',
    tool_input: input.toolInput,
    tool_use_id: input.toolUseId,
    reason: '分類器が拒否した（テスト）',
    ...(input.agentId === undefined ? {} : { agent_id: input.agentId, agent_type: 'worker' }),
  });
  await tick();
  await h.answer('mgr-1', { requestId: input.toolUseId, decision: 'allow', message: 'どうぞ' });
  expect(await denial).toEqual({
    continue: true,
    hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
  });
}

describe('allow で一時規則を足す（#4905）', () => {
  it('Bash の allow で `Bash(<command>)` が足され、確認と allow 後の note は一時規則の文面になる', async () => {
    const { started, events, host: h } = await startSession();
    await denyThenAllow(started, h, {
      toolInput: { command: 'git push origin feat/x' },
      toolUseId: 'tu-add-1',
    });

    expect(started.flagAllows).toEqual([['Bash(git push origin feat/x)']]);

    const summary = asksOf(events)[0]?.summary ?? '';
    expect(summary).toContain(`\n\n${DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE}\n\n理由: `);
    expect(summary).not.toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH);

    const notes = notesOf(events);
    const added = notes.find((n) => n.includes(ADDED));
    expect(added).toContain('担当 mgr-1');
    expect(added).toContain('manager:mgr-1');
    expect(added).toContain('git push origin feat/x');
    const allowNote = notes.find((n) => n.includes('1回だけ許可した'));
    expect(allowNote).toContain('撃ち直すなら入力を1字も変えないこと');
    expect(allowNote).toContain('そのセッションの他の作業者にも効く');
    expect(allowNote).not.toContain('続けて同じ入力を撃たず');
  });

  it('撃ち直しの PreToolUse → PostToolUse で外れ、「通った」の note が出る', async () => {
    const { started, events, host: h } = await startSession();
    const toolInput = { command: 'echo rule-pass' };
    await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-pass-1' });

    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-pass-2',
    });
    await fire(started.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-pass-2',
      tool_response: { stdout: 'rule-pass' },
    });
    await tick();

    expect(started.flagAllows).toEqual([['Bash(echo rule-pass)'], []]);
    const passed = notesOf(events).filter((n) => n.includes(PASSED));
    expect(passed).toHaveLength(1);
    expect(passed[0]).toContain('道具の結果: 成功');
    expect(passed[0]).toContain('echo rule-pass');
  });

  it('道具が失敗で終わっても（PostToolUseFailure）、分類器は通ったとして外す', async () => {
    const { started, events, host: h } = await startSession();
    const toolInput = { command: 'false' };
    await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-fail-1' });

    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-fail-2',
    });
    await fire(started.options, 'PostToolUseFailure', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-fail-2',
      error: 'exit 1',
    });
    await tick();

    expect(started.flagAllows.at(-1)).toEqual([]);
    const passed = notesOf(events).find((n) => n.includes(PASSED));
    expect(passed).toContain('道具は失敗で終わったが、分類器は通っている');
  });

  it('撃ち直しが PermissionDenied で止められたら外し、「それでも拒否された」と口の効き目の疑いを書く', async () => {
    const { started, events, host: h } = await startSession();
    const toolInput = { command: 'echo rule-denied' };
    await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-den-1' });

    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-den-2',
    });
    await fire(started.options, 'PermissionDenied', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-den-2',
      reason: '分類器が拒否した（テスト）',
    });
    // 同じ呼び出しの知らせが後から届いても、note は重ねない
    started.push(liveDenialAsSdkSends('Bash', 'tu-den-2'));
    await tick();

    expect(started.flagAllows.at(-1)).toEqual([]);
    const denied = notesOf(events).filter((n) => n.includes(DENIED_AGAIN) && n.includes(SUSPECT));
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain('合図の出所: PermissionDenied');
    expect(notesOf(events).some((n) => n.includes(PASSED))).toBe(false);
  });

  it('拒否の知らせ（live）が先に届いても外し、「それでも拒否された」を書く', async () => {
    const { started, events, host: h } = await startSession();
    const toolInput = { command: 'echo rule-live' };
    await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-live-1' });

    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-live-2',
    });
    started.push(liveDenialAsSdkSends('Bash', 'tu-live-2'));
    await tick();

    expect(started.flagAllows.at(-1)).toEqual([]);
    const denied = notesOf(events).filter((n) => n.includes(DENIED_AGAIN) && n.includes(SUSPECT));
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain('合図の出所: live');
  });

  it('別の作業者（別の agentId）が同じ command を撃っても1回で外れる', async () => {
    const { started, events, host: h } = await startSession();
    const toolInput = { command: 'echo rule-shared' };
    await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-share-1', agentId: 'agent-a' });

    const fromOther = await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-share-2',
      agent_id: 'agent-b',
      agent_type: 'worker',
    });
    // 1回だけの許可（担い手ごと）は別の作業者には効かない。通すのは規則の側（CLI）である
    expect(fromOther).toEqual({ continue: true });
    await fire(started.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-share-2',
      agent_id: 'agent-b',
      agent_type: 'worker',
      tool_response: {},
    });
    await tick();

    expect(started.flagAllows).toEqual([['Bash(echo rule-shared)'], []]);
    expect(notesOf(events).filter((n) => n.includes(PASSED))).toHaveLength(1);

    // 外れた後の同じ入力には印が付かない（2回目は「通った」を書かない）
    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-share-3',
      agent_id: 'agent-a',
      agent_type: 'worker',
    });
    await fire(started.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'tu-share-3',
      agent_id: 'agent-a',
      agent_type: 'worker',
      tool_response: {},
    });
    await tick();
    expect(notesOf(events).filter((n) => n.includes(PASSED))).toHaveLength(1);
    expect(started.flagAllows).toHaveLength(2);
  });

  it('入力が1字でも違う呼び出しでは外れない', async () => {
    const { started, events, host: h } = await startSession();
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo rule-exact' },
      toolUseId: 'tu-exact-1',
    });
    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo rule-exact ' },
      tool_use_id: 'tu-exact-2',
    });
    await fire(started.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo rule-exact ' },
      tool_use_id: 'tu-exact-2',
      tool_response: {},
    });
    await tick();
    expect(started.flagAllows).toEqual([['Bash(echo rule-exact)']]);
    expect(notesOf(events).some((n) => n.includes(PASSED))).toBe(false);
  });
});

describe('一時規則の期限（#4905）', () => {
  it('使われないまま10分を過ぎたら、次の道具呼び出しで外して note を出す', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await denyThenAllow(started, h, {
        toolInput: { command: 'echo rule-ttl' },
        toolUseId: 'tu-ttl-1',
      });

      nowSpy.mockReturnValue(now + TTL - 1);
      await fire(started.options, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'echo other-a' },
        tool_use_id: 'tu-ttl-other-a',
      });
      await tick();
      expect(started.flagAllows).toEqual([['Bash(echo rule-ttl)']]);

      nowSpy.mockReturnValue(now + TTL);
      await fire(started.options, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'echo other-b' },
        tool_use_id: 'tu-ttl-other-b',
      });
      await tick();

      expect(started.flagAllows).toEqual([['Bash(echo rule-ttl)'], []]);
      const expired = notesOf(events).filter((n) => n.includes(EXPIRED));
      expect(expired).toHaveLength(1);
      expect(expired[0]).toContain('担当 mgr-1');
      expect(expired[0]).toContain('使われないまま');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('期限を過ぎた後の同じ入力には印を付けない（「通った」を書かない）', async () => {
    const { started, events, host: h } = await startSession();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const toolInput = { command: 'echo rule-ttl-late' };
      await denyThenAllow(started, h, { toolInput, toolUseId: 'tu-late-1' });
      nowSpy.mockReturnValue(now + TTL + 1);
      await fire(started.options, 'PreToolUse', {
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_use_id: 'tu-late-2',
      });
      await fire(started.options, 'PostToolUse', {
        tool_name: 'Bash',
        tool_input: toolInput,
        tool_use_id: 'tu-late-2',
        tool_response: {},
      });
      await tick();
      expect(notesOf(events).some((n) => n.includes(PASSED))).toBe(false);
      expect(notesOf(events).filter((n) => n.includes(EXPIRED))).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('セッションが閉じたら、使われていない規則を外したと書く', async () => {
    const { started, events, host: h } = await startSession();
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo rule-close' },
      toolUseId: 'tu-close-1',
    });
    await h.stop('mgr-1');
    expect(
      notesOf(events).some(
        (n) => n.includes('セッションが閉じたので使われないまま外した') && n.includes('rule-close'),
      ),
    ).toBe(true);
  });
});

describe('一時規則を足さない場合は今までどおり（#4905）', () => {
  for (const [label, command, reason] of [
    ['`*` を含む', 'rm -f /tmp/build/*.o', '`*` を含む'],
    ['改行を含む', 'echo a\necho b', '改行を含む'],
  ] as const) {
    it(`${label} command は規則にせず、足せなかった理由を書き、文面は従来のまま`, async () => {
      const { started, events, host: h } = await startSession();
      await denyThenAllow(started, h, { toolInput: { command }, toolUseId: `tu-unrule-${label}` });

      expect(started.flagAllows).toEqual([]);
      const summary = asksOf(events)[0]?.summary ?? '';
      expect(summary).toContain(`\n\n${DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}\n\n理由: `);
      expect(summary).not.toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE);
      const notes = notesOf(events);
      expect(notes.find((n) => n.includes(REFUSED))).toContain(reason);
      expect(notes.some((n) => n.includes(ADDED))).toBe(false);
      expect(notes.find((n) => n.includes('1回だけ許可した'))).toContain('続けて同じ入力を撃たず');
    });
  }

  it('Bash 以外の道具は規則にせず、「足せなかった」も書かない', async () => {
    const { started, events, host: h } = await startSession();
    await denyThenAllow(started, h, {
      toolName: 'Edit',
      toolInput: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
      toolUseId: 'tu-edit-1',
    });

    expect(started.flagAllows).toEqual([]);
    const summary = asksOf(events)[0]?.summary ?? '';
    expect(summary).toContain(`\n\n${DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}\n\n理由: `);
    const notes = notesOf(events);
    expect(notes.some((n) => n.includes(REFUSED) || n.includes(ADDED))).toBe(false);
    expect(notes.find((n) => n.includes('1回だけ許可した'))).toContain('続けて同じ入力を撃たず');
  });

  it('口を持たないセッションでは、Bash でも規則の話をせず従来の文面のまま', async () => {
    const { started, events, host: h } = await startSession({ withApplyFlagSettings: false });
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo no-port' },
      toolUseId: 'tu-noport-1',
    });

    const summary = asksOf(events)[0]?.summary ?? '';
    expect(summary).toContain(`\n\n${DENIAL_ASK_AFTER_ANSWER_PARAGRAPH}\n\n理由: `);
    expect(summary).not.toContain(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE);
    const notes = notesOf(events);
    expect(notes.some((n) => n.includes('一時規則'))).toBe(false);
    expect(notes.find((n) => n.includes('1回だけ許可した'))).toContain('続けて同じ入力を撃たず');
  });

  it('置き直しが失敗したら規則を足さず、失敗を書き、allow 後の note は従来の文面にする', async () => {
    const { started, events, host: h } = await startSession({ failApplyAt: new Set([0]) });
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo apply-fails' },
      toolUseId: 'tu-applyfail-1',
    });

    expect(started.flagAllows).toEqual([]);
    const notes = notesOf(events);
    const refused = notes.find((n) => n.includes(REFUSED));
    expect(refused).toContain('規則の置き直しが失敗した');
    expect(refused).toContain('control channel が閉じている（テスト）');
    expect(notes.some((n) => n.includes(ADDED))).toBe(false);
    expect(notes.find((n) => n.includes('1回だけ許可した'))).toContain('続けて同じ入力を撃たず');

    // 足せなかった規則には印が付かない
    await fire(started.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo apply-fails' },
      tool_use_id: 'tu-applyfail-2',
    });
    await fire(started.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo apply-fails' },
      tool_use_id: 'tu-applyfail-2',
      tool_response: {},
    });
    await tick();
    expect(notesOf(events).some((n) => n.includes(PASSED))).toBe(false);
  });

  it('置き直しが答えなければ期限で諦めて従来どおりにし、後に続く置き直しも止めない', async () => {
    const {
      started,
      events,
      host: h,
    } = await startSession({
      hangApplyAt: new Set([0]),
      sessionAllowRulesTimeoutMs: 1,
    });
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo apply-hangs' },
      toolUseId: 'tu-applyhang-1',
    });

    const refused = notesOf(events).find((n) => n.includes(REFUSED));
    expect(refused).toContain('以内に返らなかった');
    expect(notesOf(events).find((n) => n.includes('1回だけ許可した'))).toContain(
      '続けて同じ入力を撃たず',
    );

    // 答えない1回目が鎖を塞いでいない: 次の allow の置き直しは届く
    await denyThenAllow(started, h, {
      toolInput: { command: 'echo after-hang' },
      toolUseId: 'tu-applyhang-2',
    });
    expect(started.flagAllows).toEqual([['Bash(echo after-hang)']]);
  });
});

describe('確認の固定の段落（#4905・#4943）', () => {
  it('Bash 用の段落は、一時規則・他の作業者への効き・入力を変えないこと・それでも拒否されたときの別の手を言う', () => {
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).toContain(
      'allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される',
    );
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).toContain(
      'そのセッションの他の作業者にも効く',
    );
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).toContain(
      '撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること',
    );
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).toContain('自動では撃ち直されない');
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).not.toContain('続けて同じ入力を撃たず');
    // 1字一致で畳む単位なので、変わる値と段落の区切りを含まない
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH_BASH_RULE).not.toContain('\n');
  });

  it('それ以外用の段落は #4904 の文面のまま', () => {
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH).toContain(
      '続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること',
    );
    expect(DENIAL_ASK_AFTER_ANSWER_PARAGRAPH).not.toContain('一時規則');
  });
});
