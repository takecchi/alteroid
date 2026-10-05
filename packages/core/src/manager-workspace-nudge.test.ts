import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_KIND_ENV_KEY,
  WORKSPACE_REPOSITORY_ENV_KEY,
  createManagerPool,
  resolveWorkspacePolicy,
} from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type {
  InboxEvent,
  Job,
  LastRescue,
  LastUnpushedWorkObservation,
  WorkspaceLocator,
} from './schema.js';
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
    async start(): Promise<{ cwd?: string }> {
      /* この検証では使わない */
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      state.resumes.push(command);
      state.alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    async send() {
      /* この検証では使わない */
      return true;
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

function jobWith(
  id: string,
  workspace: WorkspaceLocator | undefined,
  lastUnpushedWorkObservation?: LastUnpushedWorkObservation,
  lastRescue?: LastRescue,
): Job {
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
    ...(lastUnpushedWorkObservation === undefined ? {} : { lastUnpushedWorkObservation }),
    ...(lastRescue === undefined ? {} : { lastRescue }),
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

  it('git: マネージャー向けの文言は完全一致で固定する（repository と ref を入れ替える変異を捕まえる）', async () => {
    // **`toContain` の2条件だけでは、repository と ref を入れ替える変異が
    // 生き残る**（両方の値が文言のどこかに含まれてさえいれば通ってしまう）。
    // ここは順序まで含めて固定する。
    const job = jobWith('mgr-git-exact', {
      kind: 'git',
      repository: 'https://github.com/acme/widgets.git',
      ref: 'feature/migrate-db',
    });
    const { message } = await runnerSwapNudge(job);

    expect(message).toBe(
      '[system] runner の器が作り直された。作業ディレクトリは器と一緒に失われている。' +
        'https://github.com/acme/widgets.git の feature/migrate-db を' +
        'clone し直してから、続きに入れ。コミットしていなかった変更は残っていないので、' +
        '必要なら書き直すこと。中断していた作業の続きを進めよ。',
    );
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

  it('unknown + 未 push 観測あり: マネージャー向けは作業ツリーごとに host/path/branch を列挙し、観測時刻の一文を含む（Issue #1376 B2）', async () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-24T05:00:00.000Z',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: 'repo',
          branch: 'feature/x',
          remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
        },
        // このツリーは枝名が取れなかった——理由付きの「確かめよ」に倒れるはず。
        { relativePath: 'repo2', branch: null },
      ],
    };
    const job = jobWith(
      'mgr-unknown-observed',
      { kind: 'unknown', runnerId: 'runner-primary', path: '/data/work', reason: '未確認' },
      observation,
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');
    expect(message).toContain('repo2');
    expect(message).toContain('確かめよ');
    expect(message).toContain('2026-09-24T05:00:00.000Z');
    expect(message).toContain('これより後に作った枝は含まれない');
  });

  /**
   * **Issue #1885** — 台帳の観測が「確かめきれなかった」ことの4欄を持つ
   * とき、`runnerSwapNudge`（マネージャー向け）とクローン向け
   * （`#notifyRestored` 経由の `cloneText`）は、どちらも「見つかった作業
   * ツリーごとに次のとおり」の前に「探しきっていない」旨を1文足す——
   * 判定は `workspaceAfterSwap` 1箇所だけに持つので、両方の宛先に同時に
   * 効く。直す前は `WorkspaceAfterSwap` がこの情報を運ばないので、この歯は
   * 赤くなる。
   */
  it('unknown + 未 push 観測あり・確かめきれなかった申告あり: マネージャー向け・クローン向けの両方が「探しきっていない」と名乗る（Issue #1885）', async () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-24T05:00:00.000Z',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: 'repo',
          branch: 'feature/x',
          remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
        },
      ],
      truncatedAtCount: 50,
      unreadableDirCount: 1,
    };
    const job = jobWith(
      'mgr-unknown-incomplete',
      { kind: 'unknown', runnerId: 'runner-primary', path: '/data/work', reason: '未確認' },
      observation,
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    for (const text of [message, cloneText]) {
      expect(text).toContain('この観測は探しきっていない');
      expect(text).toContain('件数の上限（50）で打ち切った');
      expect(text).toContain('子ディレクトリの読み失敗が1件あった');
      expect(text).toContain('ここに無い作業ツリーが在りうる');
      // clone の指示（列挙）そのものは変わらず出る。
      expect(text).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');
    }
  });

  it('unknown + 未 push 観測あり・確かめきれなかった申告なし: 今日と同じく「探しきっていない」は出ない（Issue #1885 の対照）', async () => {
    const job = jobWith(
      'mgr-unknown-complete',
      { kind: 'unknown', runnerId: 'runner-primary', path: '/data/work', reason: '未確認' },
      {
        kind: 'observed',
        at: '2026-09-24T05:00:00.000Z',
        cwd: '/work/project',
        worktrees: [
          {
            relativePath: 'repo',
            branch: 'feature/x',
            remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
          },
        ],
      },
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).not.toContain('探しきっていない');
    expect(cloneText).not.toContain('探しきっていない');
  });

  it('runner-volume + 未 push 観測あり: それでも clone の指示は出ない（clone の指示は unknown 限定）', async () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-24T05:00:00.000Z',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: 'repo',
          branch: 'feature/x',
          remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
        },
      ],
    };
    const job = jobWith(
      'mgr-legacy-observed',
      { kind: 'runner-volume', runnerId: 'runner-primary', path: '/data/work' },
      observation,
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('/data/work');
    expect(message).toContain('残っているとは限らない');
    expect(message).not.toContain('clone し直せ');
    expect(message).not.toContain('github.com');
  });

  it('unknown + 観測が unavailable: 今日の文言のまま（観測が無いなら新しい主張をしない）', async () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: '2026-09-24T05:00:00.000Z',
      reason: 'runner が答えなかった',
    };
    const job = jobWith(
      'mgr-unknown-unavailable',
      { kind: 'unknown', runnerId: 'runner-primary', path: '/data/work', reason: '未確認' },
      observation,
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('/data/work');
    expect(message).toContain('残っているとは限らない');
    expect(message).not.toContain('clone し直せ');
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

  it('git: userinfo 付きの URL は、env から台帳へ入る時点で資格が落ち、2つの一言のどちらにもトークンが出ない（#2492）', async () => {
    const fakeToken = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const policy = resolveWorkspacePolicy({
      [WORKSPACE_KIND_ENV_KEY]: 'git',
      [WORKSPACE_REPOSITORY_ENV_KEY]: `https://x-access-token:${fakeToken}@github.com/acme/widgets.git`,
    });
    if (policy.kind !== 'git') throw new Error('git のはず');
    const job = jobWith('mgr-git-userinfo', {
      kind: 'git',
      repository: policy.repository,
      ref: policy.ref,
    });
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).toContain('https://github.com/acme/widgets.git');
    expect(message).not.toContain(fakeToken);
    expect(message).not.toContain('x-access-token');
    expect(cloneText).toContain('https://github.com/acme/widgets.git');
    expect(cloneText).not.toContain(fakeToken);
    expect(cloneText).not.toContain('x-access-token');
  });

  it('unknown + 未 push 観測あり: クローン向けも host/path/branch を列挙し、path 単体（/data/work）は出さない', async () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-24T05:00:00.000Z',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: 'repo',
          branch: 'feature/x',
          remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
        },
      ],
    };
    const job = jobWith(
      'mgr-unknown-observed-clone',
      { kind: 'unknown', runnerId: 'runner-primary', path: '/data/work', reason: '未確認' },
      observation,
    );
    const { cloneText } = await runnerSwapNudge(job);

    expect(cloneText).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');
    expect(cloneText).toContain('これより後に作った枝は含まれない');
    // **path は出さない**（`cloneWorkspaceAfterSwapLine` の doc と同じ約束）。
    expect(cloneText).not.toContain('/data/work');
  });

  describe('デーモン起動時の引き取り（restore()）は、runner が持っているかで cause を分ける（#2748）', () => {
    const observation: LastUnpushedWorkObservation = {
      kind: 'observed',
      at: '2026-09-24T05:00:00.000Z',
      cwd: '/work/project',
      worktrees: [
        {
          relativePath: 'repo',
          branch: 'feature/x',
          remoteOrigin: { host: 'github.com', path: 'acme/widgets.git' },
        },
      ],
    };
    const unknownWorkspace: WorkspaceLocator = {
      kind: 'unknown',
      runnerId: 'runner-primary',
      path: '/data/work',
      reason: '未確認',
    };

    it('attach 分岐（runner がセッションを持っている）は cause === "daemon" のまま。作業ツリーは触られていないので clone の案内を出さない', async () => {
      // **この前提が成り立つのは attach 分岐だけである。** runner が持っていれば
      // 器は入れ替わっておらず、resume は呼ばれない。
      const job = jobWith('mgr-daemon-attach', unknownWorkspace, observation);
      const stores = createMemoryStores();
      await stores.jobs.putJob(job);
      const fake = swappableRunner();
      fake.state.alive.push({
        managerId: job.id,
        status: 'running',
        cwd: '/work/project',
        request: 'DB の移行をやって',
        waiting: [],
        sessionId: 'sess-before-swap',
      });
      const s = setup(stores, fake.runner);

      await s.pool.restore();
      expect(fake.state.resumes).toHaveLength(0);
      const notice = s.inbox.find((event) => event.type === 'manager_message') as
        { text: string } | undefined;
      expect(notice?.text).toContain('デーモンが再起動した');
      expect(notice?.text).not.toContain('コミット前の変更は失われている');
      expect(notice?.text).not.toContain('clone し直せ');

      await s.pool.stop();
    });

    it('resume 分岐（runner の一覧に居なかった）は器の入れ替えとして、マネージャー向けにもクローン向けにも作業ツリーの案内を出す', async () => {
      const job = jobWith('mgr-daemon-resume', unknownWorkspace, observation);
      const stores = createMemoryStores();
      await stores.jobs.putJob(job);
      const fake = swappableRunner();
      const s = setup(stores, fake.runner);

      await s.pool.restore();
      expect(fake.state.resumes).toHaveLength(1);
      const message = fake.state.resumes[0]?.message ?? '';
      expect(message).toContain('runner の器が作り直された');
      expect(message).not.toContain('デーモンが再起動した');
      expect(message).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');

      const notice = s.inbox.find((event) => event.type === 'manager_message') as
        { text: string } | undefined;
      expect(notice?.text).toContain('runner の器が作り直された');
      expect(notice?.text).toContain('コミット前の変更は失われている');
      expect(notice?.text).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');

      await s.pool.stop();
    });

    it('resume 分岐でも locator が shared-volume なら、中身は残っているとマネージャーへ伝える（workspaceAfterSwap の判定に従う）', async () => {
      const job = jobWith('mgr-daemon-resume-shared', {
        kind: 'shared-volume',
        path: '/mnt/shared/proj',
      });
      const stores = createMemoryStores();
      await stores.jobs.putJob(job);
      const fake = swappableRunner();
      const s = setup(stores, fake.runner);

      await s.pool.restore();
      expect(fake.state.resumes).toHaveLength(1);
      expect(fake.state.resumes[0]?.message).toContain('中身は残っている');

      await s.pool.stop();
    });
  });
});

