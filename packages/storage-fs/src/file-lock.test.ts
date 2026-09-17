import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Commitment, Job } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from './atomic.js';
import { FsCommitmentStore } from './commitments.js';
import { LockTimeoutError, withPathLock } from './file-lock.js';
import { FsJobStore } from './jobs.js';
import { FsJournalStore } from './journal.js';
import { FsPersonaStore } from './persona.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'alteroid-lock-test-'));
});

describe('writeFileAtomic', () => {
  /**
   * #1050 の再現そのもの。かつては tmp 名が `${path}.tmp` で固定されており、
   * 2つの書き手が同時に書くと片方の rename が相手の tmp を踏んで ENOENT で
   * 落ちた。いまは呼び出しごとに一意な tmp 名（pid + uuid8）を持つので、
   * 同じ宛先へ同時に書いても両方が成功する。
   */
  it('同じ宛先へ2つの書き手が同時に書いても ENOENT で落ちない（#1050 の再現）', async () => {
    const target = join(root, 'shared.json');
    const contentA = 'A'.repeat(2000);
    const contentB = 'B'.repeat(2000);

    const results = await Promise.allSettled([
      writeFileAtomic(target, contentA),
      writeFileAtomic(target, contentB),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`書き込みが失敗した（ENOENT の再現の疑い）: ${String(result.reason)}`);
      }
    }
    const finalContent = await readFile(target, 'utf8');
    expect([contentA, contentB]).toContain(finalContent);
    // どちらの tmp も rename 後には残っていない。
    const leftoverTmp = (await readdir(root)).filter((name) => name.includes('.tmp.'));
    expect(leftoverTmp).toEqual([]);
  });

  /**
   * rename が失敗する形（宛先を既存のディレクトリにする＝ Linux では EISDIR）を
   * 作り、tmp が消し損ねられずに片付くことを見る。
   */
  it('rename が失敗したとき、tmp を残さず投げる', async () => {
    const target = join(root, 'blocked');
    await mkdir(target); // 宛先をディレクトリにして rename を必ず失敗させる。

    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();

    const leftoverTmp = (await readdir(root)).filter((name) => name.includes('.tmp.'));
    expect(leftoverTmp).toEqual([]);
  });

  it('mode が効く（0600 で作られる）', async () => {
    const target = join(root, 'secret');

    await writeFileAtomic(target, 'x', { mode: 0o600 });

    const info = await stat(target);
    expect(info.mode & 0o777).toBe(0o600);
  });
});

