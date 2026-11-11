import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEventSink, fakeSdk, waitFor } from './clone-test-harness.js';
import { CloneDistillMemoryState } from './clone-distill-memory-state.js';
import { CloneGraves } from './clone-graves.js';
import { CloneSdkSession } from './clone-sdk-session.js';
import { CloneUsageLedger } from './clone-usage-ledger.js';
import { createClone } from './clone.js';
import { EXCHANGE_KIND_DECISION_PREFIX, EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';

// `Clone#read` の `finally` の後半（`clearQuery` から、文脈窓の畳み・開き直しの退避まで）を、外から固定する。
// 期待の値は仕様を先に書いたものではなく、今の出力から変えないための歯である。
// `vitest run <path> -u` でインライン snapshot を生成し、目で読んで確かめた値で、文面の正しさの保証ではない。本番コードは変えない。
// 既存の試験が縛っているのは、開き直しの結果（`clone-reopen-session`: 実の退避・断り・init の行・退避の行）と、
// 失敗の文面（`clone-failure-text-pin`）。ここが足すのは、縛っていない枝:
//   - 印の4通り（文脈窓のみ・開き直しのみ・両方・どちらも無し）で、`salvageTranscript` の呼び出しの回数と引数
//     （無引数 / `{ why: 'reopen', distill }`）、`recordReopenArchive` の呼び出しと引数（退避の結果 / `{ kind: 'none' }`）、
//     `takeContextWindowRecycle`・`takeReopen` の戻り、文脈窓が優先されて開き直しの日誌行が書かれないこと
//   - 古い session id を退避の前に控えること（退避の間に次のセッションが init する形）
//   - 印を退避の前に下ろすこと（退避の間に次のセッションへ立った開き直しの印を、この `finally` が読まない）
//   - 入力を閉じて終わったセッション（`inputEndedForRecycle`）は失敗の報告も `finishTurn` もしないこと
//   - 各 await の位置（microtask の周回数）と、`#read` 全体の完了の周回数
// `#read` の Promise は `Clone#stop` だけが待つ（`reader?.catch`）。完了の周回数は `CloneSdkSession#open` に渡る reader を横から見て数える。
// 駆動は本物の `Clone` に、例外を投げる・入力を閉じて終わる偽の `queryFn` を繋ぐ。
// `CloneGraves#salvageTranscript` は偽に差し替える（実の退避・蒸留は既存の試験が縛る）: 呼び出しの時刻と引数を記録し、決まった周回数の後に返す。
// microtask は `await Promise.resolve()` を数える歯（実時間は使わない）。周回数は「例外を投げる・入力が閉じる」瞬間から数える。

const WINDOW_FAILURE = 'prompt is too long';
const SALVAGE_TICKS = 3;

type Archive = { kind: 'saved'; id: string } | { kind: 'none' } | { kind: 'failed' };

class Clock {
  n = 0;
  #live = true;
  start(): void {
    void (async () => {
      for (let i = 0; i < 2000 && this.#live; i += 1) {
        this.n += 1;
        await Promise.resolve();
      }
    })();
  }
  stop(): void {
    this.#live = false;
  }
}

type Fn = (...args: unknown[]) => unknown;

function wrap(
  proto: object,
  key: string,
  hooks: { before?: (args: unknown[]) => void; after?: (result: unknown) => void },
): void {
  const methods = proto as Record<string, Fn>;
  const original = methods[key] as Fn;
  vi.spyOn(methods, key).mockImplementation(function (this: unknown, ...args: unknown[]) {
    hooks.before?.(args);
    const result = original.apply(this, args);
    hooks.after?.(result);
    return result;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

interface Plan {
  /** 1ターン目を答えさせてから、2ターン目を失敗にする。文脈窓の畳みは1度も答えていないセッションでは `held` で畳まないため */
  readonly answerFirst?: boolean;
  /** 失敗のターンの最中に `reopenSession` で開き直しの印を立てる */
  readonly reopen?: { readonly distill: boolean };
  /** 文脈窓の失敗（`prompt is too long`）で落とす。偽なら関係の無い失敗 */
  readonly window?: boolean;
  /** 失敗ではなく、境界で `reopenSession` を受けて入力を閉じて終わる（`inputEndedForRecycle`） */
  readonly boundary?: boolean;
  /** `boundary` で、入力が閉じた後も `releaseBoundary` が呼ばれるまで古いセッションを終わらせない（その間に次のターンが立つ） */
  readonly boundaryHold?: boolean;
  /** 退避が終わらず待っている間に、`between` が動かせるようにする（`between` が開ける） */
  readonly salvageGate?: Promise<void>;
  readonly salvageResult?: Archive;
}

interface Tools {
  readonly clone: ReturnType<typeof createClone>;
  readonly stores: ReturnType<typeof createMemoryStores>;
  readonly marks: () => string[];
  /** `setSdkSessionId` に渡った id（`init` を `Clone` が処理した順） */
  readonly initedIds: () => string[];
  /** `beginTurn` が呼ばれた回数 */
  readonly turnsBegun: () => number;
  readonly releaseBoundary: () => void;
  /** 2つ目のセッションの1ターン目を閉じさせる */
  readonly releaseSecond: () => void;
  readonly count: (type: 'done' | 'error') => number;
}

async function drive(plan: Plan, between?: (tools: Tools) => Promise<void>) {
  // 1本の試験で `drive` を2回呼んでも、前の回の差し替えを包まない（包むと自分を呼び続ける）
  vi.restoreAllMocks();
  const clock = new Clock();
  let log: string[] = [];
  const mark = (label: string) => log.push(`${label} @+${String(clock.n)}`);
  const t0 = () => {
    log = [];
    clock.n = -1;
    clock.start();
  };

  wrap(CloneUsageLedger.prototype, 'flushSessionUsage', {
    before: () => mark('flushSessionUsage'),
  });
  wrap(CloneSdkSession.prototype, 'clearQuery', { before: () => mark('clearQuery') });
  wrap(CloneDistillMemoryState.prototype, 'forgetMemory', { before: () => mark('forgetMemory') });
  wrap(CloneSdkSession.prototype, 'finishTurn', { before: () => mark('finishTurn') });
  wrap(CloneSdkSession.prototype, 'takeContextWindowRecycle', {
    after: (result) => mark(`takeContextWindowRecycle -> ${String(result)}`),
  });
  wrap(CloneSdkSession.prototype, 'takeReopen', {
    after: (result) => mark(`takeReopen -> ${JSON.stringify(result)}`),
  });
  wrap(CloneDistillMemoryState.prototype, 'recordReopenArchive', {
    before: (args) => mark(`recordReopenArchive(${JSON.stringify(args[0])})`),
  });
  const initedIds: string[] = [];
  wrap(CloneSdkSession.prototype, 'setSdkSessionId', {
    before: (args) => {
      if (typeof args[0] === 'string') initedIds.push(args[0]);
    },
  });
  let turnsBegun = 0;
  wrap(CloneSdkSession.prototype, 'beginTurn', {
    before: () => {
      turnsBegun += 1;
    },
  });
  let readDone = false;
  let opened = 0;
  wrap(CloneSdkSession.prototype, 'open', {
    before: (args) => {
      opened += 1;
      // 最初のセッションの reader だけを見る（2つ目は `Clone#stop` まで終わらない）
      if (opened !== 1) return;
      const reader = args[1] as Promise<void>;
      void reader.then(() => {
        mark('read.done');
        readDone = true;
      });
    },
  });
  const salvageCalls: string[] = [];
  vi.spyOn(CloneGraves.prototype, 'salvageTranscript').mockImplementation(async (...args) => {
    const shown = args.length === 0 ? '()' : `(${JSON.stringify(args[0])})`;
    salvageCalls.push(shown);
    mark(`salvageTranscript${shown} enter`);
    for (let i = 0; i < SALVAGE_TICKS; i += 1) await Promise.resolve();
    await plan.salvageGate;
    mark(`salvageTranscript${shown} exit`);
    return plan.salvageResult ?? { kind: 'saved', id: 'arch-1' };
  });

  let releaseFailing: () => void = () => undefined;
  const failingGate = new Promise<void>((resolve) => {
    releaseFailing = resolve;
  });
  let failingInFlight = false;
  // 2つ目のセッションは、`releaseSecond` が呼ばれるまで1ターン目を閉じない
  let releaseSecond: () => void = () => undefined;
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let releaseBoundary: () => void = () => undefined;
  const boundaryGate = new Promise<void>((resolve) => {
    releaseBoundary = resolve;
  });
  let sessionCount = 0;
  const queryFn = ((params: { prompt: AsyncIterable<unknown> }) => {
    sessionCount += 1;
    const sessionNumber = sessionCount;
    const id = `sess-${String(sessionNumber)}`;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: id,
        uuid: `uuid-init-${id}`,
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      let turn = 0;
      for await (const message of params.prompt) {
        void message;
        const failingTurn = plan.answerFirst === true ? 1 : 0;
        if (sessionNumber === 1 && plan.boundary !== true && turn === failingTurn) {
          failingInFlight = true;
          await failingGate;
          t0();
          throw new Error(plan.window === true ? WINDOW_FAILURE : 'boom');
        }
        if (sessionNumber === 2) await secondGate;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'わかった' }] },
          parent_tool_use_id: null,
          session_id: id,
          uuid: `uuid-assistant-${id}-${String(turn)}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'わかった',
          session_id: id,
          uuid: `uuid-result-${id}-${String(turn)}`,
        } as unknown as SDKMessage;
        turn += 1;
      }
      // 入力が閉じて（`#inputStream` が境界で return して）ここへ来る
      if (plan.boundary === true && sessionNumber === 1) {
        if (plan.boundaryHold === true) await boundaryGate;
        t0();
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const stores = createMemoryStores();
  const journalLines: string[] = [];
  const append = stores.journal.append.bind(stores.journal);
  stores.journal.append = async (entry) => {
    if (entry.type === 'exchange') {
      if (entry.text.startsWith(EXCHANGE_KIND_FAILURE_PREFIX)) mark('journal(失敗の行)');
      if (entry.text.includes('開き直す前の生ログ')) mark('journal(開く前の生ログの行)');
      // 時刻や別の行を載せない（snapshot が動くため）: 見るのは「開く前の生ログ」の行だけ
      if (entry.text.includes('開き直す前の生ログ')) journalLines.push(entry.text);
    }
    return append(entry);
  };

  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const sink = createEventSink();
  clone.subscribe('conv-1', (event) => {
    if (event.type === 'error') mark('emit(error)');
    sink.push(event);
  });

  const reopen = (distill: boolean) => clone.reopenSession?.({ reason: 'r', distill, actor: 'a' });

  clone.post(humanMessage('msg-1', 'conv-1'));
  if (plan.boundary === true) {
    await sink.waitForEvents((events) => events.some((event) => event.type === 'done'));
    await reopen(false);
  } else {
    if (plan.answerFirst === true) {
      await sink.waitForEvents((events) => events.some((event) => event.type === 'done'));
      clone.post(humanMessage('msg-2', 'conv-1'));
    }
    await waitFor(() => failingInFlight, '失敗のターンが走り出すこと');
    if (plan.reopen !== undefined) await reopen(plan.reopen.distill);
    releaseFailing();
  }
  if (between !== undefined) {
    await between({
      clone,
      stores,
      marks: () => [...log],
      initedIds: () => [...initedIds],
      turnsBegun: () => turnsBegun,
      releaseBoundary,
      releaseSecond,
      count: (type) => sink.events.filter((event) => event.type === type).length,
    });
  }
  await waitFor(() => readDone, '#read が終わること');
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
  clock.stop();
  const snapshot = {
    log: [...log],
    salvageCalls: [...salvageCalls],
    journalLines: journalLines.map((line) => line.slice(EXCHANGE_KIND_DECISION_PREFIX.length)),
  };
  releaseSecond();
  await clone.stop();
  return snapshot;
}

const salvageLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.startsWith('開き直す前の生ログ'));

describe('Clone#read の finally — 印の4通り', () => {
  it('どちらの印も無い: 退避も開き直しの記録も無い（失敗の報告・畳み・記憶の忘却は走る）', async () => {
    const out = await drive({});
    expect(out.salvageCalls).toEqual([]);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [],
        "log": [
          "emit(error) @+8",
          "journal(失敗の行) @+9",
          "finishTurn @+18",
          "flushSessionUsage @+18",
          "clearQuery @+20",
          "forgetMemory @+20",
          "takeContextWindowRecycle -> false @+20",
          "takeReopen -> null @+20",
          "read.done @+21",
        ],
        "salvageCalls": [],
      }
    `);
  });

  it('文脈窓の畳みだけ: 無引数で退避し、開き直しの記録も日誌行も無い', async () => {
    const out = await drive({ answerFirst: true, window: true });
    expect(out.salvageCalls).toEqual(['()']);
    expect(salvageLines(out.journalLines)).toEqual([]);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [],
        "log": [
          "emit(error) @+8",
          "journal(失敗の行) @+10",
          "finishTurn @+19",
          "flushSessionUsage @+19",
          "clearQuery @+21",
          "forgetMemory @+21",
          "takeContextWindowRecycle -> true @+21",
          "takeReopen -> null @+21",
          "salvageTranscript() enter @+21",
          "salvageTranscript() exit @+25",
          "read.done @+27",
        ],
        "salvageCalls": [
          "()",
        ],
      }
    `);
  });

  it('開き直しだけ（distill: false）: why: reopen・distill: false で退避し、結果を記録し、開く前の生ログの行を書く', async () => {
    const out = await drive({ reopen: { distill: false } });
    expect(out.salvageCalls).toEqual(['({"why":"reopen","distill":false})']);
    expect(salvageLines(out.journalLines)).toEqual([
      '開き直す前の生ログ（古い session id: sess-1）: 退避: arch-1',
    ]);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [
          "開き直す前の生ログ（古い session id: sess-1）: 退避: arch-1",
        ],
        "log": [
          "emit(error) @+8",
          "journal(失敗の行) @+9",
          "finishTurn @+18",
          "flushSessionUsage @+18",
          "clearQuery @+20",
          "forgetMemory @+20",
          "takeContextWindowRecycle -> false @+20",
          "takeReopen -> {"distill":false} @+20",
          "salvageTranscript({"why":"reopen","distill":false}) enter @+20",
          "salvageTranscript({"why":"reopen","distill":false}) exit @+24",
          "recordReopenArchive({"kind":"saved","id":"arch-1"}) @+25",
          "journal(開く前の生ログの行) @+25",
          "read.done @+30",
        ],
        "salvageCalls": [
          "({"why":"reopen","distill":false})",
        ],
      }
    `);
  });

  it('開き直しだけ（distill: true）: distill: true が退避へ渡る', async () => {
    const out = await drive({ reopen: { distill: true } });
    expect(out.salvageCalls).toEqual(['({"why":"reopen","distill":true})']);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [
          "開き直す前の生ログ（古い session id: sess-1）: 退避: arch-1",
        ],
        "log": [
          "emit(error) @+8",
          "journal(失敗の行) @+9",
          "finishTurn @+18",
          "flushSessionUsage @+18",
          "clearQuery @+20",
          "forgetMemory @+20",
          "takeContextWindowRecycle -> false @+20",
          "takeReopen -> {"distill":true} @+20",
          "salvageTranscript({"why":"reopen","distill":true}) enter @+20",
          "salvageTranscript({"why":"reopen","distill":true}) exit @+24",
          "recordReopenArchive({"kind":"saved","id":"arch-1"}) @+25",
          "journal(開く前の生ログの行) @+25",
          "read.done @+30",
        ],
        "salvageCalls": [
          "({"why":"reopen","distill":true})",
        ],
      }
    `);
  });

  it('退避の結果が failed / none でも、そのまま記録し、そのまま日誌へ書く', async () => {
    const failed = await drive({ reopen: { distill: false }, salvageResult: { kind: 'failed' } });
    const none = await drive({ reopen: { distill: false }, salvageResult: { kind: 'none' } });
    expect({
      failed: salvageLines(failed.journalLines),
      none: salvageLines(none.journalLines),
      failedRecord: failed.log.filter((line) => line.startsWith('recordReopenArchive')),
      noneRecord: none.log.filter((line) => line.startsWith('recordReopenArchive')),
    }).toMatchInlineSnapshot(`
      {
        "failed": [
          "開き直す前の生ログ（古い session id: sess-1）: ⚠️ 退避できなかった。古いセッションの生ログは器の外に残っていない",
        ],
        "failedRecord": [
          "recordReopenArchive({"kind":"failed"}) @+25",
        ],
        "none": [
          "開き直す前の生ログ（古い session id: sess-1）: 退避するものが無かった",
        ],
        "noneRecord": [
          "recordReopenArchive({"kind":"none"}) @+25",
        ],
      }
    `);
  });

  it('両方の印: 文脈窓が優先され（無引数）、開き直しの日誌行は書かれず、{ kind: none } が記録される', async () => {
    const out = await drive({ answerFirst: true, window: true, reopen: { distill: false } });
    expect(out.salvageCalls).toEqual(['()']);
    expect(salvageLines(out.journalLines)).toEqual([]);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [],
        "log": [
          "emit(error) @+8",
          "journal(失敗の行) @+10",
          "finishTurn @+19",
          "flushSessionUsage @+19",
          "clearQuery @+21",
          "forgetMemory @+21",
          "takeContextWindowRecycle -> true @+21",
          "takeReopen -> {"distill":false} @+21",
          "salvageTranscript() enter @+21",
          "salvageTranscript() exit @+25",
          "recordReopenArchive({"kind":"none"}) @+26",
          "read.done @+27",
        ],
        "salvageCalls": [
          "()",
        ],
      }
    `);
  });
});

describe('Clone#read の finally — 入力を閉じて終わったセッション', () => {
  it('開き直しの境界で入力が閉じた: 失敗の報告も finishTurn もせず、開き直しの退避は走る', async () => {
    const out = await drive({ boundary: true });
    expect(out.log.some((line) => line.startsWith('emit(error)'))).toBe(false);
    expect(out.log.some((line) => line.startsWith('journal(失敗の行)'))).toBe(false);
    expect(out.log.some((line) => line.startsWith('finishTurn'))).toBe(false);
    expect(out).toMatchInlineSnapshot(`
      {
        "journalLines": [
          "開き直す前の生ログ（古い session id: sess-1）: 退避: arch-1",
        ],
        "log": [
          "flushSessionUsage @+2",
          "clearQuery @+4",
          "forgetMemory @+4",
          "takeContextWindowRecycle -> false @+4",
          "takeReopen -> {"distill":false} @+4",
          "salvageTranscript({"why":"reopen","distill":false}) enter @+4",
          "salvageTranscript({"why":"reopen","distill":false}) exit @+8",
          "recordReopenArchive({"kind":"saved","id":"arch-1"}) @+9",
          "journal(開く前の生ログの行) @+9",
          "read.done @+14",
        ],
        "salvageCalls": [
          "({"why":"reopen","distill":false})",
        ],
      }
    `);
  });
});

describe('Clone#read の finally — 入力を閉じた後に次のターンが立っていた', () => {
  it('立っているターンは次のセッションを待っている次のターンなので、失敗にも解決にもしない（そのターンは次のセッションで答える）', async () => {
    let counts = { done: 0, error: 0 };
    const out = await drive({ boundary: true, boundaryHold: true }, async (tools) => {
      // 入力が閉じた後、古いセッションが終わる前に次のターンが立つ（`#ensureQuery` は `clearQuery` を待つ）
      tools.clone.post(humanMessage('msg-2', 'conv-1'));
      await waitFor(() => tools.turnsBegun() >= 2, '次のターンが立つこと');
      tools.releaseBoundary();
      tools.releaseSecond();
      await waitFor(() => tools.count('done') >= 2, '次のターンが次のセッションで答えること');
      counts = { done: tools.count('done'), error: tools.count('error') };
    });
    expect(counts).toEqual({ done: 2, error: 0 });
    // 次のターンが次のセッションで終わるときの `finishTurn` は、古い `#read` の完了より後（ここでは数えない）
    const untilReadDone = out.log.slice(
      0,
      out.log.findIndex((line) => line.startsWith('read.done')),
    );
    expect(untilReadDone.some((line) => line.startsWith('emit(error)'))).toBe(false);
    expect(untilReadDone.some((line) => line.startsWith('journal(失敗の行)'))).toBe(false);
    expect(untilReadDone.some((line) => line.startsWith('finishTurn'))).toBe(false);
    expect(untilReadDone).toMatchInlineSnapshot(`
      [
        "flushSessionUsage @+2",
        "clearQuery @+4",
        "forgetMemory @+4",
        "takeContextWindowRecycle -> false @+4",
        "takeReopen -> {"distill":false} @+4",
        "salvageTranscript({"why":"reopen","distill":false}) enter @+4",
        "salvageTranscript({"why":"reopen","distill":false}) exit @+8",
        "recordReopenArchive({"kind":"saved","id":"arch-1"}) @+9",
        "journal(開く前の生ログの行) @+9",
      ]
    `);
  });
});

