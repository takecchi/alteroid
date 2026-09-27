import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * issue #1768（横断レビュー14回目、PR #1750 のあとで見つかった穴）— 1回だけの
 * 許可（issue #1105 P1）の一致鍵が **入力全体ではなく `command` の文字列だけ**
 * だった、という「許しすぎる側」の穴を固定する。
 *
 * **疑いの根**: `denial-input-head.ts` の `rawLineOf` は、`tool_input` が
 * `command` という文字列欄を持つオブジェクトなら **その欄だけ** を取り出す
 * （`Bash` はこの形）。修正前の `runner.ts` の `#onPermissionDenied` /
 * `#consumeOneShotAllow` は、どちらもこの `rawLineOf` の結果をダイジェスト
 * して一致鍵にしていた——つまり **`command` 以外の欄（`run_in_background` /
 * `dangerouslyDisableSandbox` 等）は一致鍵に一切反映されていなかった。**
 *
 * PR #1750 の歯（「入力が1文字違えば返さない」など、`runner-permission-denied-p1.test.ts`
 * の「入力が1文字違えば通さない」）は、どれも `command` の文字列だけを変えて
 * いた。`command` 以外の欄を変える対照が無かったため、この穴には気づかれて
 * いなかった。
 *
 * **直したもの**: 一致鍵の材料を `rawLineOf`（表示用。`command` だけを返す）
 * から `matchInputOf`（入力全体を、キー順に依らない形で正規化したもの）へ
 * 差し替えた（`denial-input-head.ts`）。表示（`buildDenialInputHead` が作る
 * `inputHead`）は変えていない。
 *
 * この歯が測るのは3つである。
 *
 * 1. `run_in_background` だけが違う撃ち直しは、もう通らない（issue #1768 の
 *    「赤を取った例」そのもの）
 * 2. `dangerouslyDisableSandbox` だけが違う撃ち直しも、もう通らない（issue
 *    #1768 の「測っていないが、同じ形に当たるはずの例」——ここで赤を取る）
 * 3. **キー順だけが違う、内容が同一の入力は、引き続き同じ入力として扱われ
 *    通る**（対照。入力全体を鍵にする直し方が「キー順の違いだけで別物に
 *    なる」という別の壊れ方をしていないことを見る）
 */

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

/** `options.hooks.PermissionDenied[0].hooks[0]` を直接叩く。 */
async function firePermissionDenied(
  options: Options,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PermissionDenied フックが登録されていない');
  return hook(input as never, undefined, { signal });
}

/** `options.hooks.PreToolUse[0].hooks[0]` を直接叩く。 */
async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-permission-denied-p1-scope-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

function setup(): { host: RunnerHost; started: Started[] } {
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fn,
    env: {},
  });
  return { host, started };
}

async function startSession(): Promise<{ started: Started; host: RunnerHost }> {
  const s = setup();
  await s.host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const started = s.started[0];
  if (started === undefined) throw new Error('セッションが開いていない');
  return { started, host: s.host };
}

describe('一致鍵は入力全体を見る（issue #1768、横断レビュー14）', () => {
  it('run_in_background:false で許可を得た後、run_in_background:true の撃ち直しを通してはならない', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-run-in-background';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: false },
      tool_use_id: 'tu-scope-1',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-1',
      decision: 'allow',
      message: 'この前景コマンドなら1回だけ許可する。',
    });
    await denialPromise;

    // **同じ command・別の run_in_background** での撃ち直し。
    // クローンが実際に見て許可したのは前景（run_in_background: false）の
    // 呼び出しであって、背景（run_in_background: true）の呼び出しではない。
    const backgroundRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: true },
      tool_use_id: 'tu-scope-1-retry-background',
    });

    // 一致鍵が入力全体（run_in_background を含む）を見ているので、これは
    // 「別の入力」であり continue（一致せず、分類器の判定へ委ねる）になる。
    expect(backgroundRetry).toEqual({ continue: true });

    // **対照: 同じ入力（run_in_background: false も込みで完全一致）なら通る。**
    const exactRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, run_in_background: false },
      tool_use_id: 'tu-scope-1-retry-exact',
    });
    const asRecord = exactRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('dangerouslyDisableSandbox だけが違う撃ち直しを通してはならない（issue #1768「測っていないが同じ形」）', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-sandbox';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: false },
      tool_use_id: 'tu-scope-2',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-2',
      decision: 'allow',
      message: 'サンドボックスの中でなら1回だけ許可する。',
    });
    await denialPromise;

    // クローンが見て許可したのはサンドボックスの中の実行であって、
    // サンドボックスを外した実行ではない。
    const sandboxOffRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: true },
      tool_use_id: 'tu-scope-2-retry-sandbox-off',
    });
    expect(sandboxOffRetry).toEqual({ continue: true });

    // **対照: 同じ入力なら通る。**
    const exactRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, dangerouslyDisableSandbox: false },
      tool_use_id: 'tu-scope-2-retry-exact',
    });
    const asRecord = exactRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('欄の並び順だけが違う、内容が同一の入力は同じ入力として通す（対照。厳しすぎる側の壊れ方をしていないこと）', async () => {
    const { started, host: h } = await startSession();

    const command = 'echo scope-probe-key-order';

    const denialPromise = firePermissionDenied(started.options, {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Bash',
      // ここでの欄の並びは command → run_in_background → timeout。
      tool_input: { command, run_in_background: false, timeout: 5000 },
      tool_use_id: 'tu-scope-3',
      reason: '分類器が拒否した（テスト）',
    });
    await tick();

    await h.answer('mgr-1', {
      requestId: 'tu-scope-3',
      decision: 'allow',
      message: 'どうぞ。',
    });
    await denialPromise;

    // 撃ち直しは **同じ内容だが、オブジェクトの欄の並びが違う**
    // （timeout → command → run_in_background）。一致鍵はキー順に依らない
    // 正規化を使うので、これは「同じ入力」として通るべきである。
    const reorderedRetry = await firePreToolUse(started.options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { timeout: 5000, command, run_in_background: false },
      tool_use_id: 'tu-scope-3-retry-reordered',
    });
    const asRecord = reorderedRetry as { hookSpecificOutput?: Record<string, unknown> };
    expect(asRecord.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});
