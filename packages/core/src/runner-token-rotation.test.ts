import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

/**
 * **走行中のマネージャーのセッションに、回した認証トークンを届ける**
 * （fix/recycle-manager-session-on-token-rotation）。
 *
 * 穴の形は PR #454（クローン側。`recycleSessionForToken`）とまったく同じ —— SDK
 * 子プロセスの env は起動時に凍るので、回した鍵は「これから起こす」分にしか
 * 届かない。クローンは #454 で塞いだが、**走行中のマネージャーは塞がれていなかった**
 * （`Host#setCredentials` が `this.#credentials.set(entries)` を呼ぶだけで、
 * どのセッションにも触っていなかった）。ここで固定するのはその直しである。
 *
 * ## ⚠️ 偽 SDK の作り
 *
 * PR #454 の本文（`git log -1 --format=%B d27a90f`）が「1回目は3本とも何も
 * 測っていなかった」と書いている——共有の `fakeSdk`（`for await` で1件ずつ処理し、
 * ターン中に入力ストリームへ次を要求しない）では、`#inputStream` の境界判定が
 * 「ターンが走っている」状態で一度も発火しない。**ここでは `clone.ts` の
 * `lookaheadSdk` / `abortOnStreamEndSdk` と同じ形**（出力側が `prompt` の
 * イテレータを直接読み、結果を出す前に次の入力を読み先行しておく）を、
 * RunnerSession が持つ追加の軸（確認待ち・背景処理・session_id の有無）を
 * 制御できるように拡張して使う。
 */

interface FakeManagerSession {
  inputs: readonly string[];
  /** マネージャーが本文を1つ喋る（ターンの途中の逐次配信を模す）。 */
  say(text: string): void;
  /** 確認を1件開く（`waiting_human` を作る）。わざと答えない。 */
  ask(toolName: string, input: Record<string, unknown>): void;
  /** 背景タスクの在り高を通知する（REPLACE 意味論）。 */
  backgroundTasksChanged(tasks: readonly { id: string; taskType: string }[]): void;
  /** もう一度 init（`session_started`）を流す。`session_id` を明示させる。 */
  restartInit(sessionId: string): void;
  /** 1ターンを畳む（`result`）。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): void;
  /**
   * **SDK が自分の理由でストリームを閉じる**（クラッシュ・resume 不能など）。
   *
   * **`#inputStream` 側から入力を閉じる（`abortOnInputClose`）とは別物。**
   * こちらは入力の状態に関係なく、出力側（`generate()`）が自分から
   * `return` して `for await` を正常終了させる——「畳み直しの意図
   * （`#recycleForToken`）が立っている最中に、SDK が自分の理由で閉じる」
   * という (b) の形を再現するためだけに足した。
   */
  crash(): void;
}

/**
 * **読み先行し、必要なら入力の口が閉じたらターンを捨てる偽 SDK。**
 *
 * - `abortOnInputClose: false`（既定）—— `clone.ts` の `lookaheadSdk` と同じ。
 *   入力が尽きても、そのターンの結果は必ず出す。
 * - `abortOnInputClose: true` —— `clone.ts` の `abortOnStreamEndSdk` と同じ。
 *   入力の口が閉じたら、そのとき組み立て中のターンを結果を出さずに捨てる。
 *   「ターンの途中で畳んでいないか」を検出するのに使う——途中で畳んでいれば、
 *   `finish()` が積んだ `result` がそもそも生成側へ届かない。
 *
 * `skipInit: true` の最初のセッションだけ、起動直後の `system/init` を出さない
 * （`#sessionId` がまだ無い状態を作るための限定用途。`restartInit()` で後から
 * 出せる）。
 *
 * **⚠️ 本物の SDK がどちらの側かは測っていない。** PR #454 の本文と同じ注記——
 * この歯が守るのは「どちらでも壊れない」ことであって「本物がこう振る舞う」では
 * ない。
 */
