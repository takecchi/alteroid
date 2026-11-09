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
import { createRunnerHost, ONE_SHOT_ALLOW_TTL_MS, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { WorkerToolWatchClock } from './runner-worker-tool-watch.js';

// `RunnerSession#noteDenial`（拒否の知らせの決着と `permission_denied` の送出）を、外から見える結果だけで縛る。
// 入口は 2 つ: SDK の `system/permission_denied`（`via: 'live'`）と、ターン終わりの `result.permission_denials`（`via: 'result'`）。
// 見るのは: 降ろされた `permission_denied` の欄・note の全文と順・`#allowedButDenied` の期限（次の拒否のフックの答え）・
// 控えが消えること（上限の note が出ないこと）・出来事が出る周回・emit／note が同期で投げたときの伝わり方。
// 期待の文字列と周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。
// 実時間では待たない（待つのはマイクロタスクの周回と `setTimeout(0)` の 1 回だけ。時計は `Date.now` の差し替えと注入の時計）。

const DENY_ENV = { [BASH_GUARD_ENV]: 'deny' };

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
  dir = makeTempDirSync('alteroid-runner-denial-pin-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Rig {
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
  clock: WorkerToolWatchClock & { advance: (ms: number) => void };
}

function fakeClock(startMs: number): Rig['clock'] {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    advance: (ms) => {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

async function open(
  options: { env?: NodeJS.ProcessEnv; throwOn?: (event: RunnerEvent) => boolean } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  const clock = fakeClock(Date.parse('2026-10-04T00:00:00.000Z'));
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (options.throwOn?.(event) === true) throw new Error('emit が落ちた（テスト用）');
    },
    queryFn: fn,
    env: options.env ?? DENY_ENV,
    workerToolWatchClock: clock,
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  // 起動までに出た出来事は見ない
  events.length = 0;
  return { started: first, events, host, clock };
}

type Hook = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied';

function fire(rig: Rig, hookName: Hook, input: Record<string, unknown>): Promise<HookJSONOutput> {
  const hook = rig.started.options.hooks?.[hookName]?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error(`${hookName} フックが登録されていない`);
  return hook({ hook_event_name: hookName, ...input } as never, undefined, {
    signal: new AbortController().signal,
  });
}

function pre(
  rig: Rig,
  id: string,
  tool = 'Bash',
  toolInput: unknown = { command: 'echo hi' },
  extra: Record<string, unknown> = {},
): Promise<HookJSONOutput> {
  return fire(rig, 'PreToolUse', {
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: id,
    ...extra,
  });
}

/** SDK が送る生の合図（`system/permission_denied`）。欄は渡した分だけ載せる。 */
function live(rig: Rig, fields: Record<string, unknown>): void {
  rig.started.push({
    type: 'system',
    subtype: 'permission_denied',
    session_id: 'sess-mgr',
    uuid: `uuid-live-${String(fields.tool_use_id ?? 'none')}`,
    ...fields,
  } as unknown as SDKMessage);
}

/** ターン終わり（`result`）。`permission_denials` は渡した分だけ載せる。 */
function result(rig: Rig, denials: Record<string, unknown>[]): void {
  rig.started.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '終わった',
    session_id: 'sess-mgr',
    uuid: 'uuid-result',
    permission_denials: denials,
  } as unknown as SDKMessage);
}

type Denied = Extract<RunnerEvent, { type: 'permission_denied' }>;
const deniedOf = (events: readonly RunnerEvent[]): Denied[] =>
  events.filter((event): event is Denied => event.type === 'permission_denied');

/** note は全文、`permission_denied` は欄ごと（`managerId` は省く）、作業者の道具の見張りは `種別:id`。ほかの出来事は見ない。 */
function view(events: readonly RunnerEvent[]): unknown[] {
  return events.flatMap((event): unknown[] => {
    if (event.type === 'note') return [`note: ${event.text}`];
    if (event.type === 'permission_denied') {
      return [event];
    }
    if (event.type === 'tool_running' || event.type === 'tool_end') {
      return [`${event.type}:${event.toolUseId}`];
    }
    return [];
  });
}