describe('withPathLock', () => {
  it('同じパスに対する2つの区間が重ならない', async () => {
    const target = join(root, 'target.json');
    let active = 0;
    let maxActive = 0;

    const enter = () =>
      withPathLock(target, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
      });

    await Promise.all([enter(), enter(), enter()]);

    expect(maxActive).toBe(1);
  });

  it('fn が throw してもロックが解放される（次の取得が成功する）', async () => {
    const target = join(root, 'target.json');

    await expect(
      withPathLock(target, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 解放されていなければ、次の取得は既定の 10 秒待ってから LockTimeoutError
    // になる。ここでは短い timeoutMs ですぐ成功することを見る。
    let ran = false;
    await withPathLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 1000 },
    );
    expect(ran).toBe(true);
  });

  it('古いロックが回収される（staleMs を過ぎた mtime のロックファイルを事前に置く）', async () => {
    const target = join(root, 'target.json');
    const lockPath = `${target}.lock`;
    await mkdir(root, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        host: 'other-host',
        at: new Date().toISOString(),
        token: 'stale-token',
      }),
    );
    // mtime を staleMs（1000ms）より過去へ倒す。
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    let ran = false;
    await withPathLock(
      target,
      async () => {
        ran = true;
      },
      { timeoutMs: 2000, staleMs: 1000 },
    );

    expect(ran).toBe(true);
  });

  it('新しいロックは回収されない（timeoutMs を短くすると LockTimeoutError になり、本文に保持者の pid が入る）', async () => {
    const target = join(root, 'target.json');
    const lockPath = `${target}.lock`;
    const holderPid = 424_242;
    await mkdir(root, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: holderPid,
        host: 'holder-host',
        at: new Date().toISOString(),
        token: 'fresh-token',
      }),
    );
    // mtime は既定（いま）のまま——staleMs を超えていないので回収されない。

    let caught: unknown;
    try {
      await withPathLock(target, async () => undefined, { timeoutMs: 100, staleMs: 30_000 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LockTimeoutError);
    expect((caught as Error).message).toContain(`pid=${holderPid}`);
  });

  it('解放が他人のロックを消さない（token 不一致なら unlink しない）', async () => {
    const target = join(root, 'target.json');
    const lockPath = `${target}.lock`;
    const reclaimerPayload = {
      pid: 555,
      host: 'reclaimer-host',
      at: new Date().toISOString(),
      token: 'reclaimer-token',
    };

    await withPathLock(target, async () => {
      // 区間の途中で、別の主体がこのロックを（staleMs を過ぎて）回収し、
      // 自分のものとして上書きした、を模す。
      await writeFile(lockPath, JSON.stringify(reclaimerPayload));
    });

    // 自分の release は自分の token でしか unlink しない——reclaimer の
    // ロックファイルがそのまま残っている。
    const remaining = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(remaining).toEqual(reclaimerPayload);
  });

  it('違うパスなら並行できる（ロックが広すぎないことの陰性対照）', async () => {
    const targetA = join(root, 'a.json');
    const targetB = join(root, 'b.json');
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A はロックを持ったまま、明示的に解放するまで区間を閉じない。
    const taskA = withPathLock(targetA, async () => {
      await gate;
    });

    // ロックが対象パスごとに分かれていれば、B は A の区間中でも即座に
    // 完了できる。もしロックがパスをまたいで広すぎれば、この await は
    // releaseA() を呼ぶまで永遠に返らず、このテスト自体がタイムアウトで
    // 落ちる——それ自体が失敗として観測される。
    await withPathLock(targetB, async () => undefined);

    releaseA();
    await taskA;
  }, 5000);
});

/** `jobSchema` を満たす最小限のジョブを組み立てる。 */
function makeJob(id: string): Job {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    summary: `test job ${id}`,
  };
}

describe('ストア越し（#1113 / #1050 が言っている形）', () => {
  it('同じディレクトリを向いた FsCommitmentStore を2つ作り、同じ manager × 同じ本文で同時に open しても行は1件だけ（#1041 の畳み込みがインスタンスを跨いで効く）', async () => {
    const storeA = new FsCommitmentStore(root);
    const storeB = new FsCommitmentStore(root);
    const entry = (id: string, at: string): Commitment => ({
      id,
      at,
      origin: 'manager',
      source: 'mgr-cross-instance',
      body: '同じ一言（インスタンス跨ぎ）',
    });

    const [resultA, resultB] = await Promise.all([
      storeA.open(entry('cross-a', '2026-01-01T00:00:00.000Z')),
      storeB.open(entry('cross-b', '2026-01-01T00:00:01.000Z')),
    ]);

    const opened = [resultA, resultB].filter((result) => result.opened);
    expect(opened).toHaveLength(1);

    const rows = (await storeA.list()).entries.filter(
      (entry) => entry.source === 'mgr-cross-instance',
    );
    expect(rows).toHaveLength(1);
  });

  it('同じディレクトリを向いた FsJobStore を2つ作り、並行 putJob しても取りこぼれない（両方が最終ファイルに載る）', async () => {
    const storeA = new FsJobStore(root);
    const storeB = new FsJobStore(root);
    const jobA = makeJob('job-a');
    const jobB = makeJob('job-b');

    await Promise.all([storeA.putJob(jobA), storeB.putJob(jobB)]);

    const jobs = await storeA.listJobs();
    expect(jobs.map((job) => job.id).sort()).toEqual(['job-a', 'job-b']);
  });

  /**
   * persona.ts の #serialize が #chain（プロセス内直列化のみ）のままだった
   * 漏れへの応答（#1113 / #1050。他8ストアは既に withPathLock へ移行済み）。
   *
   * **`append` を選ぶ理由**: 「読んで、足して、全置換」という read-modify-write
   * の中でいちばん壊れやすい形である。2インスタンスが同じディレクトリへ
   * 向いていて、かつ真に排他されていなければ——両方が同じ「元の本文」を
   * 読んでから書くので、後勝ちの書き込みが先の追記を踏み消す（取りこぼれる）。
   * 排他が効いていれば、片方が読む時点でもう片方の追記が既に反映されている
   * ので、最終本文に両方が残る。
   */
  it('同じディレクトリを向いた FsPersonaStore を2つ作り、並行に append しても取りこぼれない（両方の追記が最終本文に載る）', async () => {
    const journal = new FsJournalStore(join(root, 'journal'));
    const storeA = new FsPersonaStore(join(root, 'memory'), journal);
    const storeB = new FsPersonaStore(join(root, 'memory'), journal);

    await storeA.write('notes', '# メモ\n\n最初の行\n');

    await Promise.all([storeA.append('notes', '追記A'), storeB.append('notes', '追記B')]);

    const doc = await storeA.read('notes');
    expect(doc?.content).toContain('追記A');
    expect(doc?.content).toContain('追記B');
  });
});