function fakeSdk(opts: { abortOnInputClose?: boolean; skipInit?: boolean } = {}): {
  fn: typeof sdkQuery;
  sessions: FakeManagerSession[];
  startedOptions: Options[];
} {
  const abortOnInputClose = opts.abortOnInputClose ?? false;
  const sessions: FakeManagerSession[] = [];
  const startedOptions: Options[] = [];
  let seq = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const isFirstSession = sessions.length === 0;
    startedOptions.push(params.options as Options);
    const label =
      (params.options as Options | undefined)?.resume ?? `sess-${String(sessions.length + 1)}`;
    const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
      Symbol.asyncIterator
    ]();
    const inputs: string[] = [];
    const queued: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let crashed = false;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (message: SDKMessage) => {
      queued.push(message);
      notify();
    };

    const session: FakeManagerSession = {
      inputs,
      say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: label,
          uuid: `uuid-say-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
          })),
          session_id: label,
          uuid: `uuid-bg-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      ask(toolName, input) {
        const canUseTool = params.options?.canUseTool;
        if (canUseTool === undefined) throw new Error('canUseTool が配線されていない');
        // わざと await しない（`#onPermission` は最初の await の手前で `#pending`
        // へ同期的に積む。`runner-background-tasks.test.ts` の `ask()` と同じ形）。
        void canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${String(++seq)}`,
          requestId: `req-${String(++seq)}`,
        } as never);
      },
      restartInit(sessionId) {
        push({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          uuid: `uuid-init-restart-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      finish(text, options = {}) {
        push({
          type: 'result',
          subtype: options.subtype ?? 'success',
          result: text,
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
      },
      crash() {
        crashed = true;
        notify();
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (!(opts.skipInit === true && isFirstSession)) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: label,
          uuid: `uuid-init-${String(sessions.length)}`,
        } as unknown as SDKMessage;
      }

      let pendingInput = iterator.next();
      for (;;) {
        const current = await pendingInput;
        if (current.done === true) return;
        inputs.push(String(current.value.message.content));

        // **読み先行。** このターンの結果を出す前に、次の入力を要求しておく
        // （`clone.ts` の `lookaheadSdk` と同じ理由——`#inputStream` の境界判定が
        // 「ターンが走っている」状態で実際に発火するのは、この形のときだけ）。
        const lookahead = iterator.next();

        let sawResult = false;
        while (!sawResult) {
          // **SDK が自分の理由で閉じた（`crash()`）。** 入力の状態に関係なく
          // 即座に `return` する——「畳み直しの意図が立っている最中に、SDK が
          // 自分の理由でストリームを閉じた」という (b) の形を作るためだけの
          // 分岐（`FakeManagerSession.crash` の doc）。
          if (crashed) return;
          const queuedNext = queued.shift();
          if (queuedNext !== undefined) {
            if (queuedNext.type === 'result') sawResult = true;
            yield queuedNext;
            continue;
          }
          if (abortOnInputClose) {
            const raced = await Promise.race([
              lookahead.then(() => 'closed' as const),
              new Promise<'wake'>((resolve) => {
                wake = () => resolve('wake');
              }),
            ]);
            if (raced === 'closed') return; // 入力の口が閉じたので、このターンを捨てる
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }

        pendingInput = lookahead;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, startedOptions };
}

interface OutOfBandSession {
  /** マネージャーが本文を1つ喋る。 */
  say(text: string): void;
  /** 背景タスクの在り高を通知する（REPLACE 意味論）。 */
  backgroundTasksChanged(tasks: readonly { id: string; taskType: string }[]): void;
  /** 1ターンを畳む（`result`）。既定は成功。 */
  finish(text: string, options?: { subtype?: string; isError?: boolean }): void;
}

/**
 * **入力の消費と対にならない偽 SDK。**
 *
 * 上の `fakeSdk`（「読み先行」モデル）は、SDK からのメッセージ（`queued`）を
 * 「新しい入力を1つ読んだ直後」の内側 while ループでしか流さない —— ターンの
 * 境界判定のタイミングを再現するために、わざとそう作ってある（doc 冒頭の
 * 「⚠️ 偽 SDK の作り」）。**その形では、この歯（#apply の `'background_tasks'`
 * 枝の起こし）が固定したい経路を再現できない** —— 固定したいのは「新しい
 * 入力を1本も伴わない、背景処理の完了だけが単独でターンの外へ届く」形その
 * ものであって、`fakeSdk` の「読み先行」モデルは入力を対にしない配送を
 * 表現できない。
 *
 * だからここだけ別に持つ。`say` / `finish` / `backgroundTasksChanged` を呼んだ
 * 瞬間にそのまま流す（入力を読んだかどうかを見ない）。入力側
 * （`params.prompt` ＝ 本物の `#inputStream()`）は別に読み続けるだけで中身を
 * 見ない —— ただし読み続けること自体は必須である。読まなければ本物の
 * `#inputStream` が一度も駆動されず、`#wakeInput()` が起こす対象
 * （`#inputWaiters`）が育たないので、境界判定そのものが走らない。
 *
 * **入力側が閉じたら出力側も閉じる。** 本物の SDK も、`#inputStream` が
 * 境界を認めて閉じれば自分の出力ストリームを終える（そうでなければ
 * `#reopenForTokenRotation` の引き金——「`q` が自然に終わったこと」——が
 * 一生発火しない）。ここでは、入力側の読み取りが `done` を見た瞬間に、
 * 出力側の待ち（`emit`）を `null` で解決して終わらせることでそれを再現する。
 */
function fakeSdkOutOfBand(): {
  fn: typeof sdkQuery;
  sessions: OutOfBandSession[];
  startedOptions: Options[];
} {
  const sessions: OutOfBandSession[] = [];
  const startedOptions: Options[] = [];
  let seq = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    startedOptions.push(params.options as Options);
    const label =
      (params.options as Options | undefined)?.resume ?? `sess-${String(sessions.length + 1)}`;

    let emit: ((message: SDKMessage | null) => void) | null = null;
    let outputEnded = false;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(message);
      } else {
        buffered.push(message);
      }
    };
    // **`emit` を解決する口を1つにまとめる。** 複数の場所（入力側の読み切り・
    // `close()`）でそれぞれ「在れば呼んで下ろす」を書くと、閉包を跨いだ
    // `emit` の絞り込みが場所によって崩れる（TS の制御フロー解析が、閉包の
    // 外で後から起きる代入をどこまで見るかは書いた位置に依存する）。
    // 呼び出す側は全員この関数越しに触るだけにする。
    const endOutput = () => {
      if (emit) {
        const resolve = emit;
        emit = null;
        resolve(null);
      }
    };

    const session: OutOfBandSession = {
      say(text) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: label,
          uuid: `uuid-say-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      backgroundTasksChanged(tasks) {
        push({
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: tasks.map((task) => ({
            task_id: task.id,
            task_type: task.taskType,
            description: '',
          })),
          session_id: label,
          uuid: `uuid-bg-${String(++seq)}`,
        } as unknown as SDKMessage);
      },
      finish(text, options = {}) {
        push({
          type: 'result',
          subtype: options.subtype ?? 'success',
          result: text,
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
          ...(options.isError === undefined ? {} : { is_error: options.isError }),
        } as unknown as SDKMessage);
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: label,
        uuid: `uuid-init-${String(sessions.length)}`,
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (outputEnded) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          // **競合の狭い窓を塞ぐ。** 直上の `outputEnded` 検査からここまでの
          // 間に await は無いので、この Promise の実行関数が動いている最中に
          // 入力側の読み取りが割り込むことは無い——それでも二重に検査する
          // のは、読みやすさより安全側に倒すため。
          if (outputEnded) {
            resolve(null);
            return;
          }
          emit = resolve;
        });
        if (message === null) return;
        yield message;
      }
    }

    // **入力側を読み続ける（中身は見ない）。** 読み切って `done` が出たら
    // （＝本物の `#inputStream` が境界を認めて閉じた）、出力側も終わらせる。
    void (async () => {
      const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          outputEnded = true;
          endOutput();
          return;
        }
      }
    })();

    const generator = generate();
    return Object.assign(generator, {
      close: endOutput,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, startedOptions };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alteroid-runner-token-rotation-'));
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
  rmSync(dir, { recursive: true, force: true });
});

