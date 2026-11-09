import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import type { AgentChildProcess } from './agent-session.js';
import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession#queueRequest`（確認を積み、`ask` を出し、決着を待つ形。`#onPermission` と `#onPermissionDenied` が共有する）を、
// 外から見える結果だけで縛る。入口は SDK の `canUseTool`（確認）と `PermissionDenied` フック（1 回だけの許可）、答えは `host.answer()`。
// 見るのは: `ask`・`settled` の欄と順・各出来事の時点の status・`state().waiting`（`#pending` の順）・`canUseTool` / フックの戻り値・
// 同じ id の再送で返る値（`#resolved` の中身）・中断のリスナーの付け外し・出来事が出る周回・emit が同期で投げたときの伝わり方。
// 期待の文字列・欄・周回数は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（待つのはマイクロタスクの周回と、回数の上限つきの `setTimeout(0)` の周回だけ。時計は `Date` の差し替え）。
//
// 各枝が縛る、`runner.ts` の元のコメントの意図:
// - 「`ask` を中断の確かめより先に出す（#4772）」 → 『中断済みの signal』（ask → settled の順）
// - 「`withdrawn` を型から落とさない」 → 『畳みで解けた確認』（`settled.withdrawn.reason`・フックは no-retry で note を足さない）
// - 「`decideAnswer` の呼び出しを変えない」 → 『答えの写像』（allow・deny・読めない答え）
// - 「畳む・中断の経路では `question` も deny で返す」 → 『question の畳み・中断』
// - 「teardown 側を `unreadable` の対象外にする」 → 外からは作れない（末尾の注）
// - 「解けたことを覚えるのはここ 1 箇所」 → 『同じ id の再送』（resolved から返り、新しい ask が出ない）
// - 「待ち行列から自分を外すのは settle の責任」 → 『#pending の順』・『中断で解けた 1 件が行列に残らない』
// - 「確認待ちの間に溜めた peer の知らせを届ける」 → 『peer の知らせ』

const NOW = '2026-10-20T00:00:00.000Z';

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
  dir = makeTempDirSync('alteroid-runner-queue-request-pin-');
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

/** 条件が成り立つまで、回数の上限つきで `setTimeout(0)` を回す（実 I/O を待つ箇所用。実時間の締め切りは足さない）。 */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !condition(); i += 1) await tick();
}

/** マイクロタスクの周回だけで、条件が成り立つまでの周回数を数える（イベントループへ制御を返さない）。 */
async function lapsUntil(condition: () => boolean, max = 40): Promise<number> {
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
  /** 出来事ごとに `種類:その時点の status` を積む（status の変わる順を見る）。 */
  trace: string[];
  host: RunnerHost;
}

type Ask = Extract<RunnerEvent, { type: 'ask' }>;
type Settled = Extract<RunnerEvent, { type: 'settled' }>;
const asksOf = (events: readonly RunnerEvent[]): Ask[] =>
  events.filter((event): event is Ask => event.type === 'ask');
const settledOf = (events: readonly RunnerEvent[]): Settled[] =>
  events.filter((event): event is Settled => event.type === 'settled');

async function open(
  options: { throwOn?: (event: RunnerEvent) => boolean } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const trace: string[] = [];
  const { fn, started } = fakeRunnerSdk();
  let thrown = false;
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (event.type === 'ask' || event.type === 'settled') {
        trace.push(`${event.type}:${host?.list()[0]?.status ?? '?'}`);
      }
      if (!thrown && options.throwOn?.(event) === true) {
        thrown = true;
        throw new Error('emit が落ちた（テスト用）');
      }
    },
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  trace.length = 0;
  return { started: first, events, trace, host };
}

const statusOf = (rig: Rig): string | undefined => rig.host.list()[0]?.status;
const waitingIds = (rig: Rig): string[] =>
  (rig.host.list()[0]?.waiting ?? []).map((entry) => entry.requestId);

interface Called {
  /** 決着したか（解けても拒否されても）。 */
  done: () => boolean;
  /** 解けた値（まだ・拒否なら undefined）。 */
  value: () => unknown;
  /** 拒否の理由（まだ・解けたなら undefined）。 */
  error: () => unknown;
}

function track(promise: Promise<unknown>): Called {
  let done = false;
  let value: unknown;
  let error: unknown;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e: unknown) => {
      done = true;
      error = e;
    },
  );
  return { done: () => done, value: () => value, error: () => error };
}

function canUse(
  rig: Rig,
  toolName: string,
  input: Record<string, unknown>,
  extra: {
    requestId?: string;
    signal?: AbortSignal;
    decisionReason?: string;
    agentID?: string;
  } = {},
): Called {
  const canUseTool = rig.started.options.canUseTool;
  if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
  return track(
    canUseTool(toolName, input, {
      signal: extra.signal ?? new AbortController().signal,
      toolUseID: `tu-${extra.requestId ?? 'none'}`,
      ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }),
      ...(extra.decisionReason === undefined ? {} : { decisionReason: extra.decisionReason }),
      ...(extra.agentID === undefined ? {} : { agentID: extra.agentID }),
    } as never),
  );
}

const BASH = { command: 'echo hi' };

