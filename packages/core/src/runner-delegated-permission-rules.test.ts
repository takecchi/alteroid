import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 人間が承認した許可（委譲先の許可規則）を、#4905 の一時規則と1つの一覧にしてセッションへ置く（#4952）

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

interface Started {
  options: Options;
  finish: () => void;
  /** `applyFlagSettings` に渡った `permissions.allow` の並び（呼ばれた順）。 */
  flagAllows: string[][];
}

interface FakeOptions {
  /** false なら Query に `applyFlagSettings` を生やさない（口を持たないセッション）。 */
  withApplyFlagSettings?: boolean;
  /** 渡すと、その回の `applyFlagSettings` を失敗させる（0 始まりの回数）。 */
  failApplyAt?: ReadonlySet<number>;
}

function fakeRunnerSdk(fake: FakeOptions = {}): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let finish: (() => void) | undefined;
    const record: Started = {
      options: input.options,
      finish: () => finish?.(),
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
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    let applyCount = 0;
    const applyFlagSettings = async (settings: { permissions?: { allow?: string[] } }) => {
      const at = applyCount;
      applyCount += 1;
      if (fake.failApplyAt?.has(at) === true)
        throw new Error('control channel が閉じている（テスト）');
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

async function fire(
  options: Options,
  hookName: 'PermissionDenied' | 'PreToolUse' | 'PostToolUse',
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.[hookName]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${hookName} フックが登録されていない`);
  return hook({ hook_event_name: hookName, ...input } as never, undefined, {
    signal: new AbortController().signal,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;
const notesOf = (events: readonly RunnerEvent[]) =>
  events.filter((event): event is NoteEvent => event.type === 'note').map((n) => n.text);

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-delegated-permission-rules-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

function makeHost(fake: FakeOptions = {}) {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk(fake);
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: DENY_ENV,
  });
  return { host, events, started };
}

async function denyThenAllow(started: Started, h: RunnerHost, command: string, id: string) {
  const denial = fire(started.options, 'PermissionDenied', {
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: id,
    reason: '分類器が拒否した（テスト）',
  });
  await tick();
  await h.answer('mgr-1', { requestId: id, decision: 'allow', message: 'どうぞ' });
  await denial;
}

describe('委譲先の許可規則をセッションへ置く（#4952）', () => {
  it('セッションを開いたとき、許可の規則が置かれる', async () => {
    const { host: h, started } = makeHost();
    h.setPermissionRules(['Bash(gh pr view 1)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    await tick();
    expect(started[0]?.flagAllows).toEqual([['Bash(gh pr view 1)']]);
  });

  it('許可の規則と一時規則が1つの一覧で置かれ、重複は1つにする', async () => {
    const { host: h, started } = makeHost();
    h.setPermissionRules(['Bash(gh pr view 1)', 'Bash(make test)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const s = started[0] as Started;
    await denyThenAllow(s, h, 'git push origin a', 'tu-1');
    await denyThenAllow(s, h, 'make test', 'tu-2');
    expect(s.flagAllows.at(-2)).toEqual([
      'Bash(gh pr view 1)',
      'Bash(make test)',
      'Bash(git push origin a)',
    ]);
    expect(s.flagAllows.at(-1)).toEqual([
      'Bash(gh pr view 1)',
      'Bash(make test)',
      'Bash(git push origin a)',
    ]);
  });

  it('一時規則を外しても、同じ文字列の許可の規則は一覧に残る', async () => {
    const { host: h, started } = makeHost();
    h.setPermissionRules(['Bash(make test)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const s = started[0] as Started;
    await denyThenAllow(s, h, 'make test', 'tu-1');
    await fire(s.options, 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'make test' },
      tool_use_id: 'tu-2',
    });
    await fire(s.options, 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'make test' },
      tool_use_id: 'tu-2',
      tool_response: {},
    });
    await tick();
    // 一時規則は1回使って外れたが、許可の規則は残る
    expect(s.flagAllows.at(-1)).toEqual(['Bash(make test)']);
  });

  it('許可が取り消されると一覧から消えて、走行中のセッションへ置き直される', async () => {
    const { host: h, started } = makeHost();
    h.setPermissionRules(['Bash(gh pr view 1)', 'Bash(make test)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    await tick();
    expect(h.setPermissionRules(['Bash(make test)'])).toEqual({ count: 1, changed: true });
    await tick();
    expect(started[0]?.flagAllows).toEqual([
      ['Bash(gh pr view 1)', 'Bash(make test)'],
      ['Bash(make test)'],
    ]);

    // 同じ一覧が降りても置き直さない
    expect(h.setPermissionRules(['Bash(make test)'])).toEqual({ count: 1, changed: false });
    await tick();
    expect(started[0]?.flagAllows).toHaveLength(2);
  });

  it('許可の一覧が変わったのに置き直せなければ、note を出す', async () => {
    const { host: h, started, events } = makeHost({ failApplyAt: new Set([1]) });
    h.setPermissionRules(['Bash(gh pr view 1)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    await tick();
    h.setPermissionRules([]);
    await tick();
    expect(started[0]?.flagAllows).toEqual([['Bash(gh pr view 1)']]);
    const note = notesOf(events).find((n) => n.includes('委譲先の許可規則'));
    expect(note).toContain('置き直せなかった');
    expect(note).toContain('担当 mgr-1');
    expect(note).toContain('control channel が閉じている（テスト）');
    expect(note).not.toContain('gh pr view');
  });

  it('口の無いセッション（Codex 相当）では何もしない（置かず、note も出さない）', async () => {
    const { host: h, events } = makeHost({ withApplyFlagSettings: false });
    h.setPermissionRules(['Bash(gh pr view 1)']);
    await h.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    await tick();
    h.setPermissionRules([]);
    await tick();
    expect(notesOf(events).some((n) => n.includes('許可規則'))).toBe(false);
  });
});
