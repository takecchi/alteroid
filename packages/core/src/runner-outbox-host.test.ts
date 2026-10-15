import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { RUNNER_CAPABILITIES, RUNNER_CAPABILITY_MANAGER_OUTBOX } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, EMITTED_PICKUP_STALE_MS, type RunnerHost } from './runner.js';

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
    await expect(stat(outboxDir)).rejects.toThrow();
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

// 結果（result）を出さないまま、閉じられたら終わる偽の SDK（#4675）。ターンの途中で畳まれた担当を作る
function interruptedSdk(onTurn: () => Promise<void>): { fn: typeof sdkQuery } {
  const fn = ((params: { prompt: AsyncIterable<unknown> }) => {
    let close: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt) {
        void message;
        await onTurn();
        await closed;
        return;
      }
    }
    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn };
}

describe('Host: 報告の前に畳まれた担当の出し箱（#4675）', () => {
  it('⭐ 出し箱に置いた後、結果を出す前に止められたら、取り込んで報告に添え、畳んだ後もデーモンが取りに来られる', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-close-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-close-staged-');
    const events: RunnerEvent[] = [];
    let outboxDir = '';
    let written = false;
    const fake = interruptedSdk(async () => {
      await writeFile(join(outboxDir, 'half-done.md'), '途中の成果物');
      written = true;
    });
    const host = createRunnerHost({
      runnerId: 'runner-outbox-close',
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
    await host.start({ managerId: 'mgr-close1', request: '依頼', cwd: '/workspace' });
    outboxDir = join(outboxRoot, 'mgr-close1');
    await vi.waitFor(() => expect(written).toBe(true));

    await host.stop('mgr-close1');

    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    expect(report.unreported).toBeDefined();
    expect(report.text).toContain('出し箱に置かれていた成果物を添える');
    expect(report.files?.map((file) => file.name)).toEqual(['half-done.md']);
    await expect(stat(outboxDir)).rejects.toThrow();
    const opened = await host.openOutboxFile('mgr-close1', report.files?.[0]?.fileId ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('途中の成果物');
  });

  it('出し箱が空で本文も無ければ、畳んでも報告は出さない（今までどおり）', async () => {
    const outboxRoot = await makeTempDir('runner-outbox-close-');
    const outboxStagedRoot = await makeTempDir('runner-outbox-close-staged-');
    const events: RunnerEvent[] = [];
    let started = false;
    const fake = interruptedSdk(async () => {
      started = true;
    });
    const host = createRunnerHost({
      runnerId: 'runner-outbox-close-empty',
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
    await host.start({ managerId: 'mgr-close2', request: '依頼', cwd: '/workspace' });
    await vi.waitFor(() => expect(started).toBe(true));
    await host.stop('mgr-close2');
    expect(events.some((e) => e.type === 'report')).toBe(false);
  });
});

describe('Host: 畳み（shutdown）で預けた物の数（#4699）', () => {
  async function hostWithHalfDoneManager(managerId: string) {
    const outboxRoot = await makeTempDir('runner-pickups-');
    const outboxStagedRoot = await makeTempDir('runner-pickups-staged-');
    const events: RunnerEvent[] = [];
    let written = false;
    const fake = interruptedSdk(async () => {
      await writeFile(join(outboxRoot, managerId, 'half-done.md'), '途中の成果物');
      written = true;
    });
    const host = createRunnerHost({
      runnerId: 'runner-pickups',
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
    await vi.waitFor(() => expect(written).toBe(true));
    return { host, events };
  }

  it('⭐ shutdown で添えた出し箱の退避先と預けた生ログを数え、デーモンが消すと外す', async () => {
    const { host, events } = await hostWithHalfDoneManager('mgr-pick1');

    await host.shutdown();

    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    const archives = events.flatMap((e) =>
      e.type === 'archive' && e.ref !== undefined ? [e.ref.id] : [],
    );
    expect(report.files).toHaveLength(1);
    expect(host.pendingPickups()).toBe(1 + archives.length);

    await host.deleteOutboxFile('mgr-pick1', report.files?.[0]?.fileId ?? '');
    for (const id of archives) host.deleteArchive('mgr-pick1', id);
    expect(host.pendingPickups()).toBe(0);
  });

  it('shutdown より前の stop で添えた物は数えない（取りこぼしを待って器の入れ替えを遅らせない）', async () => {
    const { host, events } = await hostWithHalfDoneManager('mgr-pick2');

    await host.stop('mgr-pick2');

    expect(events.some((e) => e.type === 'report' && (e.files?.length ?? 0) > 0)).toBe(true);
    expect(host.pendingPickups()).toBe(0);
  });
});

// 畳み始める前に emit した出し箱・未追跡の預かりの退避先のファイルも待たせる（#4912）
describe('Host: 畳み始める前に退避先へ置いた物も待ちに入る（#4912）', () => {
  const OUTBOX_ID = 'a'.repeat(32);
  const RESCUE_ID = 'b'.repeat(32);

  // 畳み始める前に、ターンの報告で出し箱のファイルを1つ emit した器。退避先には、このプロセスが送っていない前の残りも置く
  async function hostWithEmittedReport() {
    const outboxRoot = await makeTempDir('runner-emitted-');
    const outboxStagedRoot = await makeTempDir('runner-emitted-staged-');
    const rescueStagedRoot = await makeTempDir('runner-emitted-rescue-staged-');
    await mkdir(join(outboxStagedRoot, 'mgr-old'));
    await mkdir(join(rescueStagedRoot, 'mgr-old'));
    await writeFile(join(outboxStagedRoot, 'mgr-old', OUTBOX_ID), '前の担当の残り');
    await writeFile(join(rescueStagedRoot, 'mgr-old', RESCUE_ID), '前のプロセスの預かり');
    const events: RunnerEvent[] = [];
    const fake = fakeSdk(async () => {
      await writeFile(join(outboxRoot, 'mgr-early', 'result.txt'), '成果物');
    });
    const host = createRunnerHost({
      runnerId: 'runner-emitted',
      workspacePath: '/workspace',
      emit: (event) => events.push(event),
      queryFn: fake.fn,
      env: { PATH: '/usr/bin' },
      outboxRoot,
      outboxStagedRoot,
      rescueStagedRoot,
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);
    await host.start({ managerId: 'mgr-early', request: '依頼', cwd: '/workspace' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'report')).toBe(true));
    const report = events.find((e) => e.type === 'report');
    if (report?.type !== 'report') throw new Error('report が無い');
    const fileId = report.files?.[0]?.fileId ?? '';
    expect(fileId).not.toBe('');
    return { host, fileId };
  }

  it('⭐ 畳み始める前に emit した出し箱のファイルは待ちに入り、DELETE で外れる。退避先に残っていても送っていない物は入らない', async () => {
    const { host, fileId } = await hostWithEmittedReport();
    expect(host.pendingPickups()).toBe(0);

    await host.shutdown();
    // 前の残り（出し箱の mgr-old・預かりの mgr-old）は数えない
    expect(host.pendingPickups()).toBe(1);

    await host.deleteOutboxFile('mgr-early', fileId);
    expect(host.pendingPickups()).toBe(0);
  });

  it('⭐ 畳み始める前に取られた出し箱のファイルは、待ちに入らない', async () => {
    const { host, fileId } = await hostWithEmittedReport();
    await host.deleteOutboxFile('mgr-early', fileId);

    await host.shutdown();

    expect(host.pendingPickups()).toBe(0);
  });

  // 取りに行かないと決められた出し箱・預かりが、畳みのたびに上限まで待たせる（#4925）
  it('⭐ 送ってから一定時間を過ぎて取られていないものは、畳みの待ちに数えない。新しいものは数える', async () => {
    const { host } = await hostWithEmittedReport();
    // 時計だけを進める（実時間は待たない）
    vi.setSystemTime(Date.now() + EMITTED_PICKUP_STALE_MS - 1_000);
    try {
      const fresh = await hostWithEmittedReport();
      vi.setSystemTime(Date.now() + 2_000);
      await host.shutdown();
      expect(host.pendingPickups()).toBe(0);
      await fresh.host.shutdown();
      expect(fresh.host.pendingPickups()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ GET を読み切ったら、DELETE が来なくても待ちから外す', async () => {
    const { host, fileId } = await hostWithEmittedReport();
    await host.shutdown();

    const outbox = await host.openOutboxFile('mgr-early', fileId);
    // 読み始めただけでは外さない
    expect(host.pendingPickups()).toBe(1);
    for await (const chunk of outbox!.stream) void chunk;
    expect(host.pendingPickups()).toBe(0);
  });

  it('何も送っていない器は、退避先に残りがあっても待ちが0のまま', async () => {
    const outboxStagedRoot = await makeTempDir('runner-none-staged-');
    await mkdir(join(outboxStagedRoot, 'mgr-old'));
    await writeFile(join(outboxStagedRoot, 'mgr-old', OUTBOX_ID), '前の残り');
    const host = createRunnerHost({
      runnerId: 'runner-none',
      workspacePath: '/workspace',
      emit: () => undefined,
      queryFn: fakeSdk(async () => undefined).fn,
      env: { PATH: '/usr/bin' },
      outboxRoot: await makeTempDir('runner-none-root-'),
      outboxStagedRoot,
      rescueStagedRoot: await makeTempDir('runner-none-rescue-staged-'),
      scratchSweep: false,
      cwdExistsFn: () => true,
      readCgroupEventCountersFn: async () => ({}),
      finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    });
    hosts.push(host);
    await host.shutdown();
    expect(host.pendingPickups()).toBe(0);
  });
});
