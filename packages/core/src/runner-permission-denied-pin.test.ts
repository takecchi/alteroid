import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import { ONE_SHOT_ALLOW_TTL_MS } from './runner-actor-keys.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession#onPermissionDenied`（分類器の拒否を数え、1 回だけの許可の確認をクローンへ上げる。約 173 行）を、
// 2 段に割る前に、外から見える結果だけで縛る。入口は SDK の `PermissionDenied` フック（と、再送の相手としての `canUseTool`）、答えは `host.answer()`。
// 見るのは: `emit` された `ask`・`settled`・`note` の全文と順・フックの戻り値・status・`state().waiting`（`#pending`）・
// セッションへ置き直された許可規則（`applyFlagSettings`）・撃ち直しの `PreToolUse` が返す判断（`oneShotAllows` の効果）・
// 出来事が見える周回（マイクロタスク）・emit が同期で投げたときの終わり方。私有メソッド名には依らない。
// 期待の文字列・欄・周回数は、今の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。実時間では待たない（時計は `Date` だけの差し替え。待つのはマイクロタスクの周回と、回数の上限つきの `setTimeout(0)` の周回だけ）。
//
// 各枝が縛る、`runner.ts` の元のコメントの意図:
// - 「`#onPermission` の実装を直接再利用しない」 → 『周回数』（フックの `await` 4 本の位置。`#onPermission` の経路とは別の周回になる）・『S3/S4』
// - 「鍵が作れない入力はクローンへ確認を上げず `no-retry`」 → 『早期 return（note #3・#4）』（確認が積まれない・`ask` が出ない・同期で終わる）
// - 「鍵は入力全体（`matchInputOf`）で作る」 → 『撃ち直しの許可の鍵』（`run_in_background` だけが違う入力・担い手が違う撃ち直しには効かない）
// - 「フックの持ち時間切れは安全側（`no-retry`）で確定し `#pending` から外す。`settled.withdrawn` を使い回さない」 → 『S3: 持ち時間切れ』
// - 「道具名や入力の鍵が取れない回より前に置く（一時規則に当たった呼び出しの拒否は早く返る回でも決着させる。#4905）」 → 『S0 の呼び順』
// - 「道具名や入力の鍵が取れない回も数える（分類器が止めた事実は変わらず、CLI の数えも進む）」 → 『連続拒否（note #1）』
// - 「`tool_input` を載せない（理由は先頭だけ）」 → 『入口の note（#2）』
// - 「allow を返した撃ち直しがそれでも拒否された呼び出しは、確認を重ねて上げずに止める（#4904）」 → 『再拒否（note #5）』
// - 「畳みで解けた確認をクローンの判断として書かない」 → 既存（runner-queue-request-pin.test.ts）が縛る。ここでは『S3』の表に載せない
// - 「retry を返す前に置き終える（撃ち直しが規則の置き直しを追い越すと、規則の無いまま分類器へ回る）」 → 『周回数』・『emit が同期で投げたとき』
// - 「口を持たないセッションでは Bash でも従来の段落にする」 → 『S2/S4: ruleAdded の 2 種』

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const MINUTE = 60_000;
const DENIED = '分類器が拒否した（テスト）';

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
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
      if (fake.failApplyAt?.has(at) === true) {
        throw new Error('control channel が閉じている（テスト）');
      }
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

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-permission-denied-pin-');
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
async function lapsUntil(condition: () => boolean, max = 80): Promise<number> {
  let laps = 0;
  while (!condition() && laps < max) {
    await Promise.resolve();
    laps += 1;
  }
  return laps;
}

/** 時計を NOW からの経過で置く。 */
const setClock = (elapsedMs: number): void => {
  vi.setSystemTime(new Date(NOW + elapsedMs));
};

interface Rig {
  started: Started;
  events: RunnerEvent[];
  host: RunnerHost;
}

async function open(
  options: FakeOptions & { throwOn?: (event: RunnerEvent) => boolean } = {},
): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk(options);
  let armed = false;
  let thrown = false;
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => {
      events.push(event);
      if (armed && !thrown && options.throwOn?.(event) === true) {
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
  // 開いた直後の init（`session` の出来事）は非同期に届く: 先に受けてから空にしないと、あとの出力の先頭に紛れる
  await until(() => events.some((event) => event.type === 'session'));
  events.length = 0;
  armed = true;
  return { started: first, events, host };
}

const statusOf = (rig: Rig): string | undefined => rig.host.list()[0]?.status;
const waitingIds = (rig: Rig): string[] =>
  (rig.host.list()[0]?.waiting ?? []).map((entry) => entry.requestId);

/** `ask`・`settled`・`note` を出た順の 1 行ずつにする（他の種類は `event: <type>`）。 */
function view(events: readonly RunnerEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'note':
        return `note: ${event.text}`;
      case 'ask':
        return `ask: ${event.requestId} (${event.kind})`;
      case 'settled':
        return `settled: ${event.requestId}${event.withdrawn === undefined ? '' : ' (withdrawn)'}`;
      default:
        return `event: ${event.type}`;
    }
  });
}

type Ask = Extract<RunnerEvent, { type: 'ask' }>;
const asksOf = (events: readonly RunnerEvent[]): Ask[] =>
  events.filter((event): event is Ask => event.type === 'ask');
const settledCount = (events: readonly RunnerEvent[]): number =>
  events.filter((event) => event.type === 'settled').length;