/** 本物のトークンに似せない、明らかな作り物の値（AGENTS.md「秘密の扱い」）。 */
const OLD_TOKEN = 'token-fake-old-000';

function setup(fakeOpts?: Parameters<typeof fakeSdk>[0]) {
  const events: RunnerEvent[] = [];
  const { fn, sessions, startedOptions } = fakeSdk(fakeOpts);
  const credentials = createCredentialStore({
    dir: join(dir, 'creds'),
    seed: { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN },
    names: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    credentials,
  });
  hosts.push(host);
  return { host, events, sessions, startedOptions };
}

async function nthSession(
  sessions: readonly FakeManagerSession[],
  index: number,
): Promise<FakeManagerSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) {
      throw new Error(`${String(index + 1)}本目のセッションがまだ開いていない`);
    }
    return found;
  });
}

function setupOutOfBand() {
  const events: RunnerEvent[] = [];
  const { fn, sessions, startedOptions } = fakeSdkOutOfBand();
  const credentials = createCredentialStore({
    dir: join(dir, 'creds-oob'),
    seed: { CLAUDE_CODE_OAUTH_TOKEN: OLD_TOKEN },
    names: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    credentials,
  });
  hosts.push(host);
  return { host, events, sessions, startedOptions };
}

async function nthOutOfBandSession(
  sessions: readonly OutOfBandSession[],
  index: number,
): Promise<OutOfBandSession> {
  return vi.waitFor(() => {
    const found = sessions[index];
    if (!found) {
      throw new Error(`${String(index + 1)}本目のセッションがまだ開いていない`);
    }
    return found;
  });
}

