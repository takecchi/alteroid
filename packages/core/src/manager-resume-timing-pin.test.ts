import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerTokenAssignmentPort } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool` の resume の1回の経路（`#claimForResume` → `loadSession` → companions → チェックポイント1 → `issueResume` →
// チェックポイント2 → `recordResumed`）の、各点が起きる microtask の周回数と、日誌・台帳・時計・runner への呼び出しの順を固定する。
// 期待の値は仕様を先に書いたものではなく、今の出力から変えないための歯である（`clone-read-salvage-pin.test.ts` と同じ構成）。
// `vitest run <path> -u` でインライン snapshot を生成し、目で読んで確かめた値で、文面の正しさの保証ではない。
// 周回数は `await Promise.resolve()` を数える時計（`Clock`）で測る（実時間は使わない）。各点は、`restore()` を呼んだ直後を 0 として印を付ける。
// 外から差し込む偽（台帳の `putJob`・日誌の `append`・預け先の `load` / `listSubkeys`・鍵の割り当て・runner の `resume` / `stop` / `list`・時計）が
// 呼ばれた順と周回数が印になる。resume の途中にある `await` を足す・減らす・並べ替えると、この印の並びか周回数が動く。

const START = '2026-09-01T00:00:00.000Z';
const CLOCK_MS = Date.parse(START);

class Clock {
  n = 0;
  #live = true;
  start(): void {
    void (async () => {
      for (let i = 0; i < 2000 && this.#live; i += 1) {
        this.n += 1;
        await Promise.resolve();
      }
    })();
  }
  stop(): void {
    this.#live = false;
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

function runningJob(managerId: string): Job {
  return {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'running',
    summary: '調べ物',
    request: '調べ物をして',
    cwd: '/work/project',
    projectKey: 'proj-1',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };
}

interface Plan {
  /** 預け先に主の記録があるか（あれば companions（作業者・peer）も引く） */
  readonly stored: boolean;
  /** `runner.resume()` の応答が返らず（投げて）、一覧に居る形 */
  readonly resumeThrowsButListed?: boolean;
  /** 預け先の `load` を、合図が出るまで止める（その間に `abort()` を確定させる） */
  readonly abortDuringLoad?: boolean;
  /** `runner.resume()` を、合図が出るまで止める（その間に `abort()` を確定させる） */
  readonly abortDuringResume?: boolean;
}

async function drive(plan: Plan): Promise<string[]> {
  const clock = new Clock();
  const log: string[] = [];
  const mark = (label: string): void => {
    log.push(`${label} @+${String(clock.n)}`);
  };

  const managerId = 'mgr-resume-timing';
  const base = createMemoryStores();
  await base.jobs.putJob(runningJob(managerId));

  const originalPutJob = base.jobs.putJob.bind(base.jobs);
  base.jobs.putJob = async (job) => {
    mark(`putJob status=${job.status}`);
    return originalPutJob(job);
  };
  const originalAppend = base.journal.append.bind(base.journal);
  base.journal.append = async (entry) => {
    mark(`journal ${entry.type}`);
    return originalAppend(entry);
  };

  const loadEntered = deferred();
  const loadGate = deferred();
  const resumeEntered = deferred();
  const resumeGate = deferred();
  const sessions = new Set<string>();

  const stores = {
    ...base,
    sessionStore: {
      append: async () => undefined,
      load: async () => {
        mark('sessionStore.load');
        loadEntered.resolve();
        if (plan.abortDuringLoad === true) await loadGate.promise;
        await ticks(2);
        return plan.stored ? [{ type: 'user', message: 'x' }] : null;
      },
      listSubkeys: async () => {
        mark('sessionStore.listSubkeys');
        await ticks(1);
        return [];
      },
    },
  };

  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
      mark('runner.resume');
      resumeEntered.resolve();
      if (plan.abortDuringResume === true) await resumeGate.promise;
      await ticks(2);
      if (plan.resumeThrowsButListed === true) {
        sessions.add(command.managerId);
        throw new Error('応答が返らない');
      }
      sessions.add(command.managerId);
      return { cwd: command.cwd };
    },
    async stop(id) {
      mark('runner.stop');
      sessions.delete(id);
    },
    async list(): Promise<RunnerManagerState[]> {
      mark('runner.list');
      return [...sessions].map((id) => ({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: '調べ物',
        waiting: [],
        liveBackgroundTasks: 0,
      }));
    },
    async setProfile() {
      return { ok: true as const };
    },
  });

  const tokenAssignment: ManagerTokenAssignmentPort = {
    assign: async () => {
      mark('tokenAssignment.assign');
      await ticks(1);
      return undefined;
    },
    target: () => undefined,
  };

  const pool = createManagerPool({
    stores,
    post: (event) => {
      mark(`post ${event.type}`);
    },
    runners: createRunnerRegistry([runner]),
    tokenAssignment,
    now: () => {
      mark('now');
      return CLOCK_MS;
    },
  });

  log.length = 0;
  clock.n = -1;
  clock.start();
  const restoring = pool.restore();
  if (plan.abortDuringLoad === true) {
    await loadEntered.promise;
    await pool.abort(managerId);
    mark('abort returned');
    loadGate.resolve();
  }
  if (plan.abortDuringResume === true) {
    await resumeEntered.promise;
    await pool.abort(managerId);
    mark('abort returned');
    resumeGate.resolve();
  }
  await restoring;
  mark('restore returned');
  clock.stop();
  return log;
}