interface Called {
  done: () => boolean;
  value: () => unknown;
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

const errorMessage = (called: Called): string | null =>
  called.error() instanceof Error ? (called.error() as Error).message : null;

const RETRY = {
  continue: true,
  hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
};

/** `PermissionDenied` フックを実際に呼ぶ。`undefined` を渡した欄は、SDK が欄ごと送らない形（`tool_name` が無い・`tool_input` が無い）になる。 */
function fire(
  rig: Rig,
  overrides: Record<string, unknown> = {},
  signal: AbortSignal = new AbortController().signal,
): Called {
  const fn = rig.started.options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (fn === undefined) throw new Error('PermissionDenied フックが登録されていない');
  const input = {
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 'tu-1',
    reason: DENIED,
    ...overrides,
  };
  return track(fn(input as never, undefined, { signal }));
}

/** 撃ち直しの `PreToolUse`。返った判断（`allow` か、`continue`）だけを返す。 */
async function pre(
  rig: Rig,
  toolUseId: string,
  toolName: string,
  toolInput: unknown,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const fn = rig.started.options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (fn === undefined) throw new Error('PreToolUse フックが登録されていない');
  const out: HookJSONOutput = await fn(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      ...extra,
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
  const decision = (out as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput?.permissionDecision;
  return decision ?? 'continue';
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

const answerAllow = (rig: Rig, requestId: string) =>
  rig.host.answer('mgr-1', { requestId, decision: 'allow', message: 'どうぞ' });

/** 拒否 → クローンの allow までを流し、retry が返ることまで確かめる。 */
async function allowFlow(
  rig: Rig,
  toolUseId: string,
  toolInput: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const called = fire(rig, { tool_use_id: toolUseId, tool_input: toolInput, ...extra });
  await answerAllow(rig, toolUseId);
  await until(called.done);
  expect(called.value()).toEqual(RETRY);
}

const WORKER = { agent_id: 'agent-w1', agent_type: 'worker-x' };

describe('入口の note（#2）と連続拒否の数え（note #1）', () => {
  it('道具名の無い拒否: 入口の note（道具名なし・tool_use_id 無し・理由なし）→ note #3 の順で、同期のうちに出る', async () => {
    const rig = await open();
    const called = fire(rig, { tool_name: undefined, tool_use_id: undefined, reason: undefined });
    // 待たずに見る: 早期 return までは await が 1 本も無い（同期の前半）
    const syncView = view(rig.events);
    await until(called.done);
    expect({
      syncView,
      value: called.value(),
      asks: asksOf(rig.events).length,
      waiting: waitingIds(rig),
      status: statusOf(rig),
    }).toMatchInlineSnapshot(`
      {
        "asks": 0,
        "status": "running",
        "syncView": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=無し）。理由の先頭: (無し)（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });

  it('理由の先頭は 80 文字（コードポイント）で切って「…」を足し、空白は畳み、tool_input は載せない', async () => {
    const rig = await open();
    const long = `${'あ'.repeat(79)}😀zzz`;
    const spaced = fire(rig, {
      tool_name: undefined,
      tool_input: { command: 'echo TOPSECRET' },
      tool_use_id: 'tu-r1',
      reason: '  先頭 \n\n  の  理由  ',
    });
    const clipped = fire(rig, {
      tool_name: undefined,
      tool_input: { command: 'echo TOPSECRET' },
      tool_use_id: 'tu-r2',
      reason: long,
    });
    const exact = fire(rig, {
      tool_name: undefined,
      tool_use_id: 'tu-r3',
      reason: 'い'.repeat(80),
    });
    await until(() => spaced.done() && clipped.done() && exact.done());
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-r1）。理由の先頭: 先頭 の 理由（issue #1766）",
        "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-r2）。理由の先頭: あああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああああ😀…（issue #1766）",
        "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 先頭 の 理由",
        "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-r3）。理由の先頭: いいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいいい（issue #1766）",
        "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
      ]
    `);
    expect(rig.events.some((event) => JSON.stringify(event).includes('TOPSECRET'))).toBe(false);
  });

  it('担当本人: 3 回目にちょうど達した回だけ note #1（4 回目には出ない）。note #1 は入口の note より先', async () => {
    const rig = await open();
    const seen: string[][] = [];
    for (const reason of ['最初の理由', '2 回目', '3 回目', '4 回目']) {
      rig.events.length = 0;
      const called = fire(rig, { tool_name: undefined, tool_use_id: `tu-${reason}`, reason });
      await until(called.done);
      seen.push(view(rig.events));
    }
    expect(seen).toMatchInlineSnapshot(`
      [
        [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-最初の理由）。理由の先頭: 最初の理由（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-2 回目）。理由の先頭: 2 回目（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        [
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 最初の理由",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-3 回目）。理由の先頭: 3 回目（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-4 回目）。理由の先頭: 4 回目（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
      ]
    `);
  });

  it('作業者は agent id ごとに数える（担当の数えとは別）。note #1 の文面は「この作業者」', async () => {
    const rig = await open();
    const order = [
      { ...WORKER, reason: 'w-1' },
      {},
      { ...WORKER, reason: 'w-2' },
      { reason: 'm-2' },
      { ...WORKER, reason: 'w-3' },
    ];
    const seen: string[][] = [];
    for (const [index, extra] of order.entries()) {
      rig.events.length = 0;
      const called = fire(rig, { tool_name: undefined, tool_use_id: `tu-${index}`, ...extra });
      await until(called.done);
      seen.push(view(rig.events).filter((line) => line.includes('続けて')));
    }
    expect(seen).toMatchInlineSnapshot(`
      [
        [],
        [],
        [],
        [],
        [
          "note: 分類器の拒否が worker:mgr-1:worker-x で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。この作業者には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: w-1",
        ],
      ]
    `);
  });

  it('道具名の無い拒否も数える: 2 回の早期 return のあとの 3 回目は、ask の summary の頭にクローン向けの段落が付き、note #1 が出る（担当本人）', async () => {
    const rig = await open();
    for (const id of ['tu-e1', 'tu-e2']) {
      const called = fire(rig, { tool_name: undefined, tool_use_id: id, reason: `${id} の理由` });
      await until(called.done);
    }
    rig.events.length = 0;
    fire(rig, { tool_use_id: 'tu-e3', reason: 'tu-e3 の理由' });
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: tu-e1 の理由",
        "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-e3）。理由の先頭: tu-e3 の理由（issue #1766）",
        "ask: tu-e3 (permission)",
      ]
    `);
    expect(asksOf(rig.events).map((ask) => ask.summary)).toMatchInlineSnapshot(`
      [
        "⚠ この担当本人は、分類器（auto mode）の拒否が連続 3 回・累計 3 回続いている（runner の数え。CLI の内部の数えとは一致しないことがある）。CLI は連続3回・累計20回で、分類器が止めた操作を確認へ回す。分類器は会話の文脈全体を見て判断するので、この後の確認には、ふだんは通る操作（読む・整形・push）も混ざりうる。いまの連続の最初に引っかかった理由: tu-e1 の理由

      分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: tu-e3 の理由
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
      ]
    `);
  });

  it('作業者の 3 回目も同じ: ask の summary は「作業者 <agent id> 」で始まる段落を頭に付ける', async () => {
    const rig = await open();
    for (const id of ['tu-w1', 'tu-w2']) {
      const called = fire(rig, { ...WORKER, tool_name: undefined, tool_use_id: id });
      await until(called.done);
    }
    rig.events.length = 0;
    fire(rig, { ...WORKER, tool_use_id: 'tu-w3' });
    expect(view(rig.events)).toMatchInlineSnapshot(`
      [
        "note: 分類器の拒否が worker:mgr-1:worker-x で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。この作業者には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
        "note: 分類器の拒否のフックが届いた（worker:mgr-1:worker-x・Bash・tool_use_id=tu-w3）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
        "ask: tu-w3 (permission)",
      ]
    `);
    expect(asksOf(rig.events).map((ask) => ask.summary)).toMatchInlineSnapshot(`
      [
        "⚠ この作業者 agent-w1 は、分類器（auto mode）の拒否が連続 3 回・累計 3 回続いている（runner の数え。CLI の内部の数えとは一致しないことがある）。CLI は連続3回・累計20回で、分類器が止めた操作を確認へ回す。分類器は会話の文脈全体を見て判断するので、この後の確認には、ふだんは通る操作（読む・整形・push）も混ざりうる。いまの連続の最初に引っかかった理由: 分類器が拒否した（テスト）

      分類器が worker:mgr-1:worker-x の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
      ]
    `);
  });

  it('2 回までは ask の summary に連続拒否の段落が付かない（対照）', async () => {
    const rig = await open();
    fire(rig, { tool_use_id: 'tu-c1' });
    fire(rig, { tool_use_id: 'tu-c2', tool_input: { command: 'echo other' } });
    expect(asksOf(rig.events).map((ask) => ask.summary.startsWith('分類器が'))).toEqual([
      true,
      true,
    ]);
  });
});

describe('早期 return（note #3・#4）: クローンへ確認を上げず no-retry', () => {
  /** 早期 return になる入力を渡し、出た note・戻り値・積まれたものを返す。 */
  async function early(overrides: Record<string, unknown>) {
    const rig = await open();
    const called = fire(rig, overrides);
    const syncView = view(rig.events);
    await until(called.done);
    return {
      syncView,
      value: called.value(),
      asks: asksOf(rig.events).length,
      waiting: waitingIds(rig),
      status: statusOf(rig),
      flagAllows: rig.started.flagAllows.length,
    };
  }

  it('note #3: 道具名が無い（担当本人・作業者）。tool_input が鍵になる形でも、道具名が先に見られる', async () => {
    expect({
      manager: await early({ tool_name: undefined, tool_use_id: 'tu-n1' }),
      worker: await early({ ...WORKER, tool_name: undefined, tool_use_id: 'tu-n2' }),
      noNameNoInput: await early({
        tool_name: undefined,
        tool_input: undefined,
        tool_use_id: 'tu-n3',
      }),
    }).toMatchInlineSnapshot(`
      {
        "manager": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-n1）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
        "noNameNoInput": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-n3）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
        "worker": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（worker:mgr-1:worker-x・道具名なし・tool_use_id=tu-n2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器の拒否（worker:mgr-1:worker-x）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
      }
    `);
  });

  it('note #4: 入力が鍵にならない（tool_input が無い・JSON にできない）。道具名は note に載る', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect({
      absent: await early({ tool_input: undefined, tool_use_id: 'tu-i1' }),
      circular: await early({ tool_input: circular, tool_use_id: 'tu-i2' }),
      worker: await early({ ...WORKER, tool_name: 'Edit', tool_input: undefined }),
    }).toMatchInlineSnapshot(`
      {
        "absent": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-i1）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器が manager:mgr-1 の Bash 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
        "circular": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-i2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器が manager:mgr-1 の Bash 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
        "worker": {
          "asks": 0,
          "flagAllows": 0,
          "status": "running",
          "syncView": [
            "note: 分類器の拒否のフックが届いた（worker:mgr-1:worker-x・Edit・tool_use_id=tu-1）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
            "note: 分類器が worker:mgr-1:worker-x の Edit 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。",
          ],
          "value": {
            "continue": true,
          },
          "waiting": [],
        },
      }
    `);
  });

  it('鍵になる入力は早期 return にならず確認が上がる（null・空オブジェクト・文字列。`undefined` だけが鍵にならない）', async () => {
    const rig = await open();
    fire(rig, { tool_input: null, tool_use_id: 'tu-k1' });
    fire(rig, { tool_input: {}, tool_use_id: 'tu-k2' });
    fire(rig, { tool_input: 'ls', tool_use_id: 'tu-k3' });
    expect(asksOf(rig.events).map((ask) => ask.requestId)).toEqual(['tu-k1', 'tu-k2', 'tu-k3']);
    expect(waitingIds(rig)).toEqual(['tu-k1', 'tu-k2', 'tu-k3']);
  });

  it('tool_use_id が無い拒否: 確認の requestId は UUID になり、その id で答えれば retry が返る', async () => {
    const rig = await open();
    const called = fire(rig, { tool_use_id: undefined });
    const [ask] = asksOf(rig.events);
    expect(ask?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(view(rig.events).some((line) => line.includes('tool_use_id=無し'))).toBe(true);
    await answerAllow(rig, ask?.requestId ?? '');
    await until(called.done);
    expect(called.value()).toEqual(RETRY);
  });
});

describe('S0 の呼び順（settle → sweep → 連続拒否 → 入口の note → 早期 return / 再拒否 / ask）', () => {
  /**
   * 規則 B（t0 に足す・未使用のまま期限切れ）と規則 A（t0+5 分に足す。t0+6 分の撃ち直し tu-a2 で使われて印が付く）を作り、
   * 時計を B の期限の後（t0+10 分+1 秒）へ進める。ここまでの拒否は担当で 2 回（次の拒否が 3 回目）。
   */
  async function scenario(): Promise<Rig> {
    const rig = await open();
    await allowFlow(rig, 'tu-b', { command: 'echo b' });
    setClock(5 * MINUTE);
    await allowFlow(rig, 'tu-a', { command: 'echo a' });
    setClock(6 * MINUTE);
    expect(await pre(rig, 'tu-a2', 'Bash', { command: 'echo a' })).toBe('allow');
    setClock(ONE_SHOT_ALLOW_TTL_MS + 1000);
    rig.events.length = 0;
    return rig;
  }

  it('道具名の無い拒否: 一時規則の決着（A）→ 期限切れの掃除（B）→ note #1 → 入口の note → note #3', async () => {
    const rig = await scenario();
    const called = fire(rig, { tool_name: undefined, tool_use_id: 'tu-a2' });
    await until(called.done);
    expect({ log: view(rig.events), value: called.value() }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: PermissionDenied）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo a",
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo b",
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-a2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        "value": {
          "continue": true,
        },
      }
    `);
  });

  it('入力が鍵にならない拒否: 同じ順で、note #4 で終わる', async () => {
    const rig = await scenario();
    const called = fire(rig, { tool_input: undefined, tool_use_id: 'tu-a2' });
    await until(called.done);
    expect({ log: view(rig.events), value: called.value() }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: PermissionDenied）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo a",
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo b",
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-a2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。",
        ],
        "value": {
          "continue": true,
        },
      }
    `);
  });

  it('allow を返した撃ち直しの再拒否: 同じ順で、note #5 で終わる（ask は出ない）', async () => {
    const rig = await scenario();
    const called = fire(rig, { tool_use_id: 'tu-a2', tool_input: { command: 'echo a' } });
    await until(called.done);
    expect({
      log: view(rig.events),
      value: called.value(),
      waiting: waitingIds(rig),
    }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: PermissionDenied）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo a",
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo b",
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-a2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。",
        ],
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });

  it('確認が上がる拒否: 同じ順のあとに ask（summary にクローン向けの連続拒否の段落）。allow で、期限切れの未使用の許可の note は settled のあと・規則の note の前', async () => {
    const rig = await scenario();
    const called = fire(rig, { tool_use_id: 'tu-a2', tool_input: { command: 'echo c' } });
    const askLog = view(rig.events);
    const summary = asksOf(rig.events)[0]?.summary;
    await answerAllow(rig, 'tu-a2');
    await until(called.done);
    expect({
      askLog,
      summary,
      full: view(rig.events),
      value: called.value(),
    }).toMatchInlineSnapshot(`
      {
        "askLog": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: PermissionDenied）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo a",
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo b",
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-a2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-a2 (permission)",
        ],
        "full": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）に当たる manager:mgr-1 の呼び出しが、それでも拒否された（合図の出所: PermissionDenied）。セッションに許可規則を足すこの口が、分類器に効いていない疑いがある。規則は外した。同じ入力を撃ち直さず、人間が止められた中身を見て誤検知だと確かめるか、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4905）。入力の先頭（伏せ字）: echo a",
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo b",
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-a2）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-a2 (permission)",
          "settled: tu-a2",
          "note: クローンが出した1回だけの許可（manager:mgr-1・Bash）は、撃ち直されないまま10分の期限が切れた（使われていない。issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は助言でしかない。manager_send で伝える案が効くかは確かめていない。この note は期限後の次の道具呼び出しか次の拒否の時点で出る（それまで何も呼ばれなければ出ない）。",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo c",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "summary": "⚠ この担当本人は、分類器（auto mode）の拒否が連続 3 回・累計 3 回続いている（runner の数え。CLI の内部の数えとは一致しないことがある）。CLI は連続3回・累計20回で、分類器が止めた操作を確認へ回す。分類器は会話の文脈全体を見て判断するので、この後の確認には、ふだんは通る操作（読む・整形・push）も混ざりうる。いまの連続の最初に引っかかった理由: 分類器が拒否した（テスト）

      分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo c",
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
});

describe('再拒否の判定（note #5）', () => {
  /** allow を返して撃ち直しの PreToolUse（許可が使われ、撃ち直しの呼び出しが記録される）まで流す。 */
  async function allowedRetry(rig: Rig, input: { command: string }): Promise<void> {
    await allowFlow(rig, 'tu-1', input);
    expect(await pre(rig, 'tu-2', 'Bash', input)).toBe('allow');
    rig.events.length = 0;
  }

  it('まだ決着していない allow の撃ち直しへの拒否（別の tool_use_id・同じ入力）: note #5 の全文・no-retry・ask が出ない・settled も出ない', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo again' });
    const called = fire(rig, { tool_use_id: 'tu-3', tool_input: { command: 'echo again' } });
    await until(called.done);
    expect({
      log: view(rig.events),
      value: called.value(),
      waiting: waitingIds(rig),
    }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-3）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。",
        ],
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });

  it('担い手が違えば同じ入力でも確認が上がる（鍵は担い手を含む）。入力が違っても上がる', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo again' });
    fire(rig, { ...WORKER, tool_use_id: 'tu-3', tool_input: { command: 'echo again' } });
    fire(rig, { tool_use_id: 'tu-4', tool_input: { command: 'echo again', description: 'd' } });
    expect(asksOf(rig.events).map((ask) => ask.requestId)).toEqual(['tu-3', 'tu-4']);
  });

  it('撃ち直しの記録の寿命: 10 分の 1ms 手前までは止め、ちょうどで確認が上がる', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo ttl' });
    setClock(ONE_SHOT_ALLOW_TTL_MS - 1);
    const before = fire(rig, { tool_use_id: 'tu-t1', tool_input: { command: 'echo ttl' } });
    await until(before.done);
    const askedBefore = asksOf(rig.events).length;
    setClock(ONE_SHOT_ALLOW_TTL_MS);
    fire(rig, { tool_use_id: 'tu-t2', tool_input: { command: 'echo ttl' } });
    expect({
      beforeValue: before.value(),
      askedBefore,
      asksAtExpiry: asksOf(rig.events).map((ask) => ask.requestId),
    }).toMatchInlineSnapshot(`
      {
        "askedBefore": 0,
        "asksAtExpiry": [
          "tu-t2",
        ],
        "beforeValue": {
          "continue": true,
        },
      }
    `);
  });

  it('撃ち直しがまた拒否されて控えられた鍵（拒否の合図が先に届いた形）でも note #5 になる。note の文面は同じ', async () => {
    const rig = await open();
    await allowedRetry(rig, { command: 'echo funneled' });
    rig.started.push(liveDenialAsSdkSends('Bash', 'tu-2'));
    await until(() => rig.events.some((event) => event.type === 'permission_denied'));
    rig.events.length = 0;
    const called = fire(rig, { tool_use_id: 'tu-3', tool_input: { command: 'echo funneled' } });
    await until(called.done);
    expect({
      log: view(rig.events),
      value: called.value(),
    }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-3）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。",
        ],
        "value": {
          "continue": true,
        },
      }
    `);
  });
});

describe('S1 再送（同じ id の確認が既に積まれているとき `already.result` を待つ）', () => {
  it('フックが 2 回（同じ tool_use_id）: ask は 1 件・settled は 1 回・allow で両方 retry。規則は 1 回だけ足す。2 回目は note #8 を出さない', async () => {
    const rig = await open();
    const first = fire(rig, { tool_use_id: 'tu-dup' });
    const second = fire(rig, { tool_use_id: 'tu-dup' });
    const waitingBefore = waitingIds(rig);
    await answerAllow(rig, 'tu-dup');
    await until(() => first.done() && second.done());
    expect({
      waitingBefore,
      first: first.value(),
      second: second.value(),
      asks: asksOf(rig.events).length,
      settled: settledCount(rig.events),
      flagAllows: rig.started.flagAllows,
      log: view(rig.events),
    }).toMatchInlineSnapshot(`
      {
        "asks": 1,
        "first": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "flagAllows": [
          [
            "Bash(echo hi)",
          ],
        ],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-dup (permission)",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "settled: tu-dup",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo hi",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "second": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "settled": 1,
        "waitingBefore": [
          "tu-dup",
        ],
      }
    `);
  });

  it('deny でも両方 no-retry。note #7 は 1 回だけ', async () => {
    const rig = await open();
    const first = fire(rig, { tool_use_id: 'tu-dup' });
    const second = fire(rig, { tool_use_id: 'tu-dup' });
    await rig.host.answer('mgr-1', { requestId: 'tu-dup', decision: 'deny', message: 'だめ' });
    await until(() => first.done() && second.done());
    expect({
      first: first.value(),
      second: second.value(),
      asks: asksOf(rig.events).length,
      settled: settledCount(rig.events),
      log: view(rig.events),
    }).toMatchInlineSnapshot(`
      {
        "asks": 1,
        "first": {
          "continue": true,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-dup (permission)",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "settled: tu-dup",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）への1回だけの許可を出さなかった: だめ",
        ],
        "second": {
          "continue": true,
        },
        "settled": 1,
      }
    `);
  });

  it('canUseTool の確認（同じ id）が積まれているところへ来たフックは、その結果を待つ（ask は増えない）', async () => {
    const rig = await open();
    const canUseTool = rig.started.options.canUseTool;
    if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
    const permission = track(
      canUseTool('Bash', { command: 'echo hi' }, {
        signal: new AbortController().signal,
        toolUseID: 'tu-x',
        requestId: 'tu-dup',
      } as never),
    );
    const hooked = fire(rig, { tool_use_id: 'tu-dup' });
    await answerAllow(rig, 'tu-dup');
    await until(() => permission.done() && hooked.done());
    expect({
      hook: hooked.value(),
      permission: permission.value(),
      asks: asksOf(rig.events).length,
      settled: settledCount(rig.events),
      flagAllows: rig.started.flagAllows,
      log: view(rig.events),
    }).toMatchInlineSnapshot(`
      {
        "asks": 1,
        "flagAllows": [],
        "hook": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "log": [
          "ask: tu-dup (permission)",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "settled: tu-dup",
        ],
        "permission": {
          "behavior": "allow",
        },
        "settled": 1,
      }
    `);
  });

  it('解けたあとの再送は、解けた結果から返る（ask・settled は増えず、規則も足されない。note は入口の note だけ）', async () => {
    const rig = await open();
    await allowFlow(rig, 'tu-dup', { command: 'echo hi' });
    rig.events.length = 0;
    const again = fire(rig, { tool_use_id: 'tu-dup' });
    await until(again.done);
    expect({
      value: again.value(),
      log: view(rig.events),
      flagAllows: rig.started.flagAllows,
    }).toMatchInlineSnapshot(`
      {
        "flagAllows": [
          [
            "Bash(echo hi)",
          ],
        ],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-dup）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
        ],
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
});

describe('S2/S3/S4: 答えと note #6〜#8・retry の値', () => {
  /** 拒否 → 答え（or 中断）→ フックの決着までを流し、外から見える結果を 1 つにまとめる。 */
  async function run(
    how: 'allow' | 'deny' | 'unreadable' | 'abort',
    overrides: Record<string, unknown> = {},
    fake: FakeOptions = {},
  ) {
    const rig = await open(fake);
    const controller = new AbortController();
    const called = fire(rig, { tool_use_id: 'tu-s', ...overrides }, controller.signal);
    const askLog = view(rig.events);
    const summary = asksOf(rig.events)[0]?.summary;
    let answered: unknown;
    if (how === 'abort') {
      controller.abort();
    } else if (how === 'allow') {
      answered = await answerAllow(rig, 'tu-s');
    } else if (how === 'deny') {
      answered = await rig.host.answer('mgr-1', {
        requestId: 'tu-s',
        decision: 'deny',
        message: '危ないのでだめ',
      });
    } else {
      answered = await rig.host.answer('mgr-1', { requestId: 'tu-s', message: 'うーん' });
    }
    await until(called.done);
    const input = (overrides.tool_input ?? { command: 'echo hi' }) as unknown;
    const agent =
      overrides.agent_id === undefined
        ? {}
        : { agent_id: overrides.agent_id, agent_type: overrides.agent_type };
    return {
      summary,
      askLog,
      answered,
      value: called.value(),
      log: view(rig.events),
      waiting: waitingIds(rig),
      status: statusOf(rig),
      flagAllows: rig.started.flagAllows,
      // 撃ち直し: 許可が置かれていれば allow、置かれていなければ continue
      retryDecision: await pre(
        rig,
        'tu-s-retry',
        String(overrides.tool_name ?? 'Bash'),
        input,
        agent,
      ),
    };
  }

  it('allow（Bash・規則が足せる）: 規則の note → note #8（一時規則の文面）。retry。撃ち直しは allow', async () => {
    expect(await run('allow')).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [
          [
            "Bash(echo hi)",
          ],
        ],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo hi",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('allow（Bash 以外）: 規則は足さず黙って note #8（一時規則を足していない文面）。summary は従来の段落', async () => {
    expect(await run('allow', { tool_name: 'Read', tool_input: { file_path: '/tmp/a' } }))
      .toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Read・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Read・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: クローンが分類器の拒否（manager:mgr-1・Read）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Read 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: {"file_path":"/tmp/a"}",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('allow（`*` を含む Bash）: 規則にできない旨の note → note #8（足していない文面）。summary は従来の段落', async () => {
    expect(await run('allow', { tool_input: { command: 'ls /tmp/*' } })).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しへのクローンの allow を、一時規則としてセッションに足せなかった（担当 mgr-1。理由: command が規則にできない（\`*\` を含む。完全一致より広い規則になりうる））。今までどおり、同じ担い手の同じ入力を1回だけ通す許可だけを出す（#4905）。入力の先頭（伏せ字）: ls /tmp/*",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: ls /tmp/*",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('allow（規則の置き直しが失敗）: 足せなかった旨の note → note #8（足していない文面）。retry は返り、許可は置かれる', async () => {
    expect(await run('allow', {}, { failApplyAt: new Set([0]) })).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しへのクローンの allow を、一時規則としてセッションに足せなかった（担当 mgr-1。理由: 規則の置き直しが失敗した: Error: control channel が閉じている（テスト））。今までどおり、同じ担い手の同じ入力を1回だけ通す許可だけを出す（#4905）。入力の先頭（伏せ字）: echo hi",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('allow（規則を置く口を持たないセッションの Bash）: 規則の note は無く note #8（足していない文面）。summary は従来の段落', async () => {
    expect(await run('allow', {}, { withApplyFlagSettings: false })).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力で撃ち直しても、分類器にまた止められうる（迂回・敵対の型で止めた呼び出しは、クローンの allow や担当の伝言を人間の確認と見なさない）。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること（#4904）。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。allow は「同じ入力での撃ち直しを、10分以内に1回だけ通そうとする」許可で、撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。分類器が迂回・敵対の型で止めた場合は、allow しても撃ち直しは通らないことがある（分類器は、クローンの allow や担当からの伝言を人間の確認と見なさない）。通すには、人間が止められた中身を見て誤検知だと確かめる必要がある。allow の後は、担当・作業者へ「同じ入力で撃ち直しても、分類器にまた止められうる。続けて同じ入力を撃たず、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える（#4904）。この許可で通るかは確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('allow（理由なし・作業者・空の command）: summary の欄の埋め方（理由なしは「(無し)」）と、作業者の担い手名。撃ち直しは同じ作業者にだけ効く', async () => {
    expect(await run('allow', { ...WORKER, reason: undefined, tool_input: { command: '' } }))
      .toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "allow",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（worker:mgr-1:worker-x・Bash・tool_use_id=tu-s）。理由の先頭: (無し)（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [
          [
            "Bash()",
          ],
        ],
        "log": [
          "note: 分類器の拒否のフックが届いた（worker:mgr-1:worker-x・Bash・tool_use_id=tu-s）。理由の先頭: (無し)（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: 分類器が止めた worker:mgr-1:worker-x の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: ",
          "note: クローンが分類器の拒否（worker:mgr-1:worker-x・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "summary": "分類器が worker:mgr-1:worker-x の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: (無し)
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: ",
        "value": {
          "continue": true,
          "hookSpecificOutput": {
            "hookEventName": "PermissionDenied",
            "retry": true,
          },
        },
        "waiting": [],
      }
    `);
  });

  it('deny: note #7（クローンの文面を載せる）。no-retry。許可は置かれず、規則も足されない', async () => {
    expect(await run('deny')).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "deny",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）への1回だけの許可を出さなかった: 危ないのでだめ",
        ],
        "retryDecision": "continue",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });

