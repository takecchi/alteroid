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

/**
 * issue #1980（#1960 / PR #1963 の歯の穴）。`runner.ts` の `#onPreToolUse` は、Bash の
 * ガードの deny が周りの例外で消えないように3か所を包んでいる。PR #1963 の歯
 * （`runner-pre-tool-use.test.ts` の「ガードの deny は、判定の周りの例外で消えない」）が
 * 見ているのは、弾いたときの note の送り出しが投げる分岐だけだった。ここでは残りの2つを見る。
 *
 * 1. `inspectBashCommand` そのものが投げたら、deny（閉じる側）を返す
 * 2. `#capturePreToolInputHead`（中で `buildDenialInputHead` を呼ぶ）が投げても、判定を
 *    止めない——弾く形の Bash は deny、弾かない形は今までどおり通す
 *
 * 投げる状況は、実際の入力では作れていない（issue #1980 の「確かめていないこと」）。
 * そこで `vi.mock` で2つの関数だけを差し替え、切り替えの印（`vi.hoisted`）が立って
 * いる it でだけ投げさせる。印が倒れている it では本物の実装に任せる。
 *
 * **このファイルを `runner-pre-tool-use.test.ts` に混ぜないこと。** `vi.mock` は
 * ファイル全体に効くので、混ぜると向こうの歯まで差し替えた実装の上で走る。
 */

const throwing = vi.hoisted(() => ({ inspect: false, inputHead: false }));

vi.mock('./bash-wait-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bash-wait-guard.js')>();
  return {
    ...actual,
    inspectBashCommand: (...args: Parameters<typeof actual.inspectBashCommand>) => {
      if (throwing.inspect) throw new Error('判定器が落ちた（テスト用）');
      return actual.inspectBashCommand(...args);
    },
  };
});

vi.mock('./denial-input-head.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denial-input-head.js')>();
  return {
    ...actual,
    buildDenialInputHead: (...args: Parameters<typeof actual.buildDenialInputHead>) => {
      if (throwing.inputHead) throw new Error('入力の頭の控えが落ちた（テスト用）');
      return actual.buildDenialInputHead(...args);
    },
  };
});

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: { options: Options }[] } {
  const started: { options: Options }[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;
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
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

const PRE_TOOL_USE_BASE = { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1' };
// 弾く形（無限待ち）と、弾かない形。
const BLOCKED_COMMAND = 'tail -f /tmp/run.log';
const ALLOWED_COMMAND = 'echo hi';

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-pre-tool-use-throws-');
  throwing.inspect = false;
  throwing.inputHead = false;
});

afterEach(async () => {
  throwing.inspect = false;
  throwing.inputHead = false;
  await host?.shutdown().catch(() => undefined);
});

async function startedOptions(): Promise<Options> {
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const options = started[0]?.options;
  if (options === undefined) throw new Error('セッションが開いていない');
  return options;
}

function bash(command: string): Record<string, unknown> {
  return { ...PRE_TOOL_USE_BASE, tool_name: 'Bash', tool_input: { command } };
}

const DENY = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } };

describe('ガードの判定そのものが投げたら、閉じる側（deny）へ倒す（issue #1980 の 2）', () => {
  it('inspectBashCommand が投げると、弾かない形の Bash でも deny を返す', async () => {
    const options = await startedOptions();
    throwing.inspect = true;

    const result = await firePreToolUse(options, bash(ALLOWED_COMMAND));

    expect(result).toMatchObject(DENY);
  });

  it('対照: inspectBashCommand が投げなければ、弾かない形の Bash は今までどおり通す', async () => {
    const options = await startedOptions();

    const result = await firePreToolUse(options, bash(ALLOWED_COMMAND));

    expect(result).toEqual({ continue: true });
  });
});

describe('入力の頭の控えが投げても、判定を止めない（issue #1980 の 1）', () => {
  it('buildDenialInputHead が投げても、弾く形の Bash は deny を返す', async () => {
    const options = await startedOptions();
    throwing.inputHead = true;

    const result = await firePreToolUse(options, bash(BLOCKED_COMMAND));

    expect(result).toMatchObject(DENY);
  });

  it('buildDenialInputHead が投げても、弾かない形の Bash は今までどおり通す', async () => {
    const options = await startedOptions();
    throwing.inputHead = true;

    const result = await firePreToolUse(options, bash(ALLOWED_COMMAND));

    expect(result).toEqual({ continue: true });
  });
});
