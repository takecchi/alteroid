import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { RunnerDenialJudge, type RunnerDenialJudgement } from './runner-denial-judge.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession` が `RunnerDenialJudge` へ口を渡す所（コンストラクタの配線）と、呼び元 `#onPermissionDenied` の呼び方を縛る。
// `runner-permission-denied-pin.test.ts`（切り出し前の作りの出力）が縛る周回数・note の全文とは別に、ここでは次を見る:
//   (1) 1 回の拒否のフックにつき `judge` が 1 回だけ、同期で、Promise でない判別付きの値を返すこと（呼び元が `await` で包まない・`async` にしない）。
//   (2) `decided` ならフックの戻りは `judge` が返した決定そのまま、`await` を挟まず解ける周回（pin と同じ 2 周）であること。
//   (3) 控え（RecentMap 2 本）が `RunnerSession` と参照で共有されていること: 許可を返した撃ち直しの再拒否を `judge` が見分ける
//       （写した RecentMap や別の器を渡すと見分けられず、2 件目も `continue` になる）。
//   (4) `vaultValues` の口が同期の文字列の並びを返すこと（口を async で包むと `buildDenialInputHead` が落ちるか、継続しない）。
// 期待の値は今の作りの出力を目で読んで置いた（仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回と、回数の上限つきの `setTimeout(0)` の周回だけ）。
// フェイクの SDK と rig は pin のものと同じ形（pin は変えないので写した）。

const NOW = Date.parse('2026-10-20T00:00:00.000Z');

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
  finish: () => void;
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
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-denial-judge-wiring-');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 条件が成り立つまで、回数の上限つきで `setTimeout(0)` を回す。 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !condition(); i += 1) await tick();
}

/** マイクロタスクの周回だけで、条件が成り立つまでの周回数を数える（イベントループへ制御を返さない）。 */
async function lapsUntil(condition: () => boolean, max = 80): Promise<number> {
  let laps = 0;
  while (!condition() && laps < max) {
    await Promise.resolve();
    laps += 1;
  }
  return laps;
}

interface Rig {
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
}

async function open(): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
    },
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  await until(() => events.some((event) => event.type === 'session'));
  events.length = 0;
  return { started: first, events, host };
}

interface Called {
  done: () => boolean;
  value: () => unknown;
}

function fire(rig: Rig, overrides: Record<string, unknown> = {}): Called {
  const fn = rig.started.options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (fn === undefined) throw new Error('PermissionDenied フックが登録されていない');
  const input = {
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 'tu-1',
    reason: '分類器が拒否した（テスト）',
    ...overrides,
  };
  let done = false;
  let value: unknown;
  fn(input as never, undefined, { signal: new AbortController().signal }).then(
    (v) => {
      done = true;
      value = v;
    },
    () => {
      done = true;
    },
  );
  return { done: () => done, value: () => value };
}

async function pre(rig: Rig, toolUseId: string, toolInput: unknown): Promise<string> {
  const fn = rig.started.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (fn === undefined) throw new Error('PreToolUse フックが登録されていない');
  const out = await fn(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: toolUseId,
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
  return (
    (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision ?? 'continue'
  );
}

function judgeSpy() {
  return vi.spyOn(RunnerDenialJudge.prototype, 'judge');
}

const kindsOf = (spy: ReturnType<typeof judgeSpy>): string[] =>
  spy.mock.results.map((result) =>
    result.type === 'return' ? (result.value as RunnerDenialJudgement).kind : 'threw',
  );

describe('呼び元は judge を 1 回ずつ同期で呼ぶ', () => {
  it('継続する回: 1 回・Promise でない値・同期のうちに入口の note が出る', async () => {
    const spy = judgeSpy();
    const rig = await open();
    const called = fire(rig);
    // 待たずに見る: `judge` の呼びと入口の note は、フックを呼んだ同じ同期の中で済む
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]?.value).not.toBeInstanceOf(Promise);
    expect(kindsOf(spy)).toEqual(['continue']);
    expect(rig.events.map((e) => e.type)).toEqual(['note', 'ask']);
    expect(called.done()).toBe(false);
  });

  it('decided（道具名なし）: 1 回・フックの戻りは no-retry・await を挟まず 2 周で解ける', async () => {
    const spy = judgeSpy();
    const rig = await open();
    const called = fire(rig, { tool_name: undefined });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.results[0]?.value).toEqual({ kind: 'decided', decision: { kind: 'no-retry' } });
    const laps = await lapsUntil(called.done);
    expect({ laps, value: called.value() }).toMatchInlineSnapshot(`
      {
        "laps": 2,
        "value": {
          "continue": true,
        },
      }
    `);
  });

  it('decided（入力が鍵にならない）も 2 周', async () => {
    const spy = judgeSpy();
    const rig = await open();
    const called = fire(rig, { tool_input: undefined });
    expect(kindsOf(spy)).toEqual(['decided']);
    expect(await lapsUntil(called.done)).toBe(2);
  });
});

describe('控えは RunnerSession と参照で共有される', () => {
  it('許可を返した撃ち直しの再拒否は decided になり、確認は積まれない', async () => {
    const spy = judgeSpy();
    const rig = await open();
    const first = fire(rig, { tool_use_id: 'tu-1', tool_input: { command: 'echo again' } });
    await rig.host.answer('mgr-1', { requestId: 'tu-1', decision: 'allow', message: 'どうぞ' });
    await until(first.done);
    expect(await pre(rig, 'tu-2', { command: 'echo again' })).toBe('allow');
    rig.events.length = 0;
    const again = fire(rig, { tool_use_id: 'tu-3', tool_input: { command: 'echo again' } });
    expect(kindsOf(spy)).toEqual(['continue', 'decided']);
    expect(await lapsUntil(again.done)).toBe(2);
    expect(rig.events.filter((e) => e.type === 'ask')).toEqual([]);
  });
});

describe('vaultValues の口は同期の並びを返す', () => {
  it('資格の正本が無いセッションでも、継続する回は inputHead を持って continue になる', async () => {
    const spy = judgeSpy();
    const rig = await open();
    fire(rig);
    const result = spy.mock.results[0]?.value as RunnerDenialJudgement;
    expect(result.kind === 'continue' ? typeof result.inputHead : result.kind).toBe('string');
  });
});
