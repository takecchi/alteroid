import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

// 1ターン目: 出し箱にファイルを置き、背景処理（作業者）を1本残したまま結果を出す（`background: false` なら残さない）
function fakeSdk(
  onTurn: () => Promise<void>,
  { background = true }: { background?: boolean } = {},
): { fn: typeof sdkQuery; options: Options[] } {
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
        if (background) {
          yield {
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: '' }],
            session_id: 'sess-1',
            uuid: `uuid-bg-${n}`,
          } as unknown as SDKMessage;
        }
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

async function startHost(
  managerId: string,
  outboxRoot: string,
  outboxStagedRoot: string,
  fake: ReturnType<typeof fakeSdk>,
  events: RunnerEvent[],
): Promise<void> {
  const host = createRunnerHost({
    runnerId: `runner-${managerId}`,
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
  await host.start({ managerId, request: '依頼', cwd: '/workspace' });
}

// 担当の退避先を symlink にして、取り込み（`collectManagerOutbox`）そのものを投げさせる
// （root の symlink は #5134 で退けて作り直すようになったので、投げるのは担当ごとの dir 側）
async function brokenStagedRoot(prefix: string, managerId: string): Promise<string> {
  const base = await makeTempDir(prefix);
  const target = join(base, 'real');
  await mkdir(target);
  const staged = join(base, 'staged');
  await mkdir(staged);
  await symlink(target, join(staged, managerId));
  return staged;
}

describe('Host: 背景処理が残るターンの出し箱', () => {
  it('⭐ 背景処理の完了待ちで畳んだターンでも、出し箱の中身を取り込んで報告に添える（出し箱に置き去りにしない）', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-bg-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-bg-staged-');
    const events: RunnerEvent[] = [];
    const outboxDir = join(outboxRoot, 'mgr-bg');
    const fake = fakeSdk(async () => {
      await writeFile(join(outboxDir, 'compare.png'), '成果物');
    });
    await startHost('mgr-bg', outboxRoot, outboxStagedRoot, fake, events);

    await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    expect(report.awaitingBackground).toEqual({ count: 1, breakdown: 'local_agent×1' });
    expect(report.files?.map((file) => file.name)).toEqual(['compare.png']);
    expect(await readdir(outboxDir)).toEqual([]);
  });

  it.each([
    { label: '背景処理の完了待ちで畳んだターン', background: true },
    { label: '背景処理の無いターン', background: false },
  ])(
    '⭐ $label で出し箱を取り込めなかったら、置かれた名前ごとの理由を報告に載せる（note だけで黙らない）',
    async ({ background }) => {
      const outboxRoot = await makeTempDir('runner-outbox-fail-');
      const outboxStagedRoot = await brokenStagedRoot('runner-outbox-fail-staged-', 'mgr-fail');
      const events: RunnerEvent[] = [];
      const outboxDir = join(outboxRoot, 'mgr-fail');
      const fake = fakeSdk(
        async () => {
          await writeFile(join(outboxDir, 'astra.png'), '絵');
          await writeFile(join(outboxDir, 'astra-2.png'), '絵2');
        },
        { background },
      );
      await startHost('mgr-fail', outboxRoot, outboxStagedRoot, fake, events);

      await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
      const report = events.find((e) => e.type === 'report');
      if (report?.type !== 'report') throw new Error('report が無い');
      expect(report.awaitingBackground !== undefined).toBe(background);
      expect(report.files).toBeUndefined();
      expect(report.rejectedFiles?.map((file) => file.name)).toEqual(['astra-2.png', 'astra.png']);
      for (const file of report.rejectedFiles ?? []) {
        expect(file.reason).toContain('出し箱を取り込めなかった');
        expect(file.reason).toContain('実在の dir でない');
      }
      // 断っても消さない: 退避先が直れば次の報告で送れる
      expect((await readdir(outboxDir)).sort()).toEqual(['astra-2.png', 'astra.png']);
      expect(
        events.some((e) => e.type === 'note' && e.text.startsWith('出し箱を取り込めなかった')),
      ).toBe(true);
    },
  );
});