const WORKER = { agent_id: 'agent-1', agent_type: 'worker-x' };

/** 最初に当たった 1 回だけ投げる（その出来事は `events` に積んだ後で投げる。後続を止めないため）。 */
function throwOnce(predicate: (event: RunnerEvent) => boolean): (event: RunnerEvent) => boolean {
  let thrown = false;
  return (event) => {
    if (thrown || !predicate(event)) return false;
    thrown = true;
    return true;
  };
}

/** 分類器の拒否 → クローンの allow → 撃ち直しの PreToolUse（allow が返る）まで。 */
async function allowedRetryFor(rig: Rig, first: string, retry: string): Promise<void> {
  const input = { command: 'echo th' };
  const denial = fire(rig, 'PermissionDenied', {
    tool_name: 'Bash',
    tool_input: input,
    tool_use_id: first,
    reason: '分類器が拒否した（テスト）',
  });
  await tick();
  await rig.host.answer('mgr-1', { requestId: first, decision: 'allow', message: 'どうぞ' });
  await denial;
  await pre(rig, retry, 'Bash', input);
}

describe('初出の permission_denied の欄（live と result）', () => {
  it('全欄: live は actor を載せ、result は載せない。reason / reasonType / message / input は素通し', async () => {
    const rig = await open();
    const full = {
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/a', note: 'x' },
      decision_reason: '分類器が止めた',
      decision_reason_type: 'classifier',
      message: '拒否の本文',
    };
    live(rig, { ...full, tool_use_id: 'tu-live', ...WORKER });
    await tick();
    result(rig, [{ ...full, tool_use_id: 'tu-result', ...WORKER }]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "worker:mgr-1:worker-x",
          "input": {
            "file_path": "/tmp/a",
            "note": "x",
          },
          "managerId": "mgr-1",
          "message": "拒否の本文",
          "reason": "分類器が止めた",
          "reasonType": "classifier",
          "tool": "Edit",
          "toolUseId": "tu-live",
          "type": "permission_denied",
          "via": "live",
        },
        {
          "input": {
            "file_path": "/tmp/a",
            "note": "x",
          },
          "managerId": "mgr-1",
          "message": "拒否の本文",
          "reason": "分類器が止めた",
          "reasonType": "classifier",
          "tool": "Edit",
          "toolUseId": "tu-result",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('最小: 欄が無ければキーごと省く（reason / reasonType / message / actor / inputHead / input）。入力が null なら null を運ぶ', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-min-live' });
    await tick();
    result(rig, [
      { tool_name: 'Read', tool_use_id: 'tu-min-result' },
      { tool_name: 'Read', tool_use_id: 'tu-null', tool_input: null },
    ]);
    await tick();
    const denied = deniedOf(rig.events);
    expect(denied.map((event) => Object.keys(event))).toMatchInlineSnapshot(`
      [
        [
          "type",
          "managerId",
          "toolUseId",
          "tool",
          "input",
          "via",
          "actor",
        ],
        [
          "type",
          "managerId",
          "toolUseId",
          "tool",
          "input",
          "via",
        ],
        [
          "type",
          "managerId",
          "toolUseId",
          "tool",
          "input",
          "via",
        ],
      ]
    `);
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Read",
          "toolUseId": "tu-min-live",
          "type": "permission_denied",
          "via": "live",
        },
        {
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Read",
          "toolUseId": "tu-min-result",
          "type": "permission_denied",
          "via": "result",
        },
        {
          "input": null,
          "managerId": "mgr-1",
          "tool": "Read",
          "toolUseId": "tu-null",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('actor: live の manager は manager:<id>、agentId だけなら型の既定名、agentId と agentType なら worker:<id>:<型>', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-a1' });
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-a2', agent_id: 'agent-1' });
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-a3', ...WORKER });
    await tick();
    expect(deniedOf(rig.events).map((event) => [event.toolUseId, event.actor]))
      .toMatchInlineSnapshot(`
      [
        [
          "tu-a1",
          "manager:mgr-1",
        ],
        [
          "tu-a2",
          "worker:mgr-1:worker",
        ],
        [
          "tu-a3",
          "worker:mgr-1:worker-x",
        ],
      ]
    `);
  });
});

describe('toolUseId が無いときの代用の鍵 `${tool}:${digest}`', () => {
  it('tool が無ければ (不明な道具)。鍵は入力の先頭 120 字の digest で、入力そのものは鍵に混ざらない。同じ入力の 2 度目は何もしない', async () => {
    const rig = await open();
    result(rig, [
      { tool_input: { command: 'echo one' } },
      { tool_name: 'Bash', tool_input: { command: 'echo one' } },
      { tool_name: 'Bash', tool_input: { command: 'echo one' } },
      { tool_name: 'Bash', tool_input: { command: 'echo two' } },
      { tool_name: 'Bash' },
      { tool_name: 'Bash' },
    ]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "input": {
            "command": "echo one",
          },
          "managerId": "mgr-1",
          "tool": "(不明な道具)",
          "toolUseId": "(不明な道具):edae0f7333cd43f1",
          "type": "permission_denied",
          "via": "result",
        },
        {
          "input": {
            "command": "echo one",
          },
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "Bash:edae0f7333cd43f1",
          "type": "permission_denied",
          "via": "result",
        },
        {
          "input": {
            "command": "echo two",
          },
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "Bash:426e8acbac279aa4",
          "type": "permission_denied",
          "via": "result",
        },
        {
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "Bash:e3b0c44298fc1c14",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('入力は先頭 120 字までで鍵になる（121 字目以降だけが違う入力は同じ拒否として扱う）', async () => {
    const rig = await open();
    const head = 'x'.repeat(120);
    result(rig, [
      { tool_name: 'Bash', tool_input: { command: `${head}AAAA` } },
      { tool_name: 'Bash', tool_input: { command: `${head}BBBB` } },
    ]);
    await tick();
    expect(deniedOf(rig.events).map((event) => event.toolUseId)).toMatchInlineSnapshot(`
      [
        "Bash:4dd3f9e868cc873f",
      ]
    `);
  });
});

describe('同じ拒否の 2 度目（seen の枝と #denied への書き込み）', () => {
  it('live（入力なし）の後に result が入力を載せて届くと、permission_denied は降ろさず形だけの note を 1 回出す。その後の result は何もしない', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-seen' });
    await tick();
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-seen', tool_input: { command: 'ls -la' } }]);
    await tick();
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-seen', tool_input: { command: 'ls -la' } }]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-seen",
          "type": "permission_denied",
          "via": "live",
        },
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 欄=command / 先頭の語=ls / chars=20",
      ]
    `);
  });

  it('入力が無い 2 度目・入力を持つ初出の後の 2 度目は何もしない', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-a' });
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-a' }]);
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-b', tool_input: { command: 'ls' } }]);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-b' });
    await tick();
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-b', tool_input: { command: 'ls' } }]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-a",
          "type": "permission_denied",
          "via": "live",
        },
        {
          "input": {
            "command": "ls",
          },
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-b",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('入力の無い 2 度目は #denied を書き換えない: live が 2 度続いても、後から入力を持つ result が来れば形の note が出る', async () => {
    const rig = await open();
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-twice' });
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-twice' });
    await tick();
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-twice', tool_input: { command: 'ls' } }]);
    await tick();
    expect(notesOnly(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 欄=command / 先頭の語=ls / chars=16",
      ]
    `);
  });

  it('入力の形の note: 文字列・配列・欄なしのオブジェクト・数値・null（形だけで本文は残さない）', async () => {
    const rig = await open();
    const inputs: [string, unknown][] = [
      ['s', 'secret-token-value'],
      ['arr', [1, 2, 3]],
      ['obj', {}],
      ['num', 42],
      ['null', null],
    ];
    for (const [id] of inputs) live(rig, { tool_name: 'Bash', tool_use_id: `tu-${id}` });
    await tick();
    result(
      rig,
      inputs.map(([id, input]) => ({
        tool_name: 'Bash',
        tool_use_id: `tu-${id}`,
        tool_input: input,
      })),
    );
    await tick();
    expect(notesOnly(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 文字列 / chars=18",
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 配列 / 要素=3 / chars=7",
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 欄=(欄なし) / chars=2",
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: number / chars=2",
        "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: null",
      ]
    `);
  });
});

function notesOnly(events: readonly RunnerEvent[]): string[] {
  return view(events).filter((entry): entry is string => typeof entry === 'string');
}

describe('inputHead（PreToolUse で控えた入力の先頭）を引いて消す', () => {
  it('初出の denial に inputHead が載る（live・result とも）。同じ tool_use_id の 2 度目は何も降ろさない', async () => {
    const rig = await open();
    await pre(rig, 'tu-h1', 'Edit', { file_path: '/tmp/x', old_string: 'a' });
    await pre(rig, 'tu-h2', 'Edit', { file_path: '/tmp/y', old_string: 'b' });
    live(rig, { tool_name: 'Edit', tool_use_id: 'tu-h1' });
    await tick();
    result(rig, [{ tool_name: 'Edit', tool_use_id: 'tu-h2' }]);
    await tick();
    live(rig, { tool_name: 'Edit', tool_use_id: 'tu-h1' });
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "inputHead": "{"file_path":"/tmp/x","old_string":"a"}",
          "managerId": "mgr-1",
          "tool": "Edit",
          "toolUseId": "tu-h1",
          "type": "permission_denied",
          "via": "live",
        },
        {
          "input": undefined,
          "inputHead": "{"file_path":"/tmp/y","old_string":"b"}",
          "managerId": "mgr-1",
          "tool": "Edit",
          "toolUseId": "tu-h2",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  // 控えが消えていれば 512 件目までは上限に達しない（消えていなければ、拒否済みの 1 件が残って 513 件目で「忘れた」note が出る）
  async function forgetNotesAfterFilling(denyFirst: boolean): Promise<string[]> {
    const rig = await open();
    await pre(rig, 'tu-fill-0', 'Read', { file_path: '/tmp/fill-0' });
    if (denyFirst) {
      live(rig, { tool_name: 'Read', tool_use_id: 'tu-fill-0' });
      await tick();
    }
    for (let index = 1; index <= 512; index += 1) {
      await pre(rig, `tu-fill-${index}`, 'Read', { file_path: `/tmp/fill-${index}` });
    }
    return notesOnly(rig.events).filter((text) => text.includes('PreToolUse で控えた入力の先頭'));
  }

  it('引いたら消す: 拒否済みの控えは残らず、上限の「忘れた」note が出ない（対照: 拒否しなければ 1 件出る）', async () => {
    expect({
      denied: await forgetNotesAfterFilling(true),
      control: await forgetNotesAfterFilling(false),
    }).toMatchInlineSnapshot(`
      {
        "control": [
          "note: PreToolUse で控えた入力の先頭の記憶が上限（512件）に達したので、古い 1 件（tool_use_id のみ。本文は書かない）を忘れた: tu-fill-0。この tool_use_id の拒否が後から届いても、inputHead は付かない。",
        ],
        "denied": [],
      }
    `);
  });
});

describe('一時規則・1 回だけの許可の決着', () => {
  /** 分類器の拒否 → クローンの allow → 撃ち直しの PreToolUse（allow が返る）までを流す。 */
  async function allowedRetry(
    rig: Rig,
    input: { command: string },
    ids: { first: string; retry: string },
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const denial = fire(rig, 'PermissionDenied', {
      tool_name: 'Bash',
      tool_input: input,
      tool_use_id: ids.first,
      reason: '分類器が拒否した（テスト）',
      ...extra,
    });
    await tick();
    await rig.host.answer('mgr-1', { requestId: ids.first, decision: 'allow', message: 'どうぞ' });
    await denial;
    const retry = await pre(rig, ids.retry, 'Bash', input, extra);
    expect(
      (retry as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
        ?.permissionDecision,
    ).toBe('allow');
  }

  const funneledNote = (events: readonly RunnerEvent[]): string[] =>
    notesOnly(events).filter((text) => text.includes('それでも拒否された（合図の出所'));

  it('1 回だけの許可で allow を返した呼び出しの拒否: note の全文（manager・worker、live・result）と、同じ id の 2 度目では出さない', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo m' }, { first: 'tu-m1', retry: 'tu-m2' });
    await allowedRetry(rig, { command: 'echo w' }, { first: 'tu-w1', retry: 'tu-w2' }, WORKER);
    // 作業者の呼び出しは見張りに載る: 20 秒たって tool_running が出ている状態で拒否される（tool_end → 一時規則の note → 1 回だけの許可の note の順を見る）
    rig.clock.advance(20_000);
    rig.events.length = 0;
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-m2' });
    await tick();
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-m2' });
    result(rig, [
      { tool_name: 'Bash', tool_use_id: 'tu-m2' },
      { tool_name: 'Bash', tool_use_id: 'tu-w2', tool_input: { command: 'echo w' } },
    ]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: live）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo m",
        "note: 1回だけの許可（issue #1105 P1、manager:mgr-1・Bash）で allow を返した呼び出しが、それでも拒否された（合図の出所: live）。分類器がこの allow を分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いていない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。同じ呼び出しへの確認は重ねて上げない（#4904）。",
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "inputHead": "echo m",
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-m2",
          "type": "permission_denied",
          "via": "live",
        },
        "tool_end:tu-w2",
        "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: worker:mgr-1:worker-x・Bash）に当たる worker:mgr-1:worker-x の呼び出しが、それでも拒否された（合図の出所: result）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo w",
        "note: 1回だけの許可（issue #1105 P1、worker:mgr-1:worker-x・Bash）で allow を返した呼び出しが、それでも拒否された（合図の出所: result）。分類器がこの allow を分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いていない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。同じ呼び出しへの確認は重ねて上げない（#4904）。",
        {
          "input": {
            "command": "echo w",
          },
          "inputHead": "echo w",
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-w2",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('funneled が無い拒否・toolUseId が無い拒否は、1 回だけの許可の note を出さない', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo n' }, { first: 'tu-n1', retry: 'tu-n2' });
    rig.events.length = 0;
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-other' });
    result(rig, [{ tool_name: 'Bash', tool_input: { command: 'echo n' } }]);
    await tick();
    expect(funneledNote(rig.events)).toEqual([]);
    expect(deniedOf(rig.events)).toHaveLength(2);
  });

  it('#allowedButDenied の期限は funneled.at + 10 分、鍵は funneled.key（同じ入力の別 id も止める）。1ms 手前は no-retry、ちょうどで確認が上がる', async () => {
    const rig = await open();
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await allowedRetry(rig, { command: 'echo ttl' }, { first: 'tu-t1', retry: 'tu-t2' });
    // 撃ち直しが拒否される（`at` は allow を返した時刻 = now）
    spy.mockReturnValue(now + 5000);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-t2' });
    await tick();
    const probe = async (id: string, at: number): Promise<unknown> => {
      spy.mockReturnValue(at);
      const before = rig.events.length;
      const answer = await Promise.race([
        fire(rig, 'PermissionDenied', {
          tool_name: 'Bash',
          tool_input: { command: 'echo ttl' },
          tool_use_id: id,
          reason: '分類器が拒否した（テスト）',
        }),
        tick().then(() => 'pending（確認が上がった）'),
      ]);
      const asked = rig.events.slice(before).filter((event) => event.type === 'ask').length;
      return { answer, asked };
    };
    const results = {
      otherInput: await (async () => {
        spy.mockReturnValue(now + 6000);
        void fire(rig, 'PermissionDenied', {
          tool_name: 'Bash',
          tool_input: { command: 'echo different' },
          tool_use_id: 'tu-t-other',
          reason: '分類器が拒否した（テスト）',
        });
        await tick();
        return rig.events.filter((event) => event.type === 'ask').length;
      })(),
      oneMsBefore: await probe('tu-t3', now + ONE_SHOT_ALLOW_TTL_MS - 1),
      atExpiry: await probe('tu-t4', now + ONE_SHOT_ALLOW_TTL_MS),
    };
    expect(results).toMatchInlineSnapshot(`
      {
        "atExpiry": {
          "answer": "pending（確認が上がった）",
          "asked": 1,
        },
        "oneMsBefore": {
          "answer": {
            "continue": true,
          },
          "asked": 0,
        },
        "otherInput": 2,
      }
    `);
  });

  it('result 経由でも一時規則の使用と 1 回だけの許可が決着する（via: result が note に載り、inputHead は撃ち直しの入力の先頭）', async () => {
    const rig = await open();
    const input = { command: 'echo rule-result' };
    await allowedRetry(rig, input, { first: 'tu-r1', retry: 'tu-r2' });
    rig.events.length = 0;
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-r2' }]);
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: result）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo rule-result",
        "note: 1回だけの許可（issue #1105 P1、manager:mgr-1・Bash）で allow を返した呼び出しが、それでも拒否された（合図の出所: result）。分類器がこの allow を分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いていない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。同じ呼び出しへの確認は重ねて上げない（#4904）。",
        {
          "input": undefined,
          "inputHead": "echo rule-result",
          "managerId": "mgr-1",
          "tool": "Bash",
          "toolUseId": "tu-r2",
          "type": "permission_denied",
          "via": "result",
        },
      ]
    `);
  });

  it('作業者の道具の見張り: live・result どちらの拒否でも tool_end を送る', async () => {
    const rig = await open();
    const slow = (rig: Rig) => rig.clock.advance(20_000);
    await pre(rig, 'tu-wl', 'Bash', { command: 'sleep 1' }, WORKER);
    await pre(rig, 'tu-wr', 'Bash', { command: 'sleep 1' }, WORKER);
    slow(rig);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-wl' });
    await tick();
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-wr' }]);
    await tick();
    expect(
      rig.events
        .filter((event) => event.type === 'tool_running' || event.type === 'tool_end')
        .map((event) => `${event.type}:${(event as { toolUseId: string }).toolUseId}`),
    ).toMatchInlineSnapshot(`
      [
        "tool_running:tu-wl",
        "tool_running:tu-wr",
        "tool_end:tu-wl",
        "tool_end:tu-wr",
      ]
    `);
  });
});

describe('#progressed を立てない（resume の作り直しで観測）', () => {
  // 拒否だけを受けた resume は「まだ手が動いていない」ままなので、そのあとセッションが黙って落ちると作り直す（resume_failed・recovered）。
  // 対照: 拒否が手が動いた印を立てるなら、作り直さず closed で終わる。
  async function resumeThenDeny(
    send: (rig: Rig) => void,
  ): Promise<{ resumeFailed: number; closed: number; sessions: number }> {
    const events: RunnerEvent[] = [];
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => events.push(event),
      queryFn: fn,
      env: DENY_ENV,
    });
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-dead',
      cwd: dir,
      request: '最初の依頼',
      // 素材を 1 件渡す: 空だと作り直さない理由が `#progressed` だと確かめられない
      entries: [{ type: 'user', message: { role: 'user', content: '前回の続き' } }],
    });
    const first = await vi.waitFor(() => {
      const found = started[0];
      if (found === undefined) throw new Error('セッションがまだ開いていない');
      return found;
    });
    send({ started: first, events, host, clock: fakeClock(0) });
    await tick();
    first.finish();
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === 'resume_failed' || e.type === 'closed')) {
        throw new Error('resume_failed も closed もまだ来ていない');
      }
    });
    return {
      resumeFailed: events.filter((e) => e.type === 'resume_failed').length,
      closed: events.filter((e) => e.type === 'closed').length,
      sessions: started.length,
    };
  }

  it('live の拒否だけを受けても、セッションが落ちれば作り直す（手が動いた印を立てない）', async () => {
    expect(await resumeThenDeny((rig) => live(rig, { tool_name: 'Bash', tool_use_id: 'tu-p1' })))
      .toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });

  it('失敗した result の拒否だけを受けても、作り直す（result 経由）', async () => {
    expect(
      await resumeThenDeny((rig) =>
        rig.started.push({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['boom'],
          session_id: 'sess-mgr',
          uuid: 'uuid-result-fail',
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 'tu-p2' }],
        } as unknown as SDKMessage),
      ),
    ).toMatchInlineSnapshot(`
      {
        "closed": 0,
        "resumeFailed": 1,
        "sessions": 2,
      }
    `);
  });
});