function hook(
  rig: Rig,
  toolUseId: string,
  options: { signal?: AbortSignal; reason?: string } = {},
): Called & { raw: Promise<HookJSONOutput> } {
  const fn = rig.started.options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (fn === undefined) throw new Error('PermissionDenied フックが登録されていない');
  const raw = fn(
    {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: BASH,
      tool_use_id: toolUseId,
      reason: options.reason ?? '分類器が拒否した（テスト）',
    } as never,
    undefined,
    { signal: options.signal ?? new AbortController().signal },
  );
  return { ...track(raw), raw };
}

const noteTexts = (events: readonly RunnerEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'note' ? [event.text] : []));

describe('ask の全欄', () => {
  it('permission: kind・summary（理由つき）・askedAt。source は欄ごと無い。status は ask の時点で waiting_human', async () => {
    const rig = await open();
    canUse(rig, 'Bash', BASH, { requestId: 'req-1', decisionReason: '危ない操作' });
    expect(asksOf(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "askedAt": "2026-10-20T00:00:00.000Z",
          "kind": "permission",
          "managerId": "mgr-1",
          "requestId": "req-1",
          "sessionGeneration": "a7889d79-9870-432f-91bf-c80b66fa2969",
          "summary": "Bash の実行許可: {"command":"echo hi"}
      理由: 危ない操作",
          "type": "ask",
        },
      ]
    `);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "ask:waiting_human",
      ]
    `);
    expect(Object.keys(asksOf(rig.events)[0] ?? {})).toMatchInlineSnapshot(`
      [
        "type",
        "managerId",
        "requestId",
        "kind",
        "summary",
        "askedAt",
        "sessionGeneration",
      ]
    `);
    expect(rig.host.list()[0]?.waiting).toMatchInlineSnapshot(`
      [
        {
          "askedAt": "2026-10-20T00:00:00.000Z",
          "kind": "permission",
          "requestId": "req-1",
          "summary": "Bash の実行許可: {"command":"echo hi"}
      理由: 危ない操作",
        },
      ]
    `);
  });

  it('permission・理由なし: summary に理由の行が付かない', async () => {
    const rig = await open();
    canUse(rig, 'Read', { file_path: '/tmp/a' }, { requestId: 'req-2' });
    expect(asksOf(rig.events).map((ask) => ask.summary)).toMatchInlineSnapshot(`
      [
        "Read の実行許可: {"file_path":"/tmp/a"}",
      ]
    `);
  });

  it('question: AskUserQuestion は kind が question で、summary は問いの全文', async () => {
    const rig = await open();
    canUse(
      rig,
      'AskUserQuestion',
      { questions: [{ question: 'どちらにする？', options: [{ label: 'A' }, { label: 'B' }] }] },
      { requestId: 'req-q' },
    );
    expect(asksOf(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "askedAt": "2026-10-20T00:00:00.000Z",
          "kind": "question",
          "managerId": "mgr-1",
          "requestId": "req-q",
          "sessionGeneration": "4a93f96d-5ad7-490f-a682-0a48cb810122",
          "summary": "どちらにする？
      - **A**
      - **B**",
          "type": "ask",
        },
      ]
    `);
  });

  it('PermissionDenied フック: kind は permission、input は空。source は無い', async () => {
    const rig = await open();
    hook(rig, 'tu-hook-1');
    expect(asksOf(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "askedAt": "2026-10-20T00:00:00.000Z",
          "kind": "permission",
          "managerId": "mgr-1",
          "requestId": "tu-hook-1",
          "sessionGeneration": "64b81b46-f628-4cf6-894a-35b486afd71b",
          "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
          "type": "ask",
        },
      ]
    `);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "ask:waiting_human",
      ]
    `);
  });
});

describe('#pending の順と status', () => {
  it('3 件を積み、真ん中から答えると順を保って外れる。waiting_human は最後の 1 件が決着するまで続き、そのあと running に戻る', async () => {
    const rig = await open();
    canUse(rig, 'Bash', BASH, { requestId: 'a' });
    canUse(rig, 'Bash', BASH, { requestId: 'b' });
    canUse(rig, 'Bash', BASH, { requestId: 'c' });
    const seen: unknown[] = [{ waiting: waitingIds(rig), status: statusOf(rig) }];
    await rig.host.answer('mgr-1', { requestId: 'b', message: 'ok', decision: 'allow' });
    seen.push({ waiting: waitingIds(rig), status: statusOf(rig) });
    await rig.host.answer('mgr-1', { requestId: 'a', message: 'ok', decision: 'allow' });
    seen.push({ waiting: waitingIds(rig), status: statusOf(rig) });
    await rig.host.answer('mgr-1', { requestId: 'c', message: 'ok', decision: 'allow' });
    seen.push({ waiting: waitingIds(rig), status: statusOf(rig) });
    expect(seen).toMatchInlineSnapshot(`
      [
        {
          "status": "waiting_human",
          "waiting": [
            "a",
            "b",
            "c",
          ],
        },
        {
          "status": "waiting_human",
          "waiting": [
            "a",
            "c",
          ],
        },
        {
          "status": "waiting_human",
          "waiting": [
            "c",
          ],
        },
        {
          "status": "running",
          "waiting": [],
        },
      ]
    `);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "ask:waiting_human",
        "ask:waiting_human",
        "ask:waiting_human",
        "settled:waiting_human",
        "settled:waiting_human",
        "settled:running",
      ]
    `);
  });

  it('答えの宛先が無ければ delivered: false で、何も出ない', async () => {
    const rig = await open();
    canUse(rig, 'Bash', BASH, { requestId: 'a' });
    const outcome = await rig.host.answer('mgr-1', { requestId: 'zzz', message: 'ok' });
    expect({ outcome, settled: settledOf(rig.events).length }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "delivered": false,
        },
        "settled": 0,
      }
    `);
  });
});

describe('答えの写像（result）', () => {
  async function answerWith(
    answer: { message: string; decision?: 'allow' | 'deny' },
    toolName = 'Bash',
    input: Record<string, unknown> = BASH,
  ) {
    const rig = await open();
    const called = canUse(rig, toolName, input, { requestId: 'r' });
    const outcome = await rig.host.answer('mgr-1', { requestId: 'r', ...answer });
    await until(called.done);
    return { rig, outcome, value: called.value() };
  }

  it('allow: 明示の decision', async () => {
    const { outcome, value } = await answerWith({ message: 'どうぞ', decision: 'allow' });
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "allow",
          "delivered": true,
        },
        "value": {
          "behavior": "allow",
        },
      }
    `);
  });

  it('deny: 明示の decision。message が拒否の理由として返る', async () => {
    const { outcome, value } = await answerWith({ message: 'だめ', decision: 'deny' });
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "deny",
          "delivered": true,
        },
        "value": {
          "behavior": "deny",
          "message": "だめ",
        },
      }
    `);
  });

  it('decision が無く、文面から allow と読める答え', async () => {
    const { outcome, value } = await answerWith({ message: '承認します' });
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "allow",
          "delivered": true,
        },
        "value": {
          "behavior": "allow",
        },
      }
    `);
  });

  it('decision が無く、文面から deny と読める答え', async () => {
    const { outcome, value } = await answerWith({ message: '拒否する' });
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "deny",
          "delivered": true,
        },
        "value": {
          "behavior": "deny",
          "message": "拒否する",
        },
      }
    `);
  });

  it('decision が無く、読めない答え: 安全側で deny し、unreadable の文言を前置きする。answer() の戻りは unreadable', async () => {
    const { outcome, value } = await answerWith({ message: 'うーん' });
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "unreadable",
          "delivered": true,
        },
        "value": {
          "behavior": "deny",
          "message": "[decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] うーん

      許可するときは decision: 'allow' を明示して答え直すこと。",
        },
      }
    `);
  });

  it('question: decision が deny でも allow で返り、updatedInput に withAnswers（問いごとの答え）が載る', async () => {
    const { outcome, value } = await answerWith(
      { message: '右', decision: 'deny' },
      'AskUserQuestion',
      { questions: [{ question: 'どっち？' }, { question: 3 }, { header: '問い無し' }], extra: 1 },
    );
    expect({ outcome, value }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "allow",
          "delivered": true,
        },
        "value": {
          "behavior": "allow",
          "updatedInput": {
            "answers": {
              "どっち？": "右",
            },
            "extra": 1,
            "questions": [
              {
                "question": "どっち？",
              },
              {
                "question": 3,
              },
              {
                "header": "問い無し",
              },
            ],
          },
        },
      }
    `);
  });

  it('question: questions が配列でなければ answers は空で、入力の他の欄は残る', async () => {
    const { value } = await answerWith({ message: '右' }, 'AskUserQuestion', {
      questions: 'x',
      keep: true,
    });
    expect(value).toMatchInlineSnapshot(`
      {
        "behavior": "allow",
        "updatedInput": {
          "answers": {},
          "keep": true,
          "questions": "x",
        },
      }
    `);
  });

  it('PermissionDenied フック: allow → retry、deny → no-retry、読めない答え → no-retry', async () => {
    const results: unknown[] = [];
    for (const answer of [
      { message: 'どうぞ', decision: 'allow' as const },
      { message: 'だめ', decision: 'deny' as const },
      { message: 'うーん' },
    ]) {
      const rig = await open();
      const called = hook(rig, 'tu-h');
      await rig.host.answer('mgr-1', { requestId: 'tu-h', ...answer });
      await until(called.done);
      results.push(called.value());
      await rig.host.shutdown();
      host = undefined;
    }
    expect(results).toMatchInlineSnapshot(`
      [
        {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        {
          "continue": true,
        },
        {
          "continue": true,
        },
      ]
    `);
  });
});

describe('同じ id の再送（#resolved）', () => {
  it('待っている間の再送は新しい ask を出さず、同じ結果を返す。解けた後の再送も同じ値で、ask は増えない', async () => {
    const rig = await open();
    const first = canUse(rig, 'Bash', BASH, { requestId: 'dup' });
    const again = canUse(rig, 'Bash', BASH, { requestId: 'dup' });
    await rig.host.answer('mgr-1', { requestId: 'dup', message: 'だめ', decision: 'deny' });
    await until(() => first.done() && again.done());
    const later = canUse(rig, 'Bash', BASH, { requestId: 'dup' });
    await until(later.done);
    expect({
      first: first.value(),
      again: again.value(),
      later: later.value(),
      asks: asksOf(rig.events).length,
      settled: settledOf(rig.events).length,
    }).toMatchInlineSnapshot(`
      {
        "again": {
          "behavior": "deny",
          "message": "だめ",
        },
        "asks": 1,
        "first": {
          "behavior": "deny",
          "message": "だめ",
        },
        "later": {
          "behavior": "deny",
          "message": "だめ",
        },
        "settled": 1,
      }
    `);
  });

  it('question の解けた結果（updatedInput つき）が、再送でもそのまま返る', async () => {
    const rig = await open();
    const input = { questions: [{ question: 'どっち？' }] };
    const first = canUse(rig, 'AskUserQuestion', input, { requestId: 'q-dup' });
    await rig.host.answer('mgr-1', { requestId: 'q-dup', message: '右' });
    await until(first.done);
    const later = canUse(rig, 'AskUserQuestion', input, { requestId: 'q-dup' });
    await until(later.done);
    expect(later.value()).toEqual(first.value());
    expect(later.value()).toMatchInlineSnapshot(`
      {
        "behavior": "allow",
        "updatedInput": {
          "answers": {
            "どっち？": "右",
          },
          "questions": [
            {
              "question": "どっち？",
            },
          ],
        },
      }
    `);
  });

  it('中断で解けた確認の結果も覚える（再送は中断の文言を返し、ask は増えない）', async () => {
    const rig = await open();
    const controller = new AbortController();
    const first = canUse(rig, 'Bash', BASH, { requestId: 'ab', signal: controller.signal });
    controller.abort();
    await until(first.done);
    const later = canUse(rig, 'Bash', BASH, { requestId: 'ab' });
    await until(later.done);
    expect({ later: later.value(), asks: asksOf(rig.events).length }).toMatchInlineSnapshot(`
      {
        "asks": 1,
        "later": {
          "behavior": "deny",
          "message": "マネージャー側で中断された。",
        },
      }
    `);
  });

  it('PermissionDenied フックの再送は、解けた結果から retry / no-retry を返す', async () => {
    const rig = await open();
    const first = hook(rig, 'tu-re');
    await rig.host.answer('mgr-1', { requestId: 'tu-re', message: 'どうぞ', decision: 'allow' });
    await until(first.done);
    const again = hook(rig, 'tu-re');
    await until(again.done);
    expect({
      first: first.value(),
      again: again.value(),
      asks: asksOf(rig.events).length,
    }).toMatchInlineSnapshot(`
      {
        "again": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "asks": 1,
        "first": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
      }
    `);
  });
});

describe('settle（settled の欄・畳み）', () => {
  it('答えで解けた確認: settled は requestId だけ（withdrawn が無い）。status はその時点で running', async () => {
    const rig = await open();
    canUse(rig, 'Bash', BASH, { requestId: 's1' });
    await rig.host.answer('mgr-1', { requestId: 's1', message: 'ok', decision: 'allow' });
    expect(settledOf(rig.events)).toMatchInlineSnapshot(`
      [
        {
          "managerId": "mgr-1",
          "requestId": "s1",
          "sessionGeneration": "a44181f6-956e-4ae0-8b5c-6034782911e2",
          "type": "settled",
        },
      ]
    `);
    expect(rig.trace).toMatchInlineSnapshot(`
      [
        "ask:waiting_human",
        "settled:running",
      ]
    `);
  });

  it('畳み（stop）で解けた確認: settled.withdrawn.reason が載り、permission は deny、question も deny で返る', async () => {
    const rig = await open();
    const perm = canUse(rig, 'Bash', BASH, { requestId: 'w1' });
    const question = canUse(
      rig,
      'AskUserQuestion',
      { questions: [{ question: 'どっち？' }] },
      { requestId: 'w2' },
    );
    await rig.host.stop('mgr-1');
    await until(() => perm.done() && question.done());
    expect({
      settled: settledOf(rig.events),
      perm: perm.value(),
      question: question.value(),
    }).toMatchInlineSnapshot(`
      {
        "perm": {
          "behavior": "deny",
          "message": "デーモンから停止を指示された。",
        },
        "question": {
          "behavior": "deny",
          "message": "デーモンから停止を指示された。",
        },
        "settled": [
          {
            "managerId": "mgr-1",
            "requestId": "w1",
            "sessionGeneration": "5d9435e4-1bee-4ee1-89f8-9edc72940292",
            "type": "settled",
            "withdrawn": {
              "reason": "デーモンから停止を指示された。",
            },
          },
          {
            "managerId": "mgr-1",
            "requestId": "w2",
            "sessionGeneration": "5d9435e4-1bee-4ee1-89f8-9edc72940292",
            "type": "settled",
            "withdrawn": {
              "reason": "デーモンから停止を指示された。",
            },
          },
        ],
      }
    `);
  });

  it('畳みで解けた PermissionDenied フックは no-retry で、クローンの判断の note を足さない', async () => {
    const rig = await open();
    const called = hook(rig, 'tu-w');
    await rig.host.stop('mgr-1');
    await until(called.done);
    expect({
      value: called.value(),
      settled: settledOf(rig.events),
      judged: noteTexts(rig.events).filter((text) => text.includes('クローンが分類器の拒否')),
      timedOut: noteTexts(rig.events).filter((text) => text.includes('持ち時間切れ')),
    }).toMatchInlineSnapshot(`
      {
        "judged": [],
        "settled": [
          {
            "managerId": "mgr-1",
            "requestId": "tu-w",
            "sessionGeneration": "702495f4-b858-4f88-9ffd-d9e67cbbee10",
            "type": "settled",
            "withdrawn": {
              "reason": "デーモンから停止を指示された。",
            },
          },
        ],
        "timedOut": [],
        "value": {
          "continue": true,
        },
      }
    `);
  });
});

describe('中断（signal）', () => {
  it('あとから中断: settled（withdrawn なし）・deny の中断の文言・question でも deny・status は running に戻る', async () => {
    const rig = await open();
    const controller = new AbortController();
    const questionController = new AbortController();
    const perm = canUse(rig, 'Bash', BASH, { requestId: 'p1', signal: controller.signal });
    const question = canUse(
      rig,
      'AskUserQuestion',
      { questions: [{ question: 'どっち？' }] },
      { requestId: 'p2', signal: questionController.signal },
    );
    controller.abort();
    expect({ status: statusOf(rig), waiting: waitingIds(rig) }).toMatchInlineSnapshot(`
      {
        "status": "waiting_human",
        "waiting": [
          "p2",
        ],
      }
    `);
    questionController.abort();
    await until(() => perm.done() && question.done());
    expect({
      status: statusOf(rig),
      waiting: waitingIds(rig),
      settled: settledOf(rig.events),
      perm: perm.value(),
      question: question.value(),
      trace: rig.trace,
    }).toMatchInlineSnapshot(`
      {
        "perm": {
          "behavior": "deny",
          "message": "マネージャー側で中断された。",
        },
        "question": {
          "behavior": "deny",
          "message": "マネージャー側で中断された。",
        },
        "settled": [
          {
            "managerId": "mgr-1",
            "requestId": "p1",
            "sessionGeneration": "590a7cf4-6d7f-4f08-b5ef-b6ebcb11123a",
            "type": "settled",
          },
          {
            "managerId": "mgr-1",
            "requestId": "p2",
            "sessionGeneration": "590a7cf4-6d7f-4f08-b5ef-b6ebcb11123a",
            "type": "settled",
          },
        ],
        "status": "running",
        "trace": [
          "ask:waiting_human",
          "ask:waiting_human",
          "settled:waiting_human",
          "settled:running",
        ],
        "waiting": [],
      }
    `);
  });

  it('すでに中断済み: ask が先に出てから settled（#4772）。リスナーは付けない', async () => {
    const rig = await open();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const called = canUse(rig, 'Bash', BASH, { requestId: 'pre', signal: controller.signal });
    await until(called.done);
    expect({
      order: rig.events.map((event) => event.type),
      trace: rig.trace,
      addCalls: add.mock.calls.length,
      value: called.value(),
      status: statusOf(rig),
    }).toMatchInlineSnapshot(`
      {
        "addCalls": 0,
        "order": [
          "session",
          "ask",
          "settled",
        ],
        "status": "running",
        "trace": [
          "ask:waiting_human",
          "settled:running",
        ],
        "value": {
          "behavior": "deny",
          "message": "マネージャー側で中断された。",
        },
      }
    `);
  });

  it('リスナーは once で付け、答えで解けたら外す（外さないと、後からの中断で onAbort が走る）', async () => {
    const rig = await open();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    canUse(rig, 'Bash', BASH, { requestId: 'l1', signal: controller.signal });
    const added = add.mock.calls.map((call) => [call[0], call[2]]);
    await rig.host.answer('mgr-1', { requestId: 'l1', message: 'ok', decision: 'allow' });
    expect({
      added,
      removed: remove.mock.calls.map((call) => call[0]),
      sameListener: remove.mock.calls[0]?.[1] === add.mock.calls[0]?.[1],
    }).toMatchInlineSnapshot(`
      {
        "added": [
          [
            "abort",
            {
              "once": true,
            },
          ],
        ],
        "removed": [
          "abort",
        ],
        "sameListener": true,
      }
    `);
  });

  it('PermissionDenied フック: 答えの直後に（同じ周回で）中断されても、持ち時間切れにならず retry が返る', async () => {
    const rig = await open();
    const controller = new AbortController();
    const called = hook(rig, 'tu-late', { signal: controller.signal });
    await rig.host.answer('mgr-1', { requestId: 'tu-late', message: 'どうぞ', decision: 'allow' });
    controller.abort();
    await until(called.done);
    expect({
      value: called.value(),
      timedOut: noteTexts(rig.events).filter((text) => text.includes('持ち時間切れ')),
      settled: settledOf(rig.events).length,
    }).toMatchInlineSnapshot(`
      {
        "settled": 1,
        "timedOut": [],
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
      }
    `);
  });

  it('PermissionDenied フック: 持ち時間切れ（中断）は onAbort で印が立ち、note が出て no-retry。記憶される結果はフック用の中断の文言（canUseTool とは別）', async () => {
    const rig = await open();
    const controller = new AbortController();
    const called = hook(rig, 'tu-abort', { signal: controller.signal });
    controller.abort();
    await until(called.done);
    const recalled = canUse(rig, 'Bash', BASH, { requestId: 'tu-abort' });
    await until(recalled.done);
    expect({
      value: called.value(),
      notes: noteTexts(rig.events).filter((text) => text.includes('持ち時間切れ')),
      settled: settledOf(rig.events),
      remembered: recalled.value(),
    }).toMatchInlineSnapshot(`
      {
        "notes": [
          "分類器の拒否（manager:mgr-1・Bash）への1回だけの許可の確認が、フックの持ち時間切れで終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので反映しない（issue #1105 P1）。",
        ],
        "remembered": {
          "behavior": "deny",
          "message": "フックの持ち時間が尽きたので、安全側でこの1回だけの許可は出さない。",
        },
        "settled": [
          {
            "managerId": "mgr-1",
            "requestId": "tu-abort",
            "sessionGeneration": "1178cff0-59f6-41f2-9d67-352862dfc44c",
            "type": "settled",
          },
        ],
        "value": {
          "continue": true,
        },
      }
    `);
  });

  it('PermissionDenied フックの中断済み signal: ask が先に出て、そのあと settled', async () => {
    const rig = await open();
    const controller = new AbortController();
    controller.abort();
    const called = hook(rig, 'tu-pre', { signal: controller.signal });
    await until(called.done);
    expect({ order: rig.events.filter((e) => e.type === 'ask' || e.type === 'settled').map((e) => e.type), value: called.value() }).toMatchInlineSnapshot(`
      {
        "order": [
          "ask",
          "settled",
        ],
        "value": {
          "continue": true,
        },
      }
    `);
  });
});

describe('周回数（マイクロタスク）', () => {
  it('canUseTool を呼んだ周回で ask が見え、答えた周回で settled が見える。canUseTool の結果が解けるまでの周回を固定する', async () => {
    const rig = await open();
    const called = canUse(rig, 'Bash', BASH, { requestId: 'lap' });
    const askLaps = await lapsUntil(() => asksOf(rig.events).length > 0);
    const answering = rig.host.answer('mgr-1', { requestId: 'lap', message: 'ok', decision: 'allow' });
    const settledLaps = await lapsUntil(() => settledOf(rig.events).length > 0);
    const resultLaps = await lapsUntil(called.done);
    await answering;
    expect({ askLaps, settledLaps, resultLaps }).toMatchInlineSnapshot(`
      {
        "askLaps": 0,
        "resultLaps": 3,
        "settledLaps": 0,
      }
    `);
  });

  it('PermissionDenied フック: ask が見える周回と、答えてからフックが解ける周回（answered → result の 2 段の await）', async () => {
    const rig = await open();
    const called = hook(rig, 'tu-lap');
    const askLaps = await lapsUntil(() => asksOf(rig.events).length > 0);
    const answering = rig.host.answer('mgr-1', { requestId: 'tu-lap', message: 'ok', decision: 'allow' });
    const settledLaps = await lapsUntil(() => settledOf(rig.events).length > 0);
    const hookLaps = await lapsUntil(called.done);
    await answering;
    expect({ askLaps, settledLaps, hookLaps }).toMatchInlineSnapshot(`
      {
        "askLaps": 0,
        "hookLaps": 10,
        "settledLaps": 0,
      }
    `);
  });
});

describe('emit が同期で投げたとき', () => {
  it('ask の emit が投げる: canUseTool が拒否され、確認は #pending に残り（status も waiting_human）、中断のリスナーは付かない', async () => {
    const rig = await open({ throwOn: (event) => event.type === 'ask' });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const called = canUse(rig, 'Bash', BASH, { requestId: 'tx', signal: controller.signal });
    await until(called.done);
    expect({
      rejected: called.error() instanceof Error ? (called.error() as Error).message : null,
      waiting: waitingIds(rig),
      status: statusOf(rig),
      addCalls: add.mock.calls.length,
    }).toMatchInlineSnapshot(`
      {
        "addCalls": 0,
        "rejected": "emit が落ちた（テスト用）",
        "status": "waiting_human",
        "waiting": [
          "tx",
        ],
      }
    `);
    // 残った確認は、答えれば普通に解ける
    const outcome = await rig.host.answer('mgr-1', { requestId: 'tx', message: 'ok', decision: 'allow' });
    expect({ outcome, waiting: waitingIds(rig), status: statusOf(rig) }).toMatchInlineSnapshot(`
      {
        "outcome": {
          "decision": "allow",
          "delivered": true,
        },
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('settled の emit が投げる: answer() が拒否され、確認は外れて status は running、結果は解けないまま。二度目の答えは宛先なし', async () => {
    const rig = await open({ throwOn: (event) => event.type === 'settled' });
    const called = canUse(rig, 'Bash', BASH, { requestId: 'ts' });
    const first = await rig.host
      .answer('mgr-1', { requestId: 'ts', message: 'ok', decision: 'allow' })
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'non-error'),
      );
    for (let i = 0; i < 30; i += 1) await tick();
    const second = await rig.host.answer('mgr-1', { requestId: 'ts', message: 'ok' });
    expect({
      first,
      done: called.done(),
      waiting: waitingIds(rig),
      status: statusOf(rig),
      second,
    }).toMatchInlineSnapshot(`
      {
        "done": false,
        "first": "emit が落ちた（テスト用）",
        "second": {
          "delivered": false,
        },
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('PermissionDenied フックで ask の emit が投げる: フックが拒否される', async () => {
    const rig = await open({ throwOn: (event) => event.type === 'ask' });
    const called = hook(rig, 'tu-tx');
    await until(called.done);
    expect({
      rejected: called.error() instanceof Error ? (called.error() as Error).message : null,
      waiting: waitingIds(rig),
    }).toMatchInlineSnapshot(`
      {
        "rejected": "emit が落ちた（テスト用）",
        "waiting": [
          "tu-tx",
        ],
      }
    `);
  });
});

// --- peer（Codex の app server の偽物）---

type Json = Record<string, unknown>;

function readingQuery(): { fn: typeof sdkQuery; inputs: string[] } {
  const inputs: string[] = [];
  const fn = vi.fn((args: { prompt: AsyncIterable<unknown> }) => {
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    void (async () => {
      for await (const message of args.prompt) inputs.push(JSON.stringify(message));
    })().catch(() => undefined);
    // eslint-disable-next-line require-yield
    async function* generate(): AsyncGenerator<never, void> {
      await closed;
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  });
  return { fn: fn as unknown as typeof sdkQuery, inputs };
}

function approvingAppServer(decisions: unknown[]): AgentChildProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = '';
  const send = (message: Json): void => void stdout.write(`${JSON.stringify(message)}\n`);
  let approvalId: number | undefined;
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, i)) as Json;
      buffer = buffer.slice(i + 1);
      const id = message['id'] as number | undefined;
      const method = message['method'];
      if (typeof method !== 'string') {
        if (id !== undefined && id === approvalId) {
          decisions.push((message['result'] as Json | undefined)?.['decision']);
          send({
            method: 'item/completed',
            params: {
              threadId: 'thr-peer',
              turnId: 'turn-1',
              item: { type: 'agentMessage', id: 'm1', text: '終わった' },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: 'thr-peer', turn: { id: 'turn-1', status: 'completed', items: [] } },
          });
        }
        continue;
      }
      if (id === undefined) continue;
      if (method === 'account/read') {
        send({
          id,
          result: {
            requiresOpenaiAuth: false,
            account: { type: 'chatgpt', email: null, planType: 'plus' },
          },
        });
      } else if (method === 'thread/start') {
        send({
          id,
          result: {
            thread: { id: 'thr-peer', cwd: '/work' },
            model: 'gpt-5',
            approvalPolicy: 'untrusted',
          },
        });
      } else if (method === 'turn/start') {
        send({ id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
        void new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
          approvalId = 900;
          send({
            id: 900,
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thr-peer',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              command: 'rm -rf build',
            },
          });
        });
      } else {
        send({
          id,
          result: { userAgent: 'codex/0.160.0', platformFamily: 'unix', platformOs: 'linux' },
        });
      }
    }
  });
  return Object.assign(emitter, {
    stdin,
    stdout,
    killed: false,
    exitCode: null,
    pid: 7001,
    kill: () => true,
  }) as unknown as AgentChildProcess;
}

async function setupPeer(options: { throwOnSettled?: boolean } = {}) {
  const sdk = readingQuery();
  const events: RunnerEvent[] = [];
  const decisions: unknown[] = [];
  let captured: (() => McpServer) | undefined;
  const peerHost = {
    socketPath: '/run/alteroid/peer/peer.sock',
    register: (factory: () => McpServer) => {
      captured = factory;
      return 'tok-1';
    },
    close: () => undefined,
  };
  let thrown = false;
  const peerRunner = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work',
    emit: (event) => {
      events.push(event);
      if (options.throwOnSettled === true && !thrown && event.type === 'settled') {
        thrown = true;
        throw new Error('emit が落ちた（テスト用）');
      }
    },
    queryFn: sdk.fn,
    env: {},
    childUser: { uid: 1000, gid: 1000 },
    spawnAgentProcessFn: () => approvingAppServer(decisions),
    credentials: createCredentialStore({
      dir: makeTempDirSync('alteroid-runner-queue-request-cred-'),
      seed: {},
    }),
    codexHome: makeTempDirSync('alteroid-runner-queue-request-codex-'),
    peer: {
      openSocket: async () => peerHost,
      reportsUsage: () => true,
      childEntry: '/app/relay.js',
      workdirRoot: makeTempDirSync('alteroid-runner-queue-request-workdir-'),
    },
  });
  host = peerRunner;
  await peerRunner.setCredentials([{ name: 'CODEX_API_KEY', value: 'sk-test' }]);
  await peerRunner.start({ managerId: 'mgr-1', request: 'やって', cwd: '/work' });
  const server = captured!();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(clientSide);
  const first = (await client.callTool({
    name: 'peer_run',
    arguments: { provider: 'codex', prompt: '掃除して' },
  })) as { content: { text: string }[] };
  const approvalId = /approval_id=(appr-[0-9a-f]+)/.exec(first.content[0]?.text ?? '')?.[1];
  const asks = (): Ask[] => asksOf(events);
  const noticeCount = (): number =>
    sdk.inputs.filter((input) => input.includes('alteroid が自動で送った知らせ')).length;
  return { host: peerRunner, client, events, approvalId, asks, noticeCount, decisions };
}

describe('peer の確認（source つきの ask）', () => {
  it('escalate で上がる ask: source・出所の印つきの summary・peer:codex:… の requestId・askedAt の全欄', async () => {
    const s = await setupPeer();
    const pending = s.client.callTool({
      name: 'peer_approve',
      arguments: { approval_id: s.approvalId, decision: 'escalate' },
    });
    await until(() => s.asks().length > 0);
    const [ask] = s.asks();
    expect({
      ...ask,
      requestId: ask?.requestId.replace(/peer:codex:[^:]+:/, 'peer:codex:<session>:'),
    }).toMatchInlineSnapshot(`
      {
        "askedAt": "2026-10-20T00:00:00.000Z",
        "kind": "permission",
        "managerId": "mgr-1",
        "requestId": "peer:codex:<session>:cmd-1",
        "sessionGeneration": "ed1fa898-e981-408c-be6e-1f0a84e496af",
        "source": {
          "provider": "codex",
          "type": "peer",
        },
        "summary": "【peer: codex】commandExecution の実行許可: {"command":"rm -rf build"}",
        "type": "ask",
      }
    `);
    expect(Object.keys(ask ?? {})).toMatchInlineSnapshot(`
      [
        "type",
        "managerId",
        "requestId",
        "kind",
        "summary",
        "askedAt",
        "source",
        "sessionGeneration",
      ]
    `);
    expect(s.host.list()[0]?.status).toBe('waiting_human');
    await s.host.answer('mgr-1', { requestId: ask?.requestId ?? '', message: 'いいよ', decision: 'allow' });
    await pending;
    await until(() => s.host.list()[0]?.status === 'running');
    expect({
      status: s.host.list()[0]?.status,
      settled: settledOf(s.events).map((event) => event.requestId.replace(/peer:codex:[^:]+:/, 'peer:codex:<session>:')),
      decisions: s.decisions,
    }).toMatchInlineSnapshot(`
      {
        "decisions": [
          "accept",
        ],
        "settled": [
          "peer:codex:<session>:cmd-1",
        ],
        "status": "running",
      }
    `);
    await s.client.close();
  });
});

describe('peer の知らせ（確認待ちの間に溜め、決着の後に届ける）', () => {
  async function waitingWithBufferedNotice(options: { throwOnSettled?: boolean } = {}) {
    const s = await setupPeer(options);
    await s.client.callTool({
      name: 'peer_approve',
      arguments: { approval_id: s.approvalId, decision: 'escalate', run_in_background: true },
    });
    await until(() => s.asks().length > 0);
    await s.client.callTool({
      name: 'peer_run',
      arguments: { provider: 'codex', prompt: 'B', run_in_background: true },
    });
    await until(() =>
      s.events.some((e) => e.type === 'note' && e.text.includes('確認待ちで止まった')),
    );
    return s;
  }

  it('溜めた知らせは、確認が決着するまで届かず、決着の後に届く', async () => {
    const s = await waitingWithBufferedNotice();
    for (let i = 0; i < 20; i += 1) await tick();
    const before = s.noticeCount();
    await s.host.answer('mgr-1', { requestId: s.asks()[0]?.requestId ?? '', message: 'いいよ', decision: 'allow' });
    await until(() => s.noticeCount() >= 1);
    expect({ before, afterAnswer: s.noticeCount() >= 1 }).toMatchInlineSnapshot(`
      {
        "afterAnswer": true,
        "before": 0,
      }
    `);
    await s.client.close();
  });

  it('settled の emit が投げたときは、知らせは届かない（届けるのは settled の送出より後）', async () => {
    const s = await waitingWithBufferedNotice({ throwOnSettled: true });
    const rejected = await s.host
      .answer('mgr-1', { requestId: s.asks()[0]?.requestId ?? '', message: 'いいよ', decision: 'allow' })
      .then(
        () => false,
        () => true,
      );
    for (let i = 0; i < 100; i += 1) await tick();
    expect({ rejected, notices: s.noticeCount() }).toMatchInlineSnapshot(`
      {
        "notices": 0,
        "rejected": true,
      }
    `);
    await s.client.close();
  });
});

// 外から作れない枝（この試験では赤くならない変異。切り出しの試験でも同じ限界）:
// - `settle` の二重防止（`done`）: 呼び口（答え・畳み・中断）はどれも、呼ぶ前に `#pending` からの取り外しと中断のリスナーの取り外しを済ませるため、
//   解けた後に同じ確認へ 2 度目の `settle` が届く経路が外から作れない。
// - `waiting_human` かつ空のときだけ `running` に戻す、のうち「`waiting_human` であること」: 確認が残っている間は status が
//   `waiting_human` 以外にならない（ターンの終わりは残りがあれば `waiting_human` にする）ので、条件を落としても同じ値になる。
//   「`#pending` が空であること」の側は 3 件の試験で赤くなる。
// - teardown 側を `unreadable` の対象外にする: 畳み・中断の答えは必ず `decision: 'deny'` を持つので `unreadable` にならず、条件を落としても同じ値になる。
// - `onAbort` → `settle` の順・`settle(value)` と `#deliverPeerNotices()` の順・`#emit(settled)` と `settle(value)` の順: どれも同期の連なりで、
//   `await` を挟まないので、外からは同じ周回に見える（emit が投げた場合だけ `settle(value)` 以降が走らないことは、上の emit の試験が縛る）。
