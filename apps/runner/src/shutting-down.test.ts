import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { Outbox } from './app.js';

/**
 * Issue #2749 — runner は畳み始めた時点で `shutting_down` を名乗る。デーモンはこれを
 * 聞いた runner の SSE が閉じるまで待つ（`packages/core/src/manager-runner-farewell.test.ts`）。
 *
 * ここが測るのは**runner 側の半分**: 実物の `createRunnerHost` と実物の `Outbox` を
 * 組み、`Host#shutdown()` を通したあと、箱の中で `shutting_down` が畳みの出来事
 * （`archive` / `shutdown_unpushed_work`）より**先**に積まれていること。
 * 足場の `fakeSdk` は `shutdown-report.test.ts` のものを複製してある（duplicated on purpose）。
 */

function fakeSdk(): {
  fn: typeof sdkQuery;
  sessions: { postToolUse(input: unknown): Promise<unknown> }[];
} {
  const sessions: { postToolUse(input: unknown): Promise<unknown> }[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let finish: (() => void) | null = null;
    sessions.push({
      async postToolUse(input) {
        const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
        if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
        return hook(input as never, undefined, { signal: new AbortController().signal } as never);
      },
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-shutting-down',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-shutting-down-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('runner は畳み始めたら shutting_down を、畳みの出来事より先に outbox へ積む（#2749）', () => {
  it('Host#shutdown() のあと、shutting_down が1回だけ積まれ、畳みの archive / shutdown_unpushed_work はその後ろに並ぶ', async () => {
    const outbox = new Outbox();
    const { fn, sessions } = fakeSdk();
    const host = createRunnerHost({
      runnerId: 'runner-2749',
      workspacePath: '/work/project',
      emit: (event) => outbox.push(event),
      queryFn: fn,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-2749', request: '調べて', cwd: '/work/project' });
    const session = sessions[0];
    if (session === undefined) throw new Error('セッションが開いていない');
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '畳む直前の生ログ', 'utf8');
    await session.postToolUse({
      tool_name: 'Bash',
      tool_input: {},
      transcript_path: transcriptPath,
    });

    // 購読者が居ない（デーモンが先に終わった形）まま畳む。残った箱を後から読み出す。
    expect(outbox.subscribed).toBe(false);
    await host.shutdown();

    const seen: RunnerEvent[] = [];
    outbox.attach((event) => seen.push(event));
    const types = seen.map((event) => event.type);

    const at = types.indexOf('shutting_down');
    expect(at).toBeGreaterThan(-1);
    expect(types.filter((type) => type === 'shutting_down')).toHaveLength(1);
    // 畳みの出来事は、すべて名乗りより後ろ。名乗りより前に積まれていた走行中の出来事
    // （session / tool_use / 走行中の archive など）とは区別する。
    const afterNotice = types.slice(at + 1);
    expect(afterNotice).toContain('archive');
    expect(afterNotice).toContain('shutdown_unpushed_work');
    expect(types.lastIndexOf('archive')).toBeGreaterThan(at);
    expect(types.lastIndexOf('shutdown_unpushed_work')).toBeGreaterThan(at);
    expect(types.indexOf('shutdown_unpushed_work')).toBeGreaterThan(at);
    expect(seen[at]).toEqual({ type: 'shutting_down', runnerId: 'runner-2749' });
  });
});
