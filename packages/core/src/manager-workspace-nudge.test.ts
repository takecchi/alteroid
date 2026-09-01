import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job, WorkspaceLocator } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `restartNudge`（マネージャー向け）と `#notifyRestored`（クローン向け）は、
 * runner の器が作り直された（`cause === 'runner'`）ときに流す一言を、
 * 台帳の `job.workspace`（`WorkspaceLocator`）を読まずに固定文で出していた
 * （#485 の141行目）。ここでは `manager.ts` の `workspaceAfterSwap` が
 * `WorkspaceLocator` の4変種（＋ `undefined`）を正しく読み分け、その結果が
 * 両方の宛先の文言に反映されることを固定する。
 *
 * **`runner-volume` は `unknown` と同じ扱いになる。** `workspaceLocatorSchema`
 * の `runner-volume` の doc が逐語で言うとおり、あの変種は「それ以前に書かれた
 * 行が名乗っている値であり、確かめた結果ではない」——新旧で意味が違うのに、
 * 行そのものには新旧の目印が無い。読む側に区別する手が無い以上、
 * 「volume に在るので残っている」と読むと、`unknown` 変種が消したはずの嘘
 * （存在しない永続性の主張）を読む側から再開することになる。だから
 * `runner-volume` も保守的な側（`unverified` 相当の文言）へ倒す。
 *
 * **この一言の文言に、workspace の運用選択を決める env の名は登場しない。**
 * 判定はすべて台帳の値（`job.workspace`）だけから作る——運用選択がどの env で
 * 決まったかを、通知の文言の中では案内しない。
 */

/** `swappableRunner`（`manager.test.ts`）の縮小版。器の入れ替えだけを再現する。 */
function swappableRunner(runnerId = 'runner-primary') {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const state = {
    alive: [] as RunnerManagerState[],
    resumes: [] as RunnerResumeCommand[],
  };
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      state.resumes.push(command);
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この検証では使わない */
    },
    async answer() {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [...state.alive];
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
      return { ok: true };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    state,
    /** 器を作り直す ＝ 中のセッションは消え、新しいストリームが名乗り直す。 */
    swap() {
      state.alive = [];
      emit?.({ type: 'hello', runnerId });
    },
  };
}

/** `manager.test.ts` の `setup` の縮小版。SDK は握らない（`start()` を呼ばないため不要）。 */
function setup(stores: ReturnType<typeof createMemoryStores>, runner: RunnerClient) {
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  return { pool, inbox };
}