  it('読めない答え（decision が無く、承認とも拒否とも読めない）: 安全側で deny の note #7（前置きつき）。no-retry', async () => {
    expect(await run('unreadable')).toMatchInlineSnapshot(`
      {
        "answered": {
          "decision": "unreadable",
          "delivered": true,
        },
        "askLog": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
        ],
        "flagAllows": [],
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）への1回だけの許可を出さなかった: [decision が無く、承認とも拒否とも読み取れなかったので安全側で拒否した] うーん

      許可するときは decision: 'allow' を明示して答え直すこと。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "summary": "分類器が manager:mgr-1 の Bash 呼び出しを拒否した。この1回だけ許可しますか。

      答えたあと: allow しても、この呼び出しは自動では撃ち直されない。撃ち直すかは担い手が決める（拒否文が再試行を禁じていると撃ち直されないことがある）。allow すると、同じ入力の1回だけを10分通す一時規則がこのセッションに足される（そのセッションの他の作業者にも効く。#4905）。allow の後は、担当・作業者へ「撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること」と伝える。この規則で分類器を通れるかは実機では確かめていない。同じ呼び出しがそれでも拒否されても、確認は重ねて上げない。

      理由: 分類器が拒否した（テスト）
      入力の先頭（伏せ字・最大160字。issue #1105 P0）: echo hi",
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });

  it('持ち時間切れ（signal の中断）: settled → note #6。no-retry。許可は置かれず、遅れて届いた allow は宛先なし', async () => {
    const rig = await open();
    const controller = new AbortController();
    const called = fire(rig, { tool_use_id: 'tu-s' }, controller.signal);
    controller.abort();
    await until(called.done);
    const late = await answerAllow(rig, 'tu-s');
    expect({
      value: called.value(),
      log: view(rig.events),
      waiting: waitingIds(rig),
      status: statusOf(rig),
      late,
      flagAllows: rig.started.flagAllows,
      retryDecision: await pre(rig, 'tu-s-retry', 'Bash', { command: 'echo hi' }),
    }).toMatchInlineSnapshot(`
      {
        "flagAllows": [],
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-s）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-s (permission)",
          "settled: tu-s",
          "note: 分類器の拒否（manager:mgr-1・Bash）への1回だけの許可の確認が、フックの持ち時間切れで終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので反映しない（issue #1105 P1）。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "value": {
          "continue": true,
        },
        "waiting": [],
      }
    `);
  });
});

describe('許可の鍵と撃ち直し（`oneShotAllows.set` の効果）', () => {
  it('鍵は入力全体（キーの順は関係なく、別の欄が 1 つ違えば別）。allow は 1 回で使い切る', async () => {
    const rig = await open();
    const input = { command: 'echo k1', description: 'd' };
    await allowFlow(rig, 'tu-k1', input);
    expect({
      commandOnly: await pre(rig, 'tu-r1', 'Bash', { command: 'echo k1' }),
      extraField: await pre(rig, 'tu-r2', 'Bash', { ...input, run_in_background: true }),
      reordered: await pre(rig, 'tu-r3', 'Bash', { description: 'd', command: 'echo k1' }),
      second: await pre(rig, 'tu-r4', 'Bash', input),
    }).toMatchInlineSnapshot(`
      {
        "commandOnly": "continue",
        "extraField": "continue",
        "reordered": "allow",
        "second": "continue",
      }
    `);
  });

  it('鍵は担い手（agent id）と道具名を含む: 別の作業者・担当本人・別の道具には効かず、許可を受けた作業者自身には効く', async () => {
    const rig = await open();
    const input = { command: 'echo k2' };
    await allowFlow(rig, 'tu-k2', input, WORKER);
    expect({
      otherWorker: await pre(rig, 'tu-r1', 'Bash', input, {
        agent_id: 'agent-w2',
        agent_type: 'worker-x',
      }),
      manager: await pre(rig, 'tu-r2', 'Bash', input),
      otherTool: await pre(rig, 'tu-r3', 'Edit', input, WORKER),
      sameWorker: await pre(rig, 'tu-r4', 'Bash', input, WORKER),
    }).toMatchInlineSnapshot(`
      {
        "manager": "continue",
        "otherTool": "continue",
        "otherWorker": "continue",
        "sameWorker": "allow",
      }
    `);
  });

  it('使われないまま期限切れになった前の許可は、次の allow の決着で note に残る（settled のあと・規則の note の前）。同じ入力の allow でも前のものを数える', async () => {
    const rig = await open();
    await allowFlow(rig, 'tu-old', { command: 'echo old' });
    setClock(ONE_SHOT_ALLOW_TTL_MS + 1000);
    rig.events.length = 0;
    const called = fire(rig, { tool_use_id: 'tu-new', tool_input: { command: 'echo old' } });
    await answerAllow(rig, 'tu-new');
    await until(called.done);
    expect({ value: called.value(), log: view(rig.events) }).toMatchInlineSnapshot(`
      {
        "log": [
          "note: 一時規則（担当 mgr-1・規則を足させた呼び出し: manager:mgr-1・Bash）は、使われないまま10分の期限が切れたので外した（#4905）。この note は期限後の次の道具呼び出しか次の拒否の時点で出る。入力の先頭（伏せ字）: echo old",
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-new）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-new (permission)",
          "settled: tu-new",
          "note: クローンが出した1回だけの許可（manager:mgr-1・Bash）は、撃ち直されないまま10分の期限が切れた（使われていない。issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は助言でしかない。manager_send で伝える案が効くかは確かめていない。この note は期限後の次の道具呼び出しか次の拒否の時点で出る（それまで何も呼ばれなければ出ない）。",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo old",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
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
});

describe('周回数（マイクロタスク。`#onPermissionDenied` の await 4 本の位置）', () => {
  /** ask が見える周回・答えて settled が見える周回・フックが解けるまでの周回。 */
  async function laps(
    how: 'allow' | 'deny' | 'abort',
    overrides: Record<string, unknown> = {},
    fake: FakeOptions = {},
  ) {
    const rig = await open(fake);
    const controller = new AbortController();
    const called = fire(rig, { tool_use_id: 'tu-l', ...overrides }, controller.signal);
    const syncAsk = asksOf(rig.events).length;
    const askLaps = await lapsUntil(() => asksOf(rig.events).length > 0);
    let answering: Promise<unknown> = Promise.resolve();
    if (how === 'abort') {
      controller.abort();
    } else {
      answering = rig.host.answer('mgr-1', {
        requestId: 'tu-l',
        decision: how,
        message: 'ok',
      });
    }
    const settledLaps = await lapsUntil(() => settledCount(rig.events) > 0);
    const hookLaps = await lapsUntil(called.done);
    await answering;
    return { syncAsk, askLaps, settledLaps, hookLaps };
  }

  it('allow の 4 種（規則を足す／Bash 以外／規則にできない／口が無い）・deny・持ち時間切れで、フックが解ける周回を固定する', async () => {
    expect({
      allowBashRule: await laps('allow'),
      allowNotBash: await laps('allow', {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/a' },
      }),
      allowUnruleable: await laps('allow', { tool_input: { command: 'ls /tmp/*' } }),
      allowNoSetter: await laps('allow', {}, { withApplyFlagSettings: false }),
      deny: await laps('deny'),
      abort: await laps('abort'),
    }).toMatchInlineSnapshot(`
      {
        "abort": {
          "askLaps": 0,
          "hookLaps": 3,
          "settledLaps": 0,
          "syncAsk": 1,
        },
        "allowBashRule": {
          "askLaps": 0,
          "hookLaps": 10,
          "settledLaps": 0,
          "syncAsk": 1,
        },
        "allowNoSetter": {
          "askLaps": 0,
          "hookLaps": 4,
          "settledLaps": 0,
          "syncAsk": 1,
        },
        "allowNotBash": {
          "askLaps": 0,
          "hookLaps": 4,
          "settledLaps": 0,
          "syncAsk": 1,
        },
        "allowUnruleable": {
          "askLaps": 0,
          "hookLaps": 4,
          "settledLaps": 0,
          "syncAsk": 1,
        },
        "deny": {
          "askLaps": 0,
          "hookLaps": 3,
          "settledLaps": 0,
          "syncAsk": 1,
        },
      }
    `);
  });

  it('S1 の再送: 2 本目のフックが `already.result` を待ってから解ける周回（1 本目との差）', async () => {
    const rig = await open();
    const first = fire(rig, { tool_use_id: 'tu-l' });
    const second = fire(rig, { tool_use_id: 'tu-l' });
    const answering = answerAllow(rig, 'tu-l');
    const firstLaps = await lapsUntil(first.done);
    const secondExtra = await lapsUntil(second.done);
    await answering;
    expect({ firstLaps, secondExtra }).toMatchInlineSnapshot(`
      {
        "firstLaps": 11,
        "secondExtra": 0,
      }
    `);
  });

  it('早期 return・再拒否（note #5）・解けたあとの再送は、`#onPermissionDenied` の中で await を挟まない: フックが解ける周回は口の async ぶんだけ', async () => {
    const lapsOf = async (
      overrides: Record<string, unknown>,
      prepare?: (rig: Rig) => Promise<void>,
    ) => {
      const rig = await open();
      if (prepare !== undefined) await prepare(rig);
      const called = fire(rig, overrides);
      return lapsUntil(called.done);
    };
    expect({
      noName: await lapsOf({ tool_name: undefined }),
      noInput: await lapsOf({ tool_input: undefined }),
      reDenied: await lapsOf(
        { tool_use_id: 'tu-3', tool_input: { command: 'echo again' } },
        async (rig) => {
          await allowFlow(rig, 'tu-1', { command: 'echo again' });
          expect(await pre(rig, 'tu-2', 'Bash', { command: 'echo again' })).toBe('allow');
        },
      ),
      resolvedResend: await lapsOf({ tool_use_id: 'tu-1' }, async (rig) => {
        await allowFlow(rig, 'tu-1', { command: 'echo hi' });
      }),
    }).toMatchInlineSnapshot(`
      {
        "noInput": 2,
        "noName": 2,
        "reDenied": 2,
        "resolvedResend": 2,
      }
    `);
  });
});

describe('emit が同期で投げたとき（どの出力が投げても、フックは拒否され、`#pending` と許可の状態は決まった形で残る）', () => {
  interface ThrowCase {
    label: string;
    match: (event: RunnerEvent) => boolean;
    overrides?: Record<string, unknown>;
    how?: 'allow' | 'deny' | 'abort';
    /** 投げさせる前に流す準備（準備の間は投げない。投げるのは準備のあとの最初の一致）。 */
    prepare?: (rig: Rig) => Promise<void>;
  }

  const noteIncludes =
    (text: string) =>
    (event: RunnerEvent): boolean =>
      event.type === 'note' && event.text.includes(text);

  async function runThrow(testCase: ThrowCase) {
    let armed = false;
    const rig = await open({
      throwOn: (event) => armed && testCase.match(event),
    });
    if (testCase.prepare !== undefined) await testCase.prepare(rig);
    armed = true;
    rig.events.length = 0;
    const controller = new AbortController();
    const called = fire(rig, { tool_use_id: 'tu-t', ...testCase.overrides }, controller.signal);
    let answering: string | null = null;
    if (testCase.how === 'abort') {
      controller.abort();
    } else if (testCase.how !== undefined) {
      answering = await rig.host
        .answer('mgr-1', {
          requestId: 'tu-t',
          decision: testCase.how,
          message: 'ok',
        })
        .then(
          () => 'resolved',
          (error: unknown) => (error instanceof Error ? error.message : 'non-error'),
        );
    }
    await until(called.done);
    // 決着しない形（settled が投げた）は、上限つきの周回のあとにも未決着であることを見る
    await lapsUntil(called.done, 200);
    const late =
      testCase.how === undefined
        ? undefined
        : await rig.host
            .answer('mgr-1', { requestId: 'tu-t', decision: 'allow', message: 'ok' })
            .then(
              (result) => result,
              () => 'rejected',
            );
    return {
      hookDone: called.done(),
      hookRejected: errorMessage(called),
      hookValue: called.value(),
      answerOutcome: answering,
      log: view(rig.events),
      waiting: waitingIds(rig),
      status: statusOf(rig),
      flagAllows: rig.started.flagAllows,
      retryDecision: await pre(rig, 'tu-t-retry', 'Bash', { command: 'echo hi' }),
      late,
    };
  }

  const allowFirst = async (rig: Rig) => {
    await allowFlow(rig, 'tu-pre-1', { command: 'echo again' });
    expect(await pre(rig, 'tu-pre-2', 'Bash', { command: 'echo again' })).toBe('allow');
  };

  it('入口の note（#2）が投げる: フックは拒否され、ask は出ず、何も積まれない', async () => {
    expect(await runThrow({ label: '#2', match: noteIncludes('分類器の拒否のフックが届いた') }))
      .toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": undefined,
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #1 が投げる（3 回目）: 入口の note より前に拒否される', async () => {
    expect(
      await runThrow({
        label: '#1',
        match: noteIncludes('続けて'),
        prepare: async (rig) => {
          for (const id of ['tu-p1', 'tu-p2']) {
            const called = fire(rig, { tool_name: undefined, tool_use_id: id });
            await until(called.done);
          }
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": undefined,
        "log": [
          "note: 分類器の拒否が manager:mgr-1 で続けて 3 回になった（累計 3 回。runner の数え）。CLI はこの後、分類器が止めた操作を確認へ回すので、ふだんは通る操作の確認も上がりうる。担当には、次に道具が通ったとき、その事情と取れる道（クローンに確かめてもらう・新しい作業者へ渡す・区切りで報告して後継を起こしてもらう）を添える。最初に引っかかった理由: 分類器が拒否した（テスト）",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #3 が投げる: フックは拒否される', async () => {
    expect(
      await runThrow({
        label: '#3',
        match: noteIncludes('道具名を持たない合図'),
        overrides: { tool_name: undefined },
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": undefined,
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・道具名なし・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器の拒否（manager:mgr-1）が道具名を持たない合図で届いたので、クローンへは確認を上げず、1回だけの許可も出さない（issue #1105 P1）。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #4 が投げる: フックは拒否される', async () => {
    expect(
      await runThrow({
        label: '#4',
        match: noteIncludes('1回だけの許可の鍵へ畳め'),
        overrides: { tool_input: undefined },
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": undefined,
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを拒否したが、入力を1回だけの許可の鍵へ畳めなかったため、クローンへは確認を上げず1回だけの許可も出さない（issue #1105 P1）。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #5 が投げる: フックは拒否される。ask は出ない', async () => {
    expect(
      await runThrow({
        label: '#5',
        match: noteIncludes('allow を返した撃ち直しのあとでも'),
        overrides: { tool_input: { command: 'echo again' } },
        prepare: allowFirst,
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [
          [
            "Bash(echo again)",
          ],
        ],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": undefined,
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "note: 分類器が manager:mgr-1 の Bash 呼び出しを、allow を返した撃ち直しのあとでも再び止めた。同じ呼び出しの確認は重ねて上げない（allow しても通らなかった。人間が止められた中身を見て誤検知だと確かめるまで、同じ入力は通らないことがある。#4904）。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('ask が投げる: フックは拒否される（確認が #pending に残ることは runner-queue-request-pin.test.ts が縛る）。あとで答えて解いても、フックはもう終わっていて note も規則も出ない', async () => {
    expect(
      await runThrow({
        label: 'ask',
        match: (event) => event.type === 'ask',
        how: 'allow',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": "resolved",
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('settled が投げる（allow）: 答えが拒否され、確認は外れ、フックは決着しないまま。許可も規則も置かれない', async () => {
    expect(
      await runThrow({
        label: 'settled',
        match: (event) => event.type === 'settled',
        how: 'allow',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": "emit が落ちた（テスト用）",
        "flagAllows": [],
        "hookDone": false,
        "hookRejected": null,
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #6 が投げる（持ち時間切れ）: フックは拒否される。確認は外れている', async () => {
    expect(
      await runThrow({
        label: '#6',
        match: noteIncludes('フックの持ち時間切れ'),
        how: 'abort',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": null,
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
          "note: 分類器の拒否（manager:mgr-1・Bash）への1回だけの許可の確認が、フックの持ち時間切れで終わった。安全側で retry は返さない。答えが遅れて届いても、この確認は既に解決済みなので反映しない（issue #1105 P1）。",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #7 が投げる（deny）: フックは拒否される。許可は置かれない', async () => {
    expect(
      await runThrow({
        label: '#7',
        match: noteIncludes('1回だけの許可を出さなかった'),
        how: 'deny',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": "resolved",
        "flagAllows": [],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）への1回だけの許可を出さなかった: ok",
        ],
        "retryDecision": "continue",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('規則を足した note が投げる（allow）: フックは拒否される。許可と規則は置かれている（置き終えてから note）', async () => {
    expect(
      await runThrow({
        label: 'rule',
        match: noteIncludes('一時規則としてこのセッションに足した（'),
        how: 'allow',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": "resolved",
        "flagAllows": [
          [
            "Bash(echo hi)",
          ],
        ],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo hi",
        ],
        "retryDecision": "allow",
        "status": "running",
        "waiting": [],
      }
    `);
  });

  it('note #8 が投げる（allow）: フックは拒否される。許可と規則は置かれている（retry を返す前に置き終える）', async () => {
    expect(
      await runThrow({
        label: '#8',
        match: noteIncludes('1回だけ許可した'),
        how: 'allow',
      }),
    ).toMatchInlineSnapshot(`
      {
        "answerOutcome": "resolved",
        "flagAllows": [
          [
            "Bash(echo hi)",
          ],
        ],
        "hookDone": true,
        "hookRejected": "emit が落ちた（テスト用）",
        "hookValue": undefined,
        "late": {
          "delivered": false,
        },
        "log": [
          "note: 分類器の拒否のフックが届いた（manager:mgr-1・Bash・tool_use_id=tu-t）。理由の先頭: 分類器が拒否した（テスト）（issue #1766）",
          "ask: tu-t (permission)",
          "settled: tu-t",
          "note: 分類器が止めた manager:mgr-1 の Bash 呼び出しを、クローンの allow を受けて、同じ入力の1回だけを通す一時規則としてこのセッションに足した（担当 mgr-1・10分で外す。そのセッションの他の作業者が同じ入力を撃っても、1回使えば外れる。#4905）。入力の先頭（伏せ字）: echo hi",
          "note: クローンが分類器の拒否（manager:mgr-1・Bash）を1回だけ許可した。同じ入力で撃ち直されたときにだけ、10分以内なら1回通す（issue #1105 P1）。撃ち直すかどうかは担い手のモデルが決めることで、retry は「もう一度試してよい」という助言でしかない（撃ち直しが来なければ、この許可は使われないまま期限が切れる）。同じ入力の1回だけを10分通す一時規則をこのセッションに足した（そのセッションの他の作業者にも効く。#4905）。撃ち直すなら入力を1字も変えないこと。それでも拒否されたら、別の手（入力を変える・手順を分ける・人間に頼む）を取ること。担い手へ manager_send で伝えるときも、この趣旨で書く。これで通るかは確かめていない。",
        ],
        "retryDecision": "allow",
        "status": "running",
        "waiting": [],
      }
    `);
  });
});
