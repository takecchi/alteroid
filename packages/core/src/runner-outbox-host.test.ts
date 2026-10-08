import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { RUNNER_CAPABILITIES, RUNNER_CAPABILITY_MANAGER_OUTBOX } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/** 入力を受けるたびに1ターン返す偽の SDK。`onTurn` はターンの結果を返す直前に呼ばれる（担い手が出し箱へ写す時機）。 */
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
          type: 'result',
          subtype: 'success',
          result: '終わった',
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

describe('Host: 出し箱（Issue #4126 P2a）', () => {
  it('hello の能力に manager-outbox が載る', () => {
    expect(RUNNER_CAPABILITIES).toContain(RUNNER_CAPABILITY_MANAGER_OUTBOX);
    expect(RUNNER_CAPABILITY_MANAGER_OUTBOX).toBe('manager-outbox');
  });

  it('ALTEROID_OUTBOX が渡り、ターンの報告に files が載り、中身は取れて、畳みで出し箱だけが消え退避先は残る', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-host-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-host-staged-');
    const events: RunnerEvent[] = [];
    let outboxDir = '';
    const fake = fakeSdk(async () => {
      await writeFile(join(outboxDir, 'result.txt'), '成果物');
    });
    const host = createRunnerHost({
      runnerId: 'runner-outbox',
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
    await host.start({ managerId: 'mgr-abc123', request: '依頼', cwd: '/workspace' });
    await vi.waitFor(() => expect(fake.options).toHaveLength(1));
    const env = fake.options[0]?.env as Record<string, string | undefined>;
    outboxDir = join(outboxRoot, 'mgr-abc123');
    expect(env.ALTEROID_OUTBOX).toBe(outboxDir);

    await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    expect(report.files).toHaveLength(1);
    expect(report.files?.[0]).toMatchObject({
      name: 'result.txt',
      size: Buffer.byteLength('成果物'),
    });
    const fileId = report.files?.[0]?.fileId ?? '';
    expect(await readdir(outboxDir)).toEqual([]);

    const opened = await host.openOutboxFile('mgr-abc123', fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('成果物');
    expect(await readFile(join(outboxStagedRoot, 'mgr-abc123', fileId), 'utf8')).toBe('成果物');

    await host.stop('mgr-abc123');
    // 畳みは `stop` が返る前に `onClosed` まで進む（`closed` イベントを出す経路は `#finish` で別）
    await expect(stat(outboxDir)).rejects.toThrow();
    // 退避先は残る: 最後の報告の直後に畳まれても、デーモンが取りに来られる
    const after = await host.openOutboxFile('mgr-abc123', fileId);
    const afterChunks: Buffer[] = [];
    for await (const chunk of after!.stream) afterChunks.push(chunk as Buffer);
    expect(Buffer.concat(afterChunks).toString()).toBe('成果物');
    expect(await host.deleteOutboxFile('mgr-abc123', fileId)).toBe(true);
    expect(await host.openOutboxFile('mgr-abc123', fileId)).toBeUndefined();
  });

  it('子を降ろす構成では、畳みで出し箱の中身を runner の権限で再帰削除せず、子の権限の削除関数へ渡す', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-host-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-host-staged-');
    const calls: string[][] = [];
    const fake = fakeSdk(async () => undefined);
    const host = createRunnerHost({
      runnerId: 'runner-outbox-child',
      workspacePath: '/workspace',
      emit: () => undefined,
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      childUser: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
      outboxRoot,
      outboxStagedRoot,
      outboxRemoveContentsAsChild: (entries) => calls.push([...entries]),
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);
    await host.start({ managerId: 'mgr-abc123', request: '依頼', cwd: '/workspace' });
    const dir = join(outboxRoot, 'mgr-abc123');
    expect((await stat(dir)).mode & 0o7777).toBe(0o2770);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'inner.txt'), 'x');
    await host.stop('mgr-abc123');
    expect(calls).toEqual([[join(dir, 'sub')]]);
    expect(await readFile(join(dir, 'sub', 'inner.txt'), 'utf8')).toBe('x');
  });
});