/**
 * **Issue #2751** — 作業ツリーごとに描き分ける。未 push のコミットが在る（または
 * 確かめられなかった）のに退避 ref が無いときは「clone し直せ」と言わない。
 */
describe('runner-swap の一言は作業ツリーごとの未 push・退避 ref を描き分ける（#2751）', () => {
  const unknownLocator = {
    kind: 'unknown',
    runnerId: 'runner-primary',
    path: '/data/work',
    reason: '未確認',
  } as const;
  const origin = { host: 'github.com', path: 'acme/widgets.git' };
  const OBSERVED_AT = '2026-09-24T05:00:00.000Z';
  const REF = 'refs/alteroid-rescue/mgr-x/repo';
  const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

  function observed(tree: Record<string, unknown>): LastUnpushedWorkObservation {
    return {
      kind: 'observed',
      at: OBSERVED_AT,
      cwd: '/work/project',
      worktrees: [{ relativePath: 'repo', branch: 'feature/x', remoteOrigin: origin, ...tree }],
    } as LastUnpushedWorkObservation;
  }

  function rescue(tree: Record<string, unknown>): LastRescue {
    return {
      at: '2026-09-24T04:59:00.000Z',
      worktrees: [
        { relativePath: 'repo', branch: 'feature/x', at: '2026-09-24T04:59:00.000Z', ...tree },
      ],
    } as LastRescue;
  }

  const pushedAt = (at: string) => ({ pushed: { ref: REF, commit: COMMIT, at } });

  it('未 push 3 コミット・退避 ref 無し: 「clone し直せ」と言わず、ls-remote で確かめさせ、無ければ失われたと言う', async () => {
    const job = jobWith(
      'mgr-lost',
      unknownLocator,
      observed({ unpushedCommitCount: 3, uncommittedChangeCount: 0 }),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).not.toContain('clone し直せ。');
    expect(message).toContain('未 push のコミットが 3 件あった');
    expect(message).toContain("git ls-remote origin -- 'refs/heads/feature/x'");
    expect(message).toContain('3 コミットは失われた（origin に無い）');
    expect(message).toContain('退避 ref は無い');
    expect(message).toContain('コミット済みで未 push のものも失われている可能性');
    expect(cloneText).not.toContain('clone し直せ。');
    expect(cloneText).toContain('未 push のコミットが 3 件あった');
    expect(cloneText).toContain('退避 ref は無い');
  });

  it('未 push の件数が確かめられなかった（Unknown）・退避 ref 無し: 同じく「clone し直せ」と言わない', async () => {
    const job = jobWith(
      'mgr-unknown-count',
      unknownLocator,
      observed({ unpushedCommitCountUnknown: 'git が落ちた' }),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    for (const text of [message, cloneText]) {
      expect(text).not.toContain('clone し直せ。');
      expect(text).toContain('未 push のコミット数は確かめられなかった（git が落ちた）');
    }
    expect(message).toContain("git ls-remote origin -- 'refs/heads/feature/x'");
  });

  it('件数 0・未コミット 0・退避不要: 従来どおり「clone し直せ」', async () => {
    const job = jobWith(
      'mgr-clean',
      unknownLocator,
      observed({ unpushedCommitCount: 0, uncommittedChangeCount: 0 }),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    for (const text of [message, cloneText]) {
      expect(text).toContain('github.com/acme/widgets.git の feature/x を clone し直せ。');
      expect(text).not.toContain('ls-remote');
    }
  });

  it('未コミットの変更の件数が出る（退避 ref 無し・未 push 0）', async () => {
    const job = jobWith(
      'mgr-dirty',
      unknownLocator,
      observed({ unpushedCommitCount: 0, uncommittedChangeCount: 4 }),
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('未コミットの変更が 4 件あった');
    expect(message).toContain('github.com/acme/widgets.git の feature/x を clone し直せ');
    expect(message).toContain('未コミットの変更は失われている');
  });

  it('退避 ref あり: ref・commit・時刻と取り戻す手順、含まれないものを必ず書く', async () => {
    const job = jobWith(
      'mgr-rescued',
      unknownLocator,
      observed({ unpushedCommitCount: 2, uncommittedChangeCount: 1 }),
      rescue(pushedAt('2026-09-24T05:00:00.000Z')),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).toContain(`${REF}（abcdef01, 2026-09-24T05:00:00.000Z）`);
    expect(message).toContain(`git fetch origin '${REF}'`);
    expect(message).toContain('git switch -c <新しい枝名> FETCH_HEAD');
    expect(message).toContain(`git checkout ${COMMIT}`);
    expect(message).toContain('最後の退避の時点の HEAD + 追跡済みの未コミットの変更');
    expect(message).toContain('それより後の変更と未追跡のファイルは含まない');
    expect(message).not.toContain('失われた（origin に無い）');
    expect(message).not.toContain('ls-remote');
    expect(message).not.toContain('その間の変更は失われ');
    expect(cloneText).toContain('退避 ref あり');
    expect(cloneText).toContain(REF);
  });

  it('退避の時刻が観測より古い: その間の変更は失われた可能性があると言う（断定しない）', async () => {
    const job = jobWith(
      'mgr-stale',
      unknownLocator,
      observed({ unpushedCommitCount: 2 }),
      rescue(pushedAt('2026-09-24T04:50:00.000Z')),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).toContain(
      '観測（2026-09-24T05:00:00.000Z）より古い——その間の変更は失われた可能性がある',
    );
    expect(cloneText).toContain('ただし観測より古く、その間の変更は失われた可能性がある');
  });

  it('退避されなかったもの: 未追跡の件数と名前（溢れは件数）・submodule・notPushed の理由を、失われた可能性として出す', async () => {
    const job = jobWith(
      'mgr-unsaved',
      unknownLocator,
      observed({ unpushedCommitCount: 0, uncommittedChangeCount: 9 }),
      rescue({
        ...pushedAt('2026-09-24T05:00:00.000Z'),
        notPushed: { reason: 'secret-like', files: ['config/.env.local'] },
        untracked: {
          count: 8,
          paths: ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'],
          omitted: 2,
        },
        submoduleCount: 1,
      }),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).toContain('退避されなかったもの（失われた可能性がある）');
    expect(message).toContain('未追跡 8 件（a.txt, b.txt, c.txt, d.txt, e.txt ほか 3 件）');
    expect(message).toContain('submodule 1 本');
    expect(message).toContain('直近の退避: 鍵らしい文字列のため送らなかった（config/.env.local）');
    expect(cloneText).toContain('未追跡 8 件');
  });

  it('退避 ref が無く push も失敗していた: 理由を出し、未 push が在れば clone し直せとは言わない', async () => {
    const job = jobWith(
      'mgr-nocred',
      unknownLocator,
      observed({ unpushedCommitCount: 5 }),
      rescue({ notPushed: { reason: 'no-credential' } }),
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('直近の退避: 資格が無いので退避できなかった');
    expect(message).toContain('5 コミットは失われた（origin に無い）');
    expect(message).not.toContain('clone し直せ。');
  });

  it('枝名が取れない作業ツリー（unresolved）に未 push が在る: 確かめよ＋失われた可能性', async () => {
    const job = jobWith('mgr-unresolved', unknownLocator, {
      kind: 'observed',
      at: OBSERVED_AT,
      cwd: '/work/project',
      worktrees: [{ relativePath: 'repo2', branch: null, unpushedCommitCount: 2 }],
    });
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('repo2: 未 push のコミットが 2 件あった');
    expect(message).toContain('確かめよ（枝名を確かめられなかった');
    expect(message).toContain('2 コミットは失われた（origin に無い）');
  });

  it('観測が無くても（未観測・unavailable）、退避 ref が在れば出す。件数や「失われた」は断定しない', async () => {
    const unavailable: LastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: OBSERVED_AT,
      reason: 'runner が答えなかった',
    };
    for (const [id, observation] of [
      ['mgr-rescue-only-none', undefined],
      ['mgr-rescue-only-unavail', unavailable],
    ] as const) {
      const job = jobWith(
        id,
        unknownLocator,
        observation,
        rescue({
          ...pushedAt('2026-09-24T05:00:00.000Z'),
          untracked: { count: 2, paths: ['x.txt', 'y.txt'], omitted: 0 },
        }),
      );
      const { message, cloneText } = await runnerSwapNudge(job);

      expect(message).toContain(`${REF}（abcdef01, 2026-09-24T05:00:00.000Z）`);
      expect(message).toContain(`git fetch origin '${REF}'`);
      expect(message).toContain('git switch -c <新しい枝名> FETCH_HEAD');
      expect(message).toContain('それより後の変更と未追跡のファイルは含まない');
      expect(message).toContain('退避の時刻より後の変更は確かめられない');
      expect(message).toContain('未追跡 2 件（x.txt, y.txt）');
      expect(message).toContain('未 push の観測が無い');
      expect(message).not.toContain('失われた（origin に無い）');
      expect(message).not.toContain('clone し直せ');
      expect(cloneText).toContain(REF);
      expect(cloneText).toContain('退避の時刻より後の変更は確かめられない');
    }
  });

  it('観測に無い作業ツリーでも、退避 ref が在れば観測の作業ツリーと並べて出す', async () => {
    const job = jobWith(
      'mgr-rescue-extra',
      unknownLocator,
      observed({ unpushedCommitCount: 0, uncommittedChangeCount: 0 }),
      {
        at: '2026-09-24T04:59:00.000Z',
        worktrees: [
          {
            relativePath: 'other',
            branch: 'feature/o',
            at: '2026-09-24T04:59:00.000Z',
            ...pushedAt('2026-09-24T04:59:00.000Z'),
          },
        ],
      } as LastRescue,
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('github.com/acme/widgets.git の feature/x を clone し直せ。');
    expect(message).toContain('- other: 退避 ref');
    expect(message).toContain(`git fetch origin '${REF}'`);
  });

  it('観測が無く、退避の台帳に pushed も無い: 従来の文言のまま', async () => {
    const job = jobWith(
      'mgr-rescue-nopush',
      unknownLocator,
      undefined,
      rescue({ notPushed: { reason: 'no-credential' } }),
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain('残っているとは限らない');
    expect(message).not.toContain('退避 ref');
  });

  it('案内に埋め込む枝名は単一引用符でクオートされ、ls-remote は refs/heads/ の完全一致の形になる（コマンド注入を作らない）', async () => {
    for (const branch of ['feat;touch${IFS}PWNED', 'a$(id)b`id`', "it's"]) {
      const job = jobWith(
        'mgr-inject',
        unknownLocator,
        observed({ unpushedCommitCount: 1, branch }),
      );
      const { message } = await runnerSwapNudge(job);
      const quoted = `'refs/heads/${branch.replace(/'/g, "'\\''")}'`;

      expect(message).toContain(`git ls-remote origin -- ${quoted} で`);
      expect(message).not.toContain(`git ls-remote origin ${branch}`);
    }
  });

  it('退避 ref・commit の形が不正なら、手順を出さず「形が不正」と言い、値も案内へ出さない', async () => {
    const badRef = 'refs/alteroid-rescue/x;touch PWNED';
    for (const pushed of [
      { ref: badRef, commit: COMMIT, at: '2026-09-24T05:00:00.000Z' },
      { ref: REF, commit: 'zz; rm -rf /', at: '2026-09-24T05:00:00.000Z' },
      { ref: 'refs/heads/main', commit: COMMIT, at: '2026-09-24T05:00:00.000Z' },
    ]) {
      const job = jobWith(
        'mgr-bad-ref',
        unknownLocator,
        observed({ unpushedCommitCount: 1 }),
        rescue({ pushed }),
      );
      const { message, cloneText } = await runnerSwapNudge(job);

      for (const text of [message, cloneText]) {
        expect(text).toContain('形が不正');
        expect(text).not.toContain('git fetch');
        expect(text).not.toContain('PWNED');
        expect(text).not.toContain('rm -rf');
      }
    }
  });

  it('手順に「その ref が無ければ、退避は失われている」を添え、クローン向けにも取り戻す1行が在る', async () => {
    const job = jobWith(
      'mgr-steps',
      unknownLocator,
      observed({ unpushedCommitCount: 1 }),
      rescue(pushedAt('2026-09-24T05:00:00.000Z')),
    );
    const { message, cloneText } = await runnerSwapNudge(job);

    expect(message).toContain('その ref が無ければ、退避は失われている');
    expect(cloneText).toContain(
      `git fetch origin '${REF}' && git switch -c <新しい枝名> FETCH_HEAD`,
    );
  });

  it('退避が観測より古くても、未コミット 0・未 push 0 と確かめられていれば「失われた」と言わない。新しい・同時刻でも言わない', async () => {
    const clean = jobWith(
      'mgr-stale-clean',
      unknownLocator,
      observed({ unpushedCommitCount: 0, uncommittedChangeCount: 0 }),
      rescue(pushedAt('2026-09-24T04:50:00.000Z')),
    );
    const newer = jobWith(
      'mgr-newer',
      unknownLocator,
      observed({ unpushedCommitCount: 2, uncommittedChangeCount: 1 }),
      rescue(pushedAt('2026-09-24T05:10:00.000Z')),
    );
    const same = jobWith(
      'mgr-same',
      unknownLocator,
      observed({ unpushedCommitCount: 2, uncommittedChangeCount: 1 }),
      rescue(pushedAt(OBSERVED_AT)),
    );
    for (const job of [clean, newer, same]) {
      const { message, cloneText } = await runnerSwapNudge(job);
      for (const text of [message, cloneText]) {
        expect(text).not.toContain('より古い');
        expect(text).not.toContain('その間の変更');
      }
    }
  });

  it('観測が observed で作業ツリー0本・退避 ref だけ在る: 観測が無いとは言わず、観測の時刻を言う', async () => {
    const job = jobWith(
      'mgr-empty-observed',
      unknownLocator,
      { kind: 'observed', at: OBSERVED_AT, cwd: '/work/project', worktrees: [] },
      rescue(pushedAt('2026-09-24T05:00:00.000Z')),
    );
    const { message } = await runnerSwapNudge(job);

    expect(message).toContain(`${OBSERVED_AT} 時点の観測に基づく`);
    expect(message).not.toContain('未 push の観測が無い（取れなかった）');
    expect(message).toContain(`git fetch origin '${REF}'`);
  });

  it('予算で切るとき、未 push の可能性 > 退避されなかったもの > 未コミット > その他 の順に残す。省略の行はクローンの manager_list を名指す', async () => {
    const worktrees = Array.from({ length: 60 }, (_, i) => ({
      relativePath: `repo-${String(i).padStart(2, '0')}`,
      branch: `feature/${i}`,
      remoteOrigin: origin,
      unpushedCommitCount: i === 57 ? 2 : 0,
      uncommittedChangeCount: i === 58 ? 3 : 0,
    }));
    const job = jobWith(
      'mgr-priority',
      unknownLocator,
      {
        kind: 'observed',
        at: OBSERVED_AT,
        cwd: '/work/project',
        worktrees,
      } as LastUnpushedWorkObservation,
      {
        at: '2026-09-24T04:59:00.000Z',
        worktrees: [
          {
            relativePath: 'repo-59',
            branch: 'feature/59',
            at: '2026-09-24T04:59:00.000Z',
            untracked: { count: 1, paths: ['z.txt'], omitted: 0 },
          },
        ],
      } as LastRescue,
    );
    const { message } = await runnerSwapNudge(job);

    const at = (name: string) => message.indexOf(`- ${name}:`);
    expect(at('repo-57')).toBeGreaterThan(-1);
    expect(at('repo-57')).toBeLessThan(at('repo-59'));
    expect(at('repo-59')).toBeLessThan(at('repo-58'));
    expect(at('repo-58')).toBeLessThan(at('repo-00'));
    expect(message).toContain('クローンの manager_list');
  });

  it('作業ツリーが多くても一覧は予算に収まり、危ない作業ツリーが先に出て、溢れは件数で言う', async () => {
    const worktrees = Array.from({ length: 60 }, (_, i) => ({
      relativePath: `repo-${String(i).padStart(2, '0')}`,
      branch: `feature/${i}`,
      remoteOrigin: origin,
      unpushedCommitCount: i === 59 ? 7 : 0,
      uncommittedChangeCount: 0,
    }));
    const job = jobWith('mgr-many', unknownLocator, {
      kind: 'observed',
      at: OBSERVED_AT,
      cwd: '/work/project',
      worktrees,
    } as LastUnpushedWorkObservation);
    const { message } = await runnerSwapNudge(job);

    expect(message.length).toBeLessThan(6000);
    expect(message.indexOf('repo-59')).toBeLessThan(message.indexOf('repo-00'));
    expect(message).toMatch(/…ほか \d+ 本は省略（全 60 本/);
  });
});
