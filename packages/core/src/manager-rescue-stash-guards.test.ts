import { describe, expect, it, vi } from 'vitest';

import { sha256Hex } from './auth.js';
import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_RESCUE_FILES,
  RUNNER_CAPABILITY_RESCUE_RESTORE,
  runnerEventSchema,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerOutboxContent,
} from './runner-protocol.js';
import type { Job, RescueStashEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

// 退避の取り込み・取り戻しの守り（直列の鎖・別の委譲は待たない・日誌の印の入れ替え・取り戻しは待たない）。
// 公開の口（ManagerPool・runner の出来事・偽の runner と store）だけで書く: 退避の部品を別のクラスへ切り出した後も同じ試験が通ること。
// 実時間で待たない（wallclock-waits-ratchet）: store の書き込みを `gate` で止め、`settle` で microtask と I/O の周回を回し切る。

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 開けるまで await が止まる門。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** 止まっているものが進まないことを確かめる前に、進めるものを全部進める（実時間は使わない）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function fakeRunner(managerIds: readonly string[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const contents = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const deleted: string[] = [];
  const sent: { managerId: string; text: string; attachments: RunnerAttachment[] }[] = [];
  const alive: RunnerManagerState[] = managerIds.map((id) => ({
    managerId: id,
    status: 'running',
    cwd: '/work/project',
    request: 'r',
    waiting: [],
    liveBackgroundTasks: 0,
    sessionId: `sess-${id}`,
  }));
  const runner = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent: (event: RunnerEvent) => void) {
      emit = onEvent;
      onEvent(
        runnerEventSchema.parse({
          type: 'hello',
          runnerId: 'runner-primary',
          capabilities: [
            RUNNER_CAPABILITY_RESCUE_FILES,
            RUNNER_CAPABILITY_RESCUE_RESTORE,
            RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
          ],
        }),
      );
    },
    async start(command: { cwd: string }) {
      return { cwd: command.cwd };
    },
    async resume(command: { cwd: string }) {
      return { cwd: command.cwd };
    },
    async send(managerId: string, text: string, attachments?: RunnerAttachment[]) {
      sent.push({ managerId, text, attachments: attachments ?? [] });
      return true;
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {
      /* 使わない */
    },
    async openPickupFile(
      _kind: string,
      _managerId: string,
      fileId: string,
    ): Promise<RunnerOutboxContent | undefined> {
      opened.push(fileId);
      const bytes = contents.get(fileId);
      if (bytes === undefined) return undefined;
      return {
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      };
    },
    async deletePickupFile(_kind: string, _managerId: string, fileId: string) {
      deleted.push(fileId);
    },
  } as unknown as RunnerClient;
  return {
    runner,
    contents,
    opened,
    deleted,
    sent,
    /** 境界（スキーマ）を通した出来事を流す。待たない。 */
    send(event: object): void {
      emit?.(runnerEventSchema.parse(event));
    },
  };
}

type Fake = ReturnType<typeof fakeRunner>;

function jobOf(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: 's',
    request: 'r',
    cwd: '/work/project',
    sessionId: `sess-${id}`,
    runnerId: 'runner-primary',
    ...extra,
  };
}

async function setup(jobs: readonly Job[]) {
  const stores = createMemoryStores();
  for (const job of jobs) await stores.jobs.putJob(job);
  const fake = fakeRunner(jobs.map((j) => j.id));
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([fake.runner]),
    now: () => NOW,
  });
  await pool.restore();
  return { pool, stores, fake };
}

let counter = 0;
/** 1ファイルの `rescue_files` を流す（待たない）。fileId を返す。 */
function offer(fake: Fake, managerId: string, path: string, text: string): string {
  counter += 1;
  const fileId = counter.toString(16).padStart(32, '0');
  const bytes = bytesOf(text);
  fake.contents.set(fileId, bytes);
  fake.send({
    type: 'rescue_files',
    managerId,
    worktree: '.',
    files: [{ fileId, path, size: bytes.length, sha256: sha256Hex(bytes) }],
    skipped: [],
  });
  return fileId;
}

async function stashOf(
  stores: ReturnType<typeof createMemoryStores>,
  managerId: string,
): Promise<RescueStashEntry[]> {
  const job = (await stores.jobs.listJobs()).find((j) => j.id === managerId);
  return job?.rescueStash ?? [];
}

/**
 * 添付ストアの取り込み（putStream）の n 回目を、門が開くまで止める。保存の最中に別の取り込みが始まるかを見るための穴。
 * 戻り値の `gates[n]` を開けると、その回が進む。止めない回はそのまま通す。
 */
function holdIntake(stores: ReturnType<typeof createMemoryStores>, held: ReadonlySet<number>) {
  const gates = new Map<number, ReturnType<typeof gate>>();
  const reached: number[] = [];
  const original = stores.attachments.putStream.bind(stores.attachments);
  let calls = 0;
  stores.attachments.putStream = async (...args: Parameters<typeof original>) => {
    calls += 1;
    const n = calls;
    reached.push(n);
    if (held.has(n)) {
      const g = gate();
      gates.set(n, g);
      await g.wait;
    }
    return original(...args);
  };
  return { gates, reached };
}