describe('resume の1回の経路の各点の周回数と順（Pool#resume の段の切り出しの歯）', () => {
  it('主の記録が預け先にある通常の回: 関門の台帳書き込み → 記録の取得 → companions → 鍵の割り当て → resume → 受理', async () => {
    expect(await drive({ stored: true })).toMatchInlineSnapshot(`
      [
        "now @+1",
        "runner.list @+20",
        "now @+31",
        "putJob status=running @+31",
        "journal decision @+34",
        "sessionStore.load @+39",
        "sessionStore.listSubkeys @+44",
        "sessionStore.listSubkeys @+48",
        "now @+53",
        "tokenAssignment.assign @+53",
        "runner.resume @+57",
        "now @+62",
        "now @+64",
        "putJob status=running @+64",
        "journal exchange @+69",
        "journal exchange @+73",
        "now @+73",
        "now @+73",
        "post manager_message @+73",
        "restore returned @+80",
      ]
    `);
  });

  it('預け先に記録が無い回: companions を引かず、記録無しで resume する', async () => {
    expect(await drive({ stored: false })).toMatchInlineSnapshot(`
      [
        "now @+1",
        "runner.list @+20",
        "now @+31",
        "putJob status=running @+31",
        "journal decision @+34",
        "sessionStore.load @+39",
        "now @+44",
        "tokenAssignment.assign @+44",
        "runner.resume @+48",
        "now @+53",
        "now @+55",
        "putJob status=running @+55",
        "journal exchange @+60",
        "journal exchange @+64",
        "now @+64",
        "now @+64",
        "post manager_message @+64",
        "restore returned @+71",
      ]
    `);
  });

  it('resume の応答が返らず一覧に居る回: 一覧で確かめて引き取り、日誌へ残す', async () => {
    expect(await drive({ stored: true, resumeThrowsButListed: true })).toMatchInlineSnapshot(`
      [
        "now @+1",
        "runner.list @+20",
        "now @+31",
        "putJob status=running @+31",
        "journal decision @+34",
        "sessionStore.load @+39",
        "sessionStore.listSubkeys @+44",
        "sessionStore.listSubkeys @+48",
        "now @+53",
        "tokenAssignment.assign @+53",
        "runner.resume @+57",
        "runner.list @+61",
        "journal decision @+65",
        "now @+70",
        "now @+72",
        "putJob status=running @+72",
        "journal exchange @+77",
        "journal exchange @+81",
        "now @+81",
        "now @+81",
        "post manager_message @+81",
        "restore returned @+88",
      ]
    `);
  });

  it('チェックポイント1: 記録の取得の間に止められた回は、resume を出さずに返る', async () => {
    expect(await drive({ stored: true, abortDuringLoad: true })).toMatchInlineSnapshot(`
      [
        "now @+1",
        "runner.list @+20",
        "now @+31",
        "putJob status=running @+31",
        "journal decision @+34",
        "sessionStore.load @+39",
        "now @+50",
        "now @+50",
        "now @+55",
        "putJob status=running @+55",
        "runner.stop @+63",
        "runner.list @+64",
        "now @+68",
        "now @+69",
        "putJob status=stopped @+69",
        "journal exchange @+75",
        "now @+79",
        "post manager_message @+79",
        "abort returned @+80",
        "sessionStore.listSubkeys @+86",
        "sessionStore.listSubkeys @+90",
        "restore returned @+103",
      ]
    `);
  });

  it('チェックポイント2: resume の応答を待つ間に止められた回は、畳み直して返る', async () => {
    expect(await drive({ stored: true, abortDuringResume: true })).toMatchInlineSnapshot(`
      [
        "now @+1",
        "runner.list @+20",
        "now @+31",
        "putJob status=running @+31",
        "journal decision @+34",
        "sessionStore.load @+39",
        "sessionStore.listSubkeys @+44",
        "sessionStore.listSubkeys @+48",
        "now @+53",
        "tokenAssignment.assign @+53",
        "runner.resume @+57",
        "now @+68",
        "now @+68",
        "now @+73",
        "putJob status=running @+73",
        "runner.stop @+81",
        "runner.list @+82",
        "now @+86",
        "now @+87",
        "putJob status=stopped @+87",
        "journal exchange @+93",
        "now @+97",
        "post manager_message @+97",
        "abort returned @+98",
        "runner.stop @+104",
        "runner.list @+105",
        "now @+109",
        "now @+110",
        "putJob status=stopped @+110",
        "restore returned @+124",
      ]
    `);
  });
});