describe('出来事が出る周回（同期のまま保つ）', () => {
  async function ticksUntil(rig: Rig, count: number): Promise<{ ticks: number; seen: number }> {
    let ticks = 0;
    while (deniedOf(rig.events).length < count && ticks < 500) {
      await Promise.resolve();
      ticks += 1;
    }
    return { ticks, seen: deniedOf(rig.events).length };
  }

  it('live: 合図を押してから permission_denied が出るまでの周回数。result: 複数の拒否は同じ周回で全部出る', async () => {
    const rigLive = await open();
    live(rigLive, { tool_name: 'Read', tool_use_id: 'tu-tick-live' });
    const liveTicks = await ticksUntil(rigLive, 1);
    await host?.shutdown().catch(() => undefined);

    const rigResult = await open();
    result(rigResult, [
      { tool_name: 'Read', tool_use_id: 'tu-tick-1' },
      { tool_name: 'Read', tool_use_id: 'tu-tick-2' },
      { tool_name: 'Read', tool_use_id: 'tu-tick-3' },
    ]);
    const first = await ticksUntil(rigResult, 1);
    // 最初の 1 件が見えた周回に、残りも出ている（`for` の中に `await` が挟まらない）
    const visibleAtFirst = deniedOf(rigResult.events).length;
    expect({ live: liveTicks, resultFirst: first, visibleAtFirst }).toMatchInlineSnapshot(`
      {
        "live": {
          "seen": 1,
          "ticks": 3,
        },
        "resultFirst": {
          "seen": 3,
          "ticks": 4,
        },
        "visibleAtFirst": 3,
      }
    `);
  });

  // 順序の歯（#6630 のレビューの指摘）: 複数の拒否は届いた順に 1 件ずつ決着する。期待の値は今の作りの出力から生成して目で読んで確かめた
  it('result: 複数の拒否の permission_denied は届いた順に出る', async () => {
    const rig = await open();
    result(rig, [
      { tool_name: 'Read', tool_use_id: 'tu-ord-1' },
      { tool_name: 'Bash', tool_use_id: 'tu-ord-2' },
      { tool_name: 'Read', tool_use_id: 'tu-ord-3' },
    ]);
    await ticksUntil(rig, 3);
    expect(deniedOf(rig.events).map((event) => event.toolUseId)).toMatchInlineSnapshot(`
      [
        "tu-ord-1",
        "tu-ord-2",
        "tu-ord-3",
      ]
    `);
  });
});