describe('Clone#read の finally — 退避の間に次のセッションが動く', () => {
  it('古い session id は退避の前に控える: 退避の間に次のセッションが init しても、行は古い id を名乗る', async () => {
    let release: () => void = () => undefined;
    const salvageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let duringGate: string[] = [];
    const out = await drive({ reopen: { distill: false }, salvageGate }, async (tools) => {
      await waitFor(
        () => tools.marks().some((line) => line.startsWith('salvageTranscript')),
        '退避に入ること',
      );
      // 退避の間: `clearQuery` は済んでいるので、次のセッションが開いて init する
      tools.clone.post(humanMessage('msg-2', 'conv-1'));
      await waitFor(() => tools.initedIds().includes('sess-2'), '次のセッションが init すること');
      const rows = (await tools.stores.journal.list({ types: ['exchange'] })) as {
        text: string;
      }[];
      duringGate = rows
        .map((row) => row.text.slice(EXCHANGE_KIND_DECISION_PREFIX.length))
        .filter((text) => text.startsWith('開き直'))
        .sort();
      release();
    });
    expect(duringGate).toMatchInlineSnapshot(`
      [
        "開き直した: sess-1 → sess-2（退避はまだ終わっていない）",
      ]
    `);
    expect(salvageLines(out.journalLines)).toMatchInlineSnapshot(`
      [
        "開き直す前の生ログ（古い session id: sess-1）: 退避: arch-1",
      ]
    `);
  });

  it('印は退避の前に下ろす: 退避の間に次のセッションへ立った開き直しの印を、この finally は読まない', async () => {
    let release: () => void = () => undefined;
    const salvageGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const out = await drive({ answerFirst: true, window: true, salvageGate }, async (tools) => {
      await waitFor(
        () => tools.marks().some((line) => line.startsWith('salvageTranscript')),
        '退避に入ること',
      );
      tools.clone.post(humanMessage('msg-3', 'conv-1'));
      await waitFor(() => tools.initedIds().includes('sess-2'), '次のセッションが init すること');
      // 次のセッションへ開き直しの印を立てる。この `finally` が印を退避の後で読むなら、ここで拾う
      await tools.clone.reopenSession?.({ reason: 'r', distill: false, actor: 'a' });
      release();
    });
    expect(out.salvageCalls).toEqual(['()']);
    expect(out.log.filter((line) => line.startsWith('recordReopenArchive'))).toEqual([]);
    // 退避を待たせたので、周回数は載せない（時計の上限に張り付く）
    expect({
      ...out,
      log: out.log.map((line) => line.replace(/ @\+\d+$/, '')),
    }).toMatchInlineSnapshot(`
      {
        "journalLines": [],
        "log": [
          "emit(error)",
          "journal(失敗の行)",
          "finishTurn",
          "flushSessionUsage",
          "clearQuery",
          "forgetMemory",
          "takeContextWindowRecycle -> true",
          "takeReopen -> null",
          "salvageTranscript() enter",
          "salvageTranscript() exit",
          "read.done",
        ],
        "salvageCalls": [
          "()",
        ],
      }
    `);
  });
});
