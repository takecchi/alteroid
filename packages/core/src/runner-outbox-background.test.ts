import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// 1ターン目: 出し箱にファイルを置き、背景処理（作業者）を1本残したまま結果を出す
function fakeSdk(onTurn: () => Promise<void>): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    options.push(params.options ?? {});
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      let n = 0;
      for await (const message of params.prompt) {
        void message;
        await onTurn();
        n += 1;
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: '' }],
          session_id: 'sess-1',
          uuid: `uuid-bg-${n}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '作業者の完了を待つ',
          session_id: 'sess-1',
          uuid: `uuid-result-${n}`,
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, options };
}

let hosts: RunnerHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('Host: 背景処理が残るターンの出し箱', () => {
  it('⭐ 背景処理の完了待ちで畳んだターンでも、出し箱の中身を取り込んで報告に添える（出し箱に置き去りにしない）', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-bg-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-bg-staged-');
    const events: RunnerEvent[] = [];
    const outboxDir = join(outboxRoot, 'mgr-bg');
    const fake = fakeSdk(async () => {
      await writeFile(join(outboxDir, 'compare.png'), '成果物');
    });
    const host = createRunnerHost({
      runnerId: 'runner-outbox-bg',
      workspacePath: '/workspace',
      emit: (event) => events.push(event),
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      outboxRoot,
      outboxStagedRoot,
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);
    await host.start({ managerId: 'mgr-bg', request: '依頼', cwd: '/workspace' });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    expect(report.awaitingBackground).toEqual({ count: 1, breakdown: 'local_agent×1' });
    expect(report.files?.map((file) => file.name)).toEqual(['compare.png']);
    expect(await readdir(outboxDir)).toEqual([]);
  });
});