describe('同じ委譲の rescue_files は直列に取り込む（鎖）', () => {
  it('待たずに続けて流した2本目・3本目は、1本目の保存が止まっている間は始まらず、放すと順に続く。鎖の末尾の掃除は自分が末尾のときだけで、2本目の最中に来た3本目も2本目の後ろに付く', async () => {
    const { pool, stores, fake } = await setup([jobOf('mgr-s')]);
    const hold = holdIntake(stores, new Set([1, 2]));

    const f1 = offer(fake, 'mgr-s', 'a.txt', 'one');
    const f2 = offer(fake, 'mgr-s', 'b.txt', 'two');
    await settle();
    // 1本目は保存で止まっている。2本目は取りに行ってもいない
    expect(fake.opened).toEqual([f1]);
    expect(hold.reached).toEqual([1]);

    hold.gates.get(1)!.open();
    await vi.waitFor(() => expect(fake.opened).toEqual([f1, f2]));
    await vi.waitFor(async () => expect(await stashOf(stores, 'mgr-s')).toHaveLength(1));

    // 1本目が終わっても、鎖の末尾は2本目（まだ保存で止まっている）。ここへ来た3本目は2本目の後ろに付く
    const f3 = offer(fake, 'mgr-s', 'c.txt', 'three');
    await settle();
    expect(fake.opened).toEqual([f1, f2]);

    hold.gates.get(2)!.open();
    await vi.waitFor(() => expect(fake.opened).toEqual([f1, f2, f3]));
    await vi.waitFor(async () => expect(await stashOf(stores, 'mgr-s')).toHaveLength(3));
    expect((await stashOf(stores, 'mgr-s')).map((e) => e.path).sort()).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
    // 全部が済んで鎖が空になった後に来た4本目も取り込まれる
    const f4 = offer(fake, 'mgr-s', 'd.txt', 'four');
    await vi.waitFor(async () => expect(await stashOf(stores, 'mgr-s')).toHaveLength(4));
    expect(fake.opened).toEqual([f1, f2, f3, f4]);
    await pool.stop();
  });

  it('別の委譲の rescue_files は互いを待たない（片方の保存を止めても、もう片方は進む）', async () => {
    const { pool, stores, fake } = await setup([jobOf('mgr-s'), jobOf('mgr-t')]);
    const hold = holdIntake(stores, new Set([1]));

    const fs = offer(fake, 'mgr-s', 'a.txt', 'one');
    await settle();
    expect(fake.opened).toEqual([fs]);
    expect(hold.reached).toEqual([1]);

    const ft = offer(fake, 'mgr-t', 'b.txt', 'two');
    await vi.waitFor(async () => expect(await stashOf(stores, 'mgr-t')).toHaveLength(1));
    expect(fake.opened).toEqual([fs, ft]);
    // mgr-s は止まったまま
    expect(await stashOf(stores, 'mgr-s')).toEqual([]);

    hold.gates.get(1)!.open();
    await vi.waitFor(async () => expect(await stashOf(stores, 'mgr-s')).toHaveLength(1));
    await pool.stop();
  });
});

async function decisionsMentioning(
  stores: ReturnType<typeof createMemoryStores>,
  needle: string,
): Promise<number> {
  const rows = await stores.journal.list({ types: ['decision'] });
  return rows.filter((row) => JSON.stringify(row).includes(needle)).length;
}

describe('預けなかったものの日誌の印（1回だけ書く）は、約500件で入れ替わる', () => {
  it('同じ飛ばしは繰り返さないが、印が500件を超えた後の次の取り込みで古い印が外れ、同じ飛ばしがまた日誌に書かれる', async () => {
    const { pool, stores, fake } = await setup([jobOf('mgr-s')]);
    const skipOnly = (paths: readonly string[]) =>
      fake.send({
        type: 'rescue_files',
        managerId: 'mgr-s',
        worktree: 'wt',
        files: [],
        skipped: paths.map((path) => ({ path, reason: 'not-regular' })),
      });
    const bulk = (round: number) =>
      skipOnly(Array.from({ length: 100 }, (_, i) => `bulk-${String(round)}-${String(i)}.txt`));
    /** 同じ委譲の取り込みは直列なので、後ろに流した印が日誌に出たら、それまでの分は処理済み（実時間で待たない）。 */
    const flushedThrough = async (marker: string) => {
      skipOnly([marker]);
      await vi.waitFor(async () => expect(await decisionsMentioning(stores, marker)).toBe(1));
    };

    skipOnly(['only-here.txt']);
    await flushedThrough('marker-0.txt');
    expect(await decisionsMentioning(stores, 'only-here.txt')).toBe(1);

    // 約400件まで印が溜まった状態で同じ飛ばしが来ても、書かない
    for (let round = 0; round < 4; round += 1) bulk(round);
    skipOnly(['only-here.txt']);
    await flushedThrough('marker-1.txt');
    expect(await decisionsMentioning(stores, 'only-here.txt')).toBe(1);

    // 500件を超えるまで溜める。超えた後の次の取り込みで印の集まりが作り直される
    for (let round = 4; round < 6; round += 1) bulk(round);
    skipOnly(['only-here.txt']);
    await vi.waitFor(async () => expect(await decisionsMentioning(stores, 'only-here.txt')).toBe(2));
    // 作り直した後は、また同じ飛ばしは1回だけ
    skipOnly(['only-here.txt']);
    await flushedThrough('marker-2.txt');
    expect(await decisionsMentioning(stores, 'only-here.txt')).toBe(2);
    await pool.stop();
  });
});