describe('同期で投げたときの伝わり方', () => {
  // 投げたあとは、セッションの受信ループが止まり、次の合図（live）も処理されない（投げ方は元のまま呼び元へ届く）
  it('result の 1 件目の permission_denied の emit が投げると、`for` が止まり 2 件目は決着しない', async () => {
    const rig = await open({ throwOn: throwOnce((event) => event.type === 'permission_denied') });
    result(rig, [
      { tool_name: 'Read', tool_use_id: 'tu-th-1' },
      { tool_name: 'Read', tool_use_id: 'tu-th-2' },
    ]);
    await tick();
    const afterThrow = view(rig.events);
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-th-1' });
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-th-2' });
    await tick();
    expect({ afterThrow, afterFollowUp: view(rig.events).slice(afterThrow.length) })
      .toMatchInlineSnapshot(`
        {
          "afterFollowUp": [],
          "afterThrow": [
            {
              "input": undefined,
              "managerId": "mgr-1",
              "tool": "Read",
              "toolUseId": "tu-th-1",
              "type": "permission_denied",
              "via": "result",
            },
          ],
        }
      `);
  });

  it('1 回だけの許可の note が投げると、permission_denied は降りず、2 件目は決着しない（一時規則の note は先に出ている）', async () => {
    const rig = await open({
      throwOn: throwOnce(
        (event) =>
          event.type === 'note' && event.text.startsWith('1回だけの許可（issue #1105 P1、'),
      ),
    });
    await allowedRetryFor(rig, 'tu-f1', 'tu-f2');
    rig.events.length = 0;
    result(rig, [
      { tool_name: 'Bash', tool_use_id: 'tu-f2' },
      { tool_name: 'Bash', tool_use_id: 'tu-f3' },
    ]);
    await tick();
    const afterThrow = view(rig.events);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-f2' });
    await tick();
    expect({ afterThrow, afterFollowUp: view(rig.events).slice(afterThrow.length) })
      .toMatchInlineSnapshot(`
      {
        "afterFollowUp": [],
        "afterThrow": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: result）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo th",
          "note: 1回だけの許可（issue #1105 P1、manager:mgr-1・Bash）で allow を返した呼び出しが、それでも拒否された（合図の出所: result）。分類器がこの allow を分類器へ回した（リモートの機能フラグ）か、deny 規則が上書きしたかのどちらか（あるいは両方）で、alteroid 側からは切り分けられない。この許可はいまは効いていない可能性がある。分類器が迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさないため、同じ入力の撃ち直しは通らないことがある。同じ呼び出しへの確認は重ねて上げない（#4904）。",
        ],
      }
    `);
  });

  it('一時規則の決着の note が投げると、1 回だけの許可の note も permission_denied も出ず、2 件目は決着しない', async () => {
    const rig = await open({
      throwOn: throwOnce(
        (event) => event.type === 'note' && event.text.startsWith('一時規則（担当'),
      ),
    });
    await allowedRetryFor(rig, 'tu-g1', 'tu-g2');
    rig.events.length = 0;
    result(rig, [
      { tool_name: 'Bash', tool_use_id: 'tu-g2' },
      { tool_name: 'Bash', tool_use_id: 'tu-g3' },
    ]);
    await tick();
    const afterThrow = view(rig.events);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-g2' });
    await tick();
    expect({ afterThrow, afterFollowUp: view(rig.events).slice(afterThrow.length) })
      .toMatchInlineSnapshot(`
      {
        "afterFollowUp": [],
        "afterThrow": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: result）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo th",
        ],
      }
    `);
  });

  it('入力の形の note が投げると、2 件目は決着しない（live が先に降りているので permission_denied は新しく降りない）', async () => {
    const rig = await open({
      throwOn: throwOnce((event) => event.type === 'note' && event.text.startsWith('先に降ろした')),
    });
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-s1' });
    await tick();
    result(rig, [
      { tool_name: 'Bash', tool_use_id: 'tu-s1', tool_input: { command: 'ls' } },
      { tool_name: 'Bash', tool_use_id: 'tu-s2' },
    ]);
    await tick();
    const afterThrow = view(rig.events);
    result(rig, [{ tool_name: 'Bash', tool_use_id: 'tu-s1', tool_input: { command: 'ls' } }]);
    live(rig, { tool_name: 'Bash', tool_use_id: 'tu-s2' });
    await tick();
    expect({ afterThrow, afterFollowUp: view(rig.events).slice(afterThrow.length) })
      .toMatchInlineSnapshot(`
        {
          "afterFollowUp": [],
          "afterThrow": [
            {
              "actor": "manager:mgr-1",
              "input": undefined,
              "managerId": "mgr-1",
              "tool": "Bash",
              "toolUseId": "tu-s1",
              "type": "permission_denied",
              "via": "live",
            },
            "note: 先に降ろした Bash の拒否について、ターン終わりの記録（via: result）に入力が載っていた。値には鍵が入りうるので本文は残さず、形だけ残す: 欄=command / 先頭の語=ls / chars=16",
          ],
        }
      `);
  });

  it('live の経路で emit が投げると、次の合図は処理されない（投げ方は元のまま `#apply` の拒否として届く）', async () => {
    const rig = await open({ throwOn: throwOnce((event) => event.type === 'permission_denied') });
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-l1' });
    await tick();
    live(rig, { tool_name: 'Read', tool_use_id: 'tu-l2' });
    await tick();
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "actor": "manager:mgr-1",
          "input": undefined,
          "managerId": "mgr-1",
          "tool": "Read",
          "toolUseId": "tu-l1",
          "type": "permission_denied",
          "via": "live",
        },
      ]
    `);
  });
});
