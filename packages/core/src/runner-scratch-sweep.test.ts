import { writeFile, mkdir, readdir, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runnerEventSchema, type RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { createManagerPool } from './manager.js';
import { createRunnerRegistry, type RunnerClient } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * runner の /tmp の片付けの配線（Issue #3039）。`scratch-sweep.test.ts` が判定の歯を持つ。
 * ここは Host の周期が `scratch_sweep` を（境界を通る形で）emit すること、`shutdown()` で
 * 周期が止まること、デーモン側が日誌へ残しクローンへ知らせることを固定する。
 */
/**
 * 偽の時計の下では `vi.waitFor` を使わない（確かめるたびに偽の時計を自分で進め、runner の周期を
 * 余分に回して回数がずれる）。時計を進めずに、`setImmediate` で I/O を回して条件を待つ。
 */
async function settle(condition: () => boolean, maxTurns = 5000): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('条件が満たされなかった');
}

describe('runner の周期と shutdown（#3039）', () => {
  let tmp: string;
  let host: RunnerHost | undefined;
  beforeEach(async () => {
    tmp = await makeTempDir('runner-scratch-');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await host?.shutdown().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  });

  it('猶予の過ぎた作業場を消して scratch_sweep を出し、shutdown 後は動かない', async () => {
    // 周期（setInterval）だけを偽の時計にし、I/O は実物のまま。実時間では待たない。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await writeFile(path.join(tmp, 'mgr-aaaa1111-x.log'), '');
    let readdirCalls = 0;
    let readdirDone = 0;
    const events: RunnerEvent[] = [];
    host = createRunnerHost({
      runnerId: 'runner-x',
      workspacePath: '/work',
      emit: (e) => events.push(runnerEventSchema.parse(JSON.parse(JSON.stringify(e)))),
      env: { PATH: process.env.PATH },
      scratchSweep: {
        tmpRoot: tmp,
        graceMs: 0,
        intervalMs: 20,
        readdirFn: async (dir) => {
          readdirCalls += 1;
          try {
            return await readdir(dir, { withFileTypes: true });
          } finally {
            readdirDone += 1;
          }
        },
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    await settle(() => events.some((e) => e.type === 'scratch_sweep'));
    expect(existsSync(path.join(tmp, 'mgr-aaaa1111-x.log'))).toBe(false);
    const sweep = events.find((e) => e.type === 'scratch_sweep');
    expect(sweep).toMatchObject({
      runnerId: 'runner-x',
      removed: [{ name: 'mgr-aaaa1111-x.log' }],
    });
    // 何も無い回は送らない。周期を1つ進めるごとに、その回の片付け（readdir の完了）が終わるのを
    // 待ってから次を進める（重ねて撃たない仕様なので、終わる前に進めると回数がずれる）。
    await settle(() => readdirDone === readdirCalls);
    await new Promise((r) => setImmediate(r));
    const before = readdirCalls;
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(20);
      await settle(() => readdirCalls === before + i + 1 && readdirDone === readdirCalls);
      await new Promise((r) => setImmediate(r));
    }
    expect(events.filter((e) => e.type === 'scratch_sweep')).toHaveLength(1);

    await host.shutdown();
    await mkdir(path.join(tmp, 'mgr-bbbb2222'));
    const afterShutdown = readdirCalls;
    await vi.advanceTimersByTimeAsync(200);
    await new Promise((r) => setImmediate(r));
    expect(readdirCalls).toBe(afterShutdown);
    expect(existsSync(path.join(tmp, 'mgr-bbbb2222'))).toBe(true);
  });
});

describe('担い手向け添付の置き場の定期掃除（#3205）', () => {
  let tmp: string;
  let host: RunnerHost | undefined;
  beforeEach(async () => {
    tmp = await makeTempDir('runner-att-prune-');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await host?.shutdown().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  });

  it('添付を置かない間も、周期で古い置き場が消える。生きた委譲でなく新しいものは残る', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scratch = path.join(tmp, 'scratch');
    const root = path.join(tmp, 'attachments');
    await mkdir(scratch);
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    for (const id of ['mgr-stale', 'mgr-fresh']) {
      await mkdir(path.join(root, id, 'att'), { recursive: true });
      await writeFile(path.join(root, id, 'att', 'a.txt'), 'x');
    }
    await utimes(path.join(root, 'mgr-stale'), old, old);
    host = createRunnerHost({
      runnerId: 'runner-x',
      workspacePath: '/work',
      emit: () => undefined,
      env: { PATH: process.env.PATH },
      attachmentsRoot: root,
      scratchSweep: { tmpRoot: scratch, intervalMs: 20 },
    });
    await vi.advanceTimersByTimeAsync(20);
    await settle(() => !existsSync(path.join(root, 'mgr-stale')));
    expect(existsSync(path.join(root, 'mgr-fresh'))).toBe(true);
  });
});

describe('デーモン側: 日誌とクローンへの知らせ（#3039）', () => {
  function setup() {
    let handler: ((e: RunnerEvent) => void) | null = null;
    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];
    const runner = {
      runnerId: 'runner-x',
      runnerIdKnown: true,
      workspacePath: '/w',
      workspacePathKnown: true,
      async connect(h: (e: RunnerEvent) => void) {
        handler = h;
      },
      async list() {
        return [];
      },
      async close() {},
    } as unknown as RunnerClient;
    const pool = createManagerPool({
      stores,
      post: (e) => inbox.push(e),
      runners: createRunnerRegistry([runner]),
    });
    return { stores, inbox, pool, send: (e: RunnerEvent) => handler?.(e) };
  }

  it('消した分は日誌だけ。残した分は日誌とクローンの受信箱へ（未追跡の名前・statfs 付き）', async () => {
    const { stores, inbox, pool, send } = setup();
    await pool.restore();
    send({
      type: 'scratch_sweep',
      runnerId: 'runner-x',
      removed: [
        {
          name: 'mgr-aaaa1111',
          kind: 'directory',
          managerId: 'mgr-aaaa1111-0000',
          untracked: { count: 1, names: ['repo/scratch.txt'] },
        },
      ],
      kept: [],
      statfs: { totalBytes: 100, usedBytes: 50, totalInodes: 1000, usedInodes: 900 },
    });
    await vi.waitFor(async () => {
      expect((await stores.journal.list()).length).toBeGreaterThan(0);
    });
    const text = JSON.stringify(await stores.journal.list());
    expect(text).toContain('mgr-aaaa1111');
    expect(text).toContain('repo/scratch.txt');
    expect(text).toContain('inode 900/1000');
    expect(inbox.filter((e) => e.type === 'external')).toEqual([]);

    send({
      type: 'scratch_sweep',
      runnerId: 'runner-x',
      removed: [
        { name: 'mgr-cccc3333', kind: 'node_modules', count: 1, paths: ['repo/node_modules'] },
      ],
      kept: [],
    });
    await vi.waitFor(async () => {
      expect(JSON.stringify(await stores.journal.list())).toContain('repo/node_modules');
    });
    expect(inbox.filter((e) => e.type === 'external')).toEqual([]);

    send({
      type: 'scratch_sweep',
      runnerId: 'runner-x',
      removed: [],
      kept: [
        {
          name: 'mgr-bbbb2222',
          kind: 'directory',
          reason: 'unpushed-commits',
          count: 2,
          detail: '未 push 2',
        },
      ],
    });
    await vi.waitFor(() => {
      expect(inbox.filter((e) => e.type === 'external')).toHaveLength(1);
    });
    const ext = inbox.find((e) => e.type === 'external');
    expect(JSON.stringify(ext)).toContain('mgr-bbbb2222');
    expect(JSON.stringify(await stores.journal.list())).toContain('unpushed-commits');
  });
});