function jobWith(id: string, workspace: WorkspaceLocator | undefined): Job {
  return {
    id,
    managerId: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
    status: 'running',
    summary: '移行作業',
    request: 'DB の移行をやって',
    cwd: '/work/project',
    sessionId: 'sess-before-swap',
    runnerId: 'runner-primary',
    lastReport: 'スキーマまで書いた',
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/** マネージャー向け（`restartNudge`）の runner-swap 後の文言を、swap 後の resume から取り出す。 */
async function runnerSwapNudge(job: Job): Promise<{ message: string; cloneText: string }> {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const fake = swappableRunner();
  const s = setup(stores, fake.runner);

  await s.pool.restore();
  expect(fake.state.resumes).toHaveLength(1);

  fake.swap();
  await expect.poll(() => fake.state.resumes.length, { timeout: 2000 }).toBe(2);

  const message = fake.state.resumes[1]?.message ?? '';
  const notice = s.inbox.filter((event) => event.type === 'manager_message').at(-1);
  const cloneText = (notice as { text: string } | undefined)?.text ?? '';

  await s.pool.stop();
  return { message, cloneText };
}

describe('runner-swap の一言は job.workspace を読む（#485 の141行目）', () => {
  it('shared-volume: マネージャー向けは「中身は残っている」を含み、「残っているとは限らない」は含まない', async () => {
    const job = jobWith('mgr-shared', { kind: 'shared-volume', path: '/mnt/shared/proj' });
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('/mnt/shared/proj');
    expect(message).toContain('中身は残っている');
    expect(message).not.toContain('残っているとは限らない');
  });

  it('git: マネージャー向けは repository と ref の値を両方含む', async () => {
    const job = jobWith('mgr-git', {
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'feature/migrate-db',
    });
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('https://github.com/acme/widgets.git');
    expect(message).toContain('feature/migrate-db');
  });

  it('unknown: マネージャー向けは path の値を含み、かつ「残っているとは限らない」を含む', async () => {
    const job = jobWith('mgr-unknown', {
      kind: 'unknown',
      runnerId: 'runner-primary',
      path: '/data/work',
      reason: 'volume かどうか未確認',
    });
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('/data/work');
    expect(message).toContain('残っているとは限らない');
  });

  it('runner-volume（legacy）は unknown と同じ文言になる——確かめた結果ではなく、それ以前に書かれた行が名乗っているだけの値だから', async () => {
    const job = jobWith('mgr-legacy', {
      kind: 'runner-volume',
      runnerId: 'runner-primary',
      path: '/data/work',
    });
    const { message } = await runnerSwapNudge(job);

    // unknown のテストと同じ2条件。**新旧の目印が行に無いので、読む側は
    // `runner-volume` と `unknown` を区別できない。区別できないまま
    // 「volume に在るので残っている」と読むと、`unknown` が消したはずの嘘
    // （存在しない永続性の主張）を読む側から再開することになる。**
    expect(message).toContain('/data/work');
    expect(message).toContain('残っているとは限らない');
  });

  it('workspace 欄が無い（undefined）: マネージャー向けは今日の文言と完全一致する——情報が無いなら新しい主張をしない', async () => {
    const job = jobWith('mgr-unrecorded', undefined);
    const { message } = await runnerSwapNudge(job);

    expect(message).toBe(
      '[system] runner の器が作り直された。作業ディレクトリが残っているとは限らないので、' +
        '続きに入る前に手元の状態を確かめよ。中断していた作業の続きを進めよ。',
    );
  });

  it('shared-volume: クローン向け（manager_message）は「コミット前の変更も残っている」を含む', async () => {
    const job = jobWith('mgr-shared-clone', { kind: 'shared-volume', path: '/mnt/shared/proj' });
    const { cloneText } = await runnerSwapNudge(job);

    expect(cloneText).toContain('コミット前の変更も残っている');
    // **path は出さない** — 同じ報告が既に `作業ディレクトリ: ${job.cwd}` を
    // 出しているので、重ねると読む側が2つの値を突き合わせることになる。
    expect(cloneText).not.toContain('/mnt/shared/proj');
  });

  it('git: クローン向け（manager_message）は repository と ref を含む', async () => {
    const job = jobWith('mgr-git-clone', {
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'feature/migrate-db',
    });
    const { cloneText } = await runnerSwapNudge(job);

    expect(cloneText).toContain('https://github.com/acme/widgets.git');
    expect(cloneText).toContain('feature/migrate-db');
  });

  it('cause === "daemon"（restore() だけで swap() しない経路）は locator に影響されない', async () => {
    // **デーモンだけの再起動では作業ディレクトリは触られていない。** `restartNudge`
    // の `cause === 'daemon'` 分岐は locator を受け取っても使わない——受け取った
    // 引数を無視することそのものを固定する（無視し忘れて分岐してしまえば、
    // ここが最初に赤くなる）。
    const sharedJob = jobWith('mgr-daemon-shared', {
      kind: 'shared-volume',
      path: '/mnt/shared/proj',
    });
    const unrecordedJob = jobWith('mgr-daemon-unrecorded', undefined);

    for (const job of [sharedJob, unrecordedJob]) {
      const stores = createMemoryStores();
      await stores.jobs.putJob(job);
      const fake = swappableRunner();
      const s = setup(stores, fake.runner);

      await s.pool.restore();
      expect(fake.state.resumes).toHaveLength(1);
      expect(fake.state.resumes[0]?.message).toBe(
        '[system] デーモンが再起動した。中断していた作業の続きを進めよ。',
      );

      await s.pool.stop();
    }
  });
});