/**
 * 本物の2プロセスでの排他（#1113 が「同一プロセス内の2インスタンスであって
 * 本物の2プロセスではない」と自己申告していた欠落への応答）。
 *
 * node 22 の `--experimental-strip-types` で `.ts` を直接起こす。
 * `file-lock.ts` の import は `node:*` だけなので、追加の依存無しで子プロセス
 * から直接読み込める（`import { withPathLock } from '<絶対パス>/file-lock.ts'`）。
 *
 * **子は2つまで、余裕のあるタイムアウト、判定は決定的なもの（区間の重なりの
 * 有無）だけにする**——負荷で揺れる形にしないため。
 */
describe('本物の2プロセスでの排他（#1113 の自己申告への応答）', () => {
  it('2つの子プロセスが同じロック対象を取り合い、区間（enter〜exit）が重ならない', async () => {
    const fileLockPath = join(dirname(fileURLToPath(import.meta.url)), 'file-lock.ts');
    const childPath = join(root, 'lock-child.mjs');
    const logPath = join(root, 'lock-log.jsonl');
    const target = join(root, 'cross-process-target.json');

    const childSource = `
import { appendFileSync } from 'node:fs';
import { withPathLock } from ${JSON.stringify(fileLockPath)};

async function main() {
  const target = process.argv[2];
  const logPath = process.argv[3];
  const holdMs = Number(process.argv[4]);
  await withPathLock(
    target,
    async () => {
      appendFileSync(logPath, JSON.stringify({ pid: process.pid, at: 'enter', t: Date.now() }) + '\\n');
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      appendFileSync(logPath, JSON.stringify({ pid: process.pid, at: 'exit', t: Date.now() }) + '\\n');
    },
    { timeoutMs: 20000 },
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    await writeFile(childPath, childSource, 'utf8');

    function runChild(holdMs: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', childPath, target, logPath, String(holdMs)],
          { stdio: 'inherit' },
        );
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`子プロセスが exit code ${String(code)} で終わった`));
        });
      });
    }

    // 2本だけ、十分に長く区間を持たせる（負荷で揺れないよう余裕を持たせる）。
    await Promise.all([runChild(200), runChild(200)]);

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    const events = lines.map((line) => JSON.parse(line) as { pid: number; at: string; t: number });
    const pids = [...new Set(events.map((event) => event.pid))];
    expect(pids).toHaveLength(2);

    const intervals = pids.map((pid) => {
      const enter = events.find((event) => event.pid === pid && event.at === 'enter');
      const exit = events.find((event) => event.pid === pid && event.at === 'exit');
      if (enter === undefined || exit === undefined) {
        throw new Error(`pid ${String(pid)} の enter/exit が揃っていない`);
      }
      return { pid, enter: enter.t, exit: exit.t };
    });
    const [first, second] = intervals;
    if (first === undefined || second === undefined) throw new Error('unreachable');

    // 区間が重ならない（真の相互排他）: 片方の enter が、もう片方の exit
    // より前ならば、もう片方の enter はその exit 以降でなければならない。
    const overlap = first.enter < second.exit && second.enter < first.exit;
    expect(overlap).toBe(false);
  }, 30_000);
});