type ReportEvent = Extract<RunnerEvent, { type: 'report' }>;
type NoteEvent = Extract<RunnerEvent, { type: 'note' }>;

async function reportEvents(
  events: readonly RunnerEvent[],
  expected: number,
): Promise<ReportEvent[]> {
  return vi.waitFor(() => {
    const found = events.filter((event): event is ReportEvent => event.type === 'report');
    if (found.length < expected) {
      throw new Error(
        `report が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
      );
    }
    return found;
  });
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('認証トークンを回した後、走行中のマネージャーのセッションを畳んで開き直す', () => {
  it('⚠️ ターンの途中では畳まない。走っているターンは最後まで走る', async () => {
    // **捨てる SDK で測る**（`abortOnInputClose: true`）。入力の口を途中で
    // 閉じていれば、このターンは結果を出さずに捨てられ、下の `reportEvents` が
    // 永久に届かずタイムアウトする——これが「途中で畳んだ」ことの検出器である。
    const s = setup({ abortOnInputClose: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    // 読み先行が発行され、ターンが「走っている」状態になるまで待つ。
    await tick(10);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-111' }]);
    await tick();

    // ターンの途中では、まだ畳まれていない（新しいセッションが開いていない）。
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');

    // ターンが最後まで走って report が届くこと（捨てられていないこと）。
    const [report] = await reportEvents(s.events, 1);
    expect(report?.text).toContain('わかった');
  });

  it('ターンの境界で、指紋が変わったときだけ畳んで開き直す（同じ指紋では開き直さない）', async () => {
    const s = setup({ abortOnInputClose: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    await tick(10);

    // **同じ指紋**（再接続の追いつかせ = `createRunnerTokenSync` と同じ形）。
    // 畳まれてはいけない。
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    // **指紋が変わる差し替え。** ただしターンはまだ走っているので、ここでも
    // まだ畳まれない。
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-222' }]);
    await tick();
    expect(s.sessions).toHaveLength(1);

    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    // ここでようやくターンの境界 ⟹ 開き直る。
    await nthSession(s.sessions, 1);
    expect(s.sessions).toHaveLength(2);
    // 開き直した子プロセスの env に新しい値が載っている。
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-222');
    // 開き直しは resume（同じ sessionId）で行われる。
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
    expect(s.startedOptions[0]?.resume).toBeUndefined();
  });

  it('同じ指紋を何度渡しても開き直さない（再接続の追いつかせが繰り返し呼んでも壊れない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: OLD_TOKEN }]);
    await tick(40);

    expect(s.sessions).toHaveLength(1);
  });

  it('確認待ちが在るあいだは畳まない。答えて片付いた境界で畳む', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.ask('Bash', { command: 'echo hi' }); // わざと答えない
    first.finish('確認をお願いします');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.status).toBe('waiting_human');

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-333' }]);
    await tick(30);
    // 確認待ちが残っているので、まだ畳まれていない。印は落ちていない
    // （後続で実際に畳まれることが、印が残っていたことの証拠になる）。
    expect(s.sessions).toHaveLength(1);

    const requestId = s.host.list()[0]?.waiting[0]?.requestId;
    if (requestId === undefined) throw new Error('waiting が見つからない');
    await s.host.answer('mgr-1', { requestId, decision: 'allow', message: 'どうぞ' });
    await tick();
    // 答えた直後は `running` に戻るだけで、まだ境界ではない。
    expect(s.sessions).toHaveLength(1);

    // **この偽 SDK は「1つの入力 ⟹ 1ターン」の形しか表せない**（`fakeSdk` の
    // doc）ので、答えた後の続きは新しい入力として押し込む。
    await s.host.send('mgr-1', '続けて');
    await tick(10);
    first.say('実行した');
    first.finish('実行した');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-333');
  });

  it('背景処理が生きているあいだは畳まない。片付いた境界で畳む', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.awaitingBackground).toBeDefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-444' }]);
    await tick(30);
    // 背景処理が残っているので、まだ畳まれていない。
    expect(s.sessions).toHaveLength(1);

    await s.host.send('mgr-1', '続けて');
    await tick(10);
    first.backgroundTasksChanged([]);
    first.say('続けました');
    first.finish('続けました');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-444');
  });

  it('#sessionId がまだ無ければ畳まない。session_started の後は畳む', async () => {
    const s = setup({ skipInit: true });
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    first.say('init を一度も見ていない状態で終える');
    first.finish('init を一度も見ていない状態で終える');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.status).toBe('done');
    expect(s.host.list()[0]?.sessionId).toBeUndefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-555' }]);
    await tick(30);
    // `#sessionId` が無いので resume できない ⟹ 畳まない。
    expect(s.sessions).toHaveLength(1);

    // ここで初めて init が届く（同じ session のまま——現実の SDK も同一
    // session_id で送ってくる想定に合わせる）。
    first.restartInit('sess-late');
    await s.host.send('mgr-1', 'つづき');
    await tick(10);
    first.say('つづきの結果');
    first.finish('つづきの結果');
    await reportEvents(s.events, 2);

    await nthSession(s.sessions, 1);
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-555');
    expect(s.startedOptions[1]?.resume).toBe('sess-late');
  });

  it('跡（note）を1本出す。値も指紋の照合結果も書かない', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-666' }]);
    await tick(30);
    await nthSession(s.sessions, 1);

    const notes = s.events.filter((event): event is NoteEvent => event.type === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('認証トークン');
    expect(notes[0]?.text).not.toContain('token-fake-new-666');
    expect(notes[0]?.text).not.toContain(OLD_TOKEN);
  });

  /**
   * **`for await` が正常終了する理由は2つある**——(a) `#inputStream` が境界を
   * 認めて自分から `return` した（畳み直し）と、(b) SDK が自分の理由で
   * ストリームを閉じた（クラッシュ・resume 不能など）。この2つを
   * `#recycleForToken`（「畳みたい」という意図）という1つの計器だけで見分けると、
   * 意図が立ったまま境界がまだ来ていない状態で (b) が起きたときに、(a) と
   * 誤認して嘘の `note` を出し、答えていない確認を道連れにしたまま開き直る
   * （レビュー指摘）。**印を2本に分けて（`#endedInputForTokenRotation` を
   * 足して）直した——この歯はその分離を固定する。**
   */
  it('⚠️ 印が立っている最中に SDK が自分の理由で閉じても、畳み直しとして開き直さない（note も出ない）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);

    // 確認を1件開く（わざと答えない）。`#onPermission` は最初の await の手前で
    // `#pending` へ同期的に積み、`#status` を `waiting_human` にする——**まだ
    // `result` を出していない、ターンの途中**である（`ask()` の doc）。
    first.ask('Bash', { command: 'echo hi' });
    await tick();
    expect(s.host.list()[0]?.status).toBe('waiting_human');

    // 畳みたいという意図を立てる。境界条件（確認待ちが無い・ターンが
    // 走っていない）が揃わないので、`#inputStream` はまだ `return` しない
    // （`#recycleForToken` は立つが `#endedInputForTokenRotation` は立たない）。
    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-777' }]);
    await tick();
    // 境界条件が揃っていないので、まだ何も起きていない。
    expect(s.sessions).toHaveLength(1);

    // ここで SDK が自分の理由でストリームを閉じる（例: クラッシュ）。**まだ
    // `result` を出していない＝ターンの途中**なので、この偽 SDK の実装上も
    // まだ `finish()` を呼んでいない（＝ `crashed` の検査が効く場所に居る）。
    // `#recycleForToken` は立ったままだが、`#endedInputForTokenRotation` は
    // 立っていない——`#read` はこちらを見るので、畳み直しとしては扱わない。
    first.crash();

    // **従来どおりの経路（`#recoverFromFailedResume` → `#finish`）へ行き、
    // `closed` が出る**（セッションは畳まれて終わる——`start()` で作った
    // セッションには resume 素材が無いので `#recoverFromFailedResume` は
    // `not-a-resume-failure` を返し、`#finish('done', …)` に落ちる）。
    await vi.waitFor(() => {
      const found = s.events.filter((event) => event.type === 'closed');
      if (found.length === 0) throw new Error('closed がまだ届いていない');
      return found;
    });

    // **開き直っていない**（2本目のセッションが無い）。
    expect(s.sessions).toHaveLength(1);
    // **嘘の note が出ていない。**
    const notes = s.events.filter((event): event is NoteEvent => event.type === 'note');
    expect(notes).toHaveLength(0);
  });

  /**
   * 畳み直しの後もマネージャーが実際に使えること——「2本目が resume で開いた」
   * だけでなく、(1) `closed` が出ていない（出れば台帳から消える）ことと、
   * (2) 開き直した後に送った一言が新しいセッション側に実際に届くことを見る。
   */
  it('畳み直しの後もマネージャーは使える（closed が出ない・新しいセッションに入力が届く）', async () => {
    const s = setup();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthSession(s.sessions, 0);
    first.say('わかった');
    first.finish('わかった');
    await reportEvents(s.events, 1);

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-888' }]);
    const second = await nthSession(s.sessions, 1);

    // 畳み直しは runner の中でのプロセス入れ替えであって、デーモンから見た
    // 「終了」ではない——`closed` は1本も出ない。
    expect(s.events.some((event) => event.type === 'closed')).toBe(false);

    // 開き直した後にもう一言送ると、新しいセッション側の入力に届く
    // （＝マネージャーは引き続き使える）。
    await s.host.send('mgr-1', 'つづけて');
    await vi.waitFor(() => {
      if (!second.inputs.includes('つづけて')) {
        throw new Error('新しいセッションに入力が届いていない');
      }
    });

    second.say('つづけました');
    second.finish('つづけました');
    const reports = await reportEvents(s.events, 2);
    expect(reports[1]?.text).toContain('つづけました');
    // 最後まで `closed` は出ていない。
    expect(s.events.some((event) => event.type === 'closed')).toBe(false);
  });

  /**
   * **`#atTokenRecycleBoundary()` の4条件のうち `#liveBackgroundTasks.length
   * === 0` が「後から」満たされたときに、誰も `#inputStream` を起こさない穴**
   * の直しを固定する（`#apply` の `'background_tasks'` の枝に足した起こし）。
   *
   * **既存の「背景処理が生きているあいだは畳まない」の歯（上）とは、通る経路
   * が違う。** あちらは `host.send('mgr-1', '続けて')` を
   * `backgroundTasksChanged([])` より**先に**打っている——新しい入力
   * （`push()`）が起こし、その入力を消費したターンの `'result'` の枝の起こし
   * で境界を満たしているだけで、この歯が固定したい経路（新しい入力を伴わない
   * 単独の完了）を1本も通らない。**この歯は `host.send()` を1度も呼ばない。**
   *
   * 上の `fakeSdk`（読み先行モデル）ではこの経路を作れない——SDK からの
   * メッセージは必ず新しい入力を読んだ直後にしか流れないためで、だから
   * ここだけ `fakeSdkOutOfBand`（入力の消費と対にならない偽 SDK）を使う。
   */
  it('⚠️ 新しい入力を伴わない、背景処理の完了だけでも起こす（#apply の background_tasks 枝）', async () => {
    const s = setupOutOfBand();
    await s.host.start({ managerId: 'mgr-1', request: '調べて', cwd: '/work/project' });
    const first = await nthOutOfBandSession(s.sessions, 0);

    first.backgroundTasksChanged([{ id: 'bg-1', taskType: 'shell' }]);
    first.say('完了を待つ');
    first.finish('完了を待つ');
    const [firstReport] = await reportEvents(s.events, 1);
    expect(firstReport?.awaitingBackground).toBeDefined();

    await s.host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-999' }]);
    await tick(30);
    // 背景処理が残っているので、まだ畳まれていない。
    expect(s.sessions).toHaveLength(1);

    // **ここが直したい経路そのもの。** 新しい入力を1本も送らず、背景処理の
    // 完了だけを流す（`host.send()` を呼んでいない）。
    first.backgroundTasksChanged([]);

    await nthOutOfBandSession(s.sessions, 1);
    expect(s.sessions).toHaveLength(2);
    // 開き直した子プロセスの env に新しい値が載っている。
    expect(s.startedOptions[1]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-fake-new-999');
    // 開き直しは resume（同じ sessionId）で行われる。
    expect(s.startedOptions[1]?.resume).toBe('sess-1');
  });
});
