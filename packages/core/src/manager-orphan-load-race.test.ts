import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerManagerState,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * バグハント（wbug-jobs 続き）: 「範囲外」で上げた `abort()` / `send()` の
 * 孤児ジョブ分岐（`#load()` を経由するもの）の再現と直し（Issue #1703）。
 *
 * ## 何が起きていたか（直す前。#1703 起票時点）
 *
 * `abort()` / `send()` はどちらも同じ形で始まる:
 *
 * ```
 * const record = this.#records.get(managerId) ?? (await this.#load(managerId));
 * ```
 *
 * `#load()` は、直す前は呼ぶたびに独立した新しいコピーを作り、`#records` へ
 * 無条件に上書きで登録していた（既存のレコードがあるかどうかを見ない）。
 * ⟹ `#records` に像を持たない同じ孤児ジョブに対して2つの独立した非同期処理
 * （`send()` と `abort()`）が同時に `#load()` を呼ぶと、それぞれが**別々の
 * `Job` のコピー**を掴んだまま自分の分岐を進め、それぞれが独立に `#persist()`
 * （＝ `putJob()`、ジョブ丸ごとの上書き）を呼んでいた。後から `putJob()` した
 * 側が、先に書かれた変更ごと丸ごと上書きする——`JobStore` に CAS が無い状態で
 * 「読んでから書く」が2箇所から独立に走る、#1674（`ManagerPool` の孤児ジョブ分岐）
 * と同じ形の穴だった。
 *
 * 実際に起きていたこと: `send()` の `#claimForResume()` が putJob（1）→
 * `abort()` が `runner.stop()` を試み `sessionGone: true` を確かめて `stopped`
 * を putJob（2）→ `send()` が `runner.resume()` の成功を受けて `running` を
 * putJob（3、2を丸ごと上書き）。`abort()` は「止めた」（`outcome: 'stopped'`、
 * `sessionGone: true`）と答えるのに、台帳には `send()` が後から書いた
 * `'running'` が残っていた。しかも `abort()` は `#retire()` で像を外すので、
 * その委譲は「走っているはず」を名乗ったまま誰にも自動では拾われない状態で
 * 台帳に取り残されていた。
 *
 * ## 直した形（#1703）
 *
 * 1. **`#load()` の共有** — 既に `#records` に像があれば、それを返し新しく
 *    作らない（`manager.ts` の `#load` の doc）。同時の2呼び出しが同じ
 *    `ManagerRecord`（同じオブジェクト参照）を共有する。
 * 2. **止めた意思を優先する（安全側）** — `abort()` が `outcome === 'stopped'`
 *    を確かめた瞬間に `ManagerRecord.stopConfirmedAt`（プロセス内だけの印）を
 *    立てる。`#resume` はこの印を2箇所（`runner.resume()` の前後）で見て、
 *    まだなら resume を出さず、既に出してしまっていれば
 *    `#confirmStoppedAndReleaseLease`（`abort()` 自身と同じ関数）で畳み直す。
 *    **さらに `send()` 自身も、`#resumeOnce` が `'resumed'` を返した直後・
 *    実際に台帳へ `running` を書く直前でもう一度見る**（チェックポイント3。
 *    下の doc と `manager.ts` の該当箇所を参照——`#resume` の2点だけでは、
 *    `#resumeOnce` の `finally` を抜けて `send()` へ戻るまでの間に空く隙間を
 *    塞ぎきれないことが、この歯を作る過程の実測で分かった）。
 *
 * 直した後の保証: `abort()` が「止めた」と確かめた委譲は、`send()` と同時に
 * 走っても、台帳には必ず `stopped` が残り、`send()` は `running` を書かず
 * `delivered` を返さない。runner 側に実際にセッションが立ってしまった回は、
 * 畳み直してから `stopped-meanwhile`（`ResumeOutcome`）を返す。
 */

const START = '2026-09-01T00:00:00.000Z';

function orphanJob(managerId: string): Job {
  return {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };
}

/** 手で解決できる Promise（実時間の sleep に頼らず、Promise の解決順だけで順序を作るため）。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * `list()` が常に `[]` を返す偽 runner（直す前の再現に使ったもの。#1703 起票
 * 時点のまま）。**resume で立ったセッションを畳み直したことは測れない** ——
 * その検証は下の `trackingRunner` を使う歯に任せる。
 */
function neverAliveRunner(runnerId = 'runner-primary'): RunnerClient {
  return {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {},
    // **生きているセッションが1つも無い。** `restore()` はこの状態で
    // `status === 'lost'` のジョブを `#records` へ載せない
    // （`#restoreJobs` の `if (job.status === 'lost') continue;`）ので、
    // このジョブは「孤児」（`#records` に像を持たない）のまま残る。
    async list() {
      return [];
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
    async close() {},
  };
}

/**
 * `resume()` でセッションを一覧へ載せ、`stop()` で外す、状態を持つ偽 runner。
 *
 * `neverAliveRunner` と違い、**畳み直し（fold）が実際に runner 側のセッションを
 * 消したかを測れる** ——`list()` は `resume()` / `stop()` が触った内部の
 * `sessions` をそのまま映す。`resumeGate` を渡すと、`resume()` は
 * セッションを載せる前にそのゲートが解決されるまで待つ（実時間の sleep では
 * なく、Promise の解決順だけで「resume の途中で abort が確定する」を作るため）。
 */
function trackingRunner(options?: { runnerId?: string; resumeGate?: Promise<void> }): {
  runner: RunnerClient;
  stopCalls: string[];
  resumeCalls: RunnerResumeCommand[];
  sessions: Set<string>;
} {
  const runnerId = options?.runnerId ?? 'runner-primary';
  const sessions = new Set<string>();
  const stopCalls: string[] = [];
  const resumeCalls: RunnerResumeCommand[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      resumeCalls.push(command);
      if (options?.resumeGate) await options.resumeGate;
      sessions.add(command.managerId);
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stopCalls.push(managerId);
      sessions.delete(managerId);
    },
    async list(): Promise<RunnerManagerState[]> {
      return [...sessions].map((id) => ({
        managerId: id,
        status: 'running',
        cwd: '/work/project',
        request: '調べ物',
        waiting: [],
      }));
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
    async close() {},
  };

  return { runner, stopCalls, resumeCalls, sessions };
}

describe('abort() / send() の孤児ジョブ分岐（#load() の二重読み込み、Issue #1703）', () => {
  it('前提: status:lost の委譲は #records に載らない', async () => {
    const managerId = 'mgr-orphan-precondition';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([neverAliveRunner()]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    const summary = (await pool.list()).find((m) => m.managerId === managerId);
    expect(summary?.status).toBe('lost');
  });

  it('send() と abort() を同時に投げても、台帳には abort() の stopped が残り、send() は delivered を返さない', async () => {
    const managerId = 'mgr-orphan-race';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));

    const { runner, stopCalls, sessions } = trackingRunner();

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([runner]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    // **本物の重なりを作る。** どちらも `this.#records.get(managerId) ??
    // (await this.#load(managerId))` で始まり、`#load()` の中の
    // `listJobs()` まで同期的に進む——`Promise.all` で同時に起こせば、
    // 両方の `#load()` が「まだ `#records` に居ない」を見た状態で
    // それぞれ独立に台帳を読みに行く。
    const [sendResult, abortResult] = await Promise.all([
      pool.send(managerId, 'hello'),
      pool.abort(managerId),
    ]);

    // abort() は「止めた」と答える。
    expect(abortResult.outcome).toBe('stopped');
    expect(abortResult.sessionGone).toBe(true);

    // send() は「届いた（delivered）」を返さない——止めた意思のほうが勝つ。
    expect(sendResult.outcome).not.toBe('delivered');
    expect(sendResult.outcome).toBe('session_missing');

    // **本題。** 台帳に最終的に残る status は stopped——記録（abort() の
    // 返り値）と実際（台帳の中身）が食い違わない。
    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('stopped');

    // runner 側に実際にセッションが立ってしまっていても、畳み直されて
    // 残らない。
    expect(sessions.has(managerId)).toBe(false);
    // abort() 自身の stop、または abort() ＋ 畳み直しの stop（実行順により
    // 1回で足りることも2回になることもある。少なくとも1回は必ず呼ばれ、
    // runner 側にセッションを残さない）。
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it(
    'abort() が resume の前に確定していれば、runner.resume() は1回も呼ばれない' +
      '（チェックポイント1。Promise の解決順だけで順序を作る）',
    async () => {
      const managerId = 'mgr-orphan-precheck';
      const stores = createMemoryStores();
      await stores.jobs.putJob(orphanJob(managerId));

      const { runner, stopCalls, resumeCalls, sessions } = trackingRunner();

      // **abort() が list()（＝ sessionGone を確かめ終えた）を呼んだことを
      // 合図に、send() 側の #claimForResume の putJob を解放する。** あいだに
      // 数ティック挟むのは、abort() がその合図の直後に行う同期区間
      // （judgeLease から record.stopConfirmedAt を立てるところまで）を
      // 必ず終わらせるため——実時間の sleep ではなく、Promise の解決順だけで
      // 組んである。
      const abortListCalled = deferred<void>();
      const originalList = runner.list.bind(runner);
      runner.list = async (opts) => {
        const result = await originalList(opts);
        abortListCalled.resolve();
        return result;
      };

      const originalPutJob = stores.jobs.putJob.bind(stores.jobs);
      let armed = false;
      stores.jobs.putJob = async (job) => {
        if (armed) {
          await abortListCalled.promise;
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        }
        return originalPutJob(job);
      };

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry([runner]),
        now: () => Date.parse(START),
      });
      await pool.restore();
      armed = true;

      const [sendResult, abortResult] = await Promise.all([
        pool.send(managerId, 'hello'),
        pool.abort(managerId),
      ]);

      expect(abortResult.outcome).toBe('stopped');
      expect(abortResult.sessionGone).toBe(true);

      // **本題。** チェックポイント1が resume そのものを止めた——新しい
      // セッションは1つも作られない。
      expect(resumeCalls).toHaveLength(0);
      // 畳み直しが要らない（そもそも何も立てていない）ので stop は
      // abort() 自身の1回だけ。
      expect(stopCalls).toHaveLength(1);
      expect(sessions.has(managerId)).toBe(false);

      expect(sendResult.outcome).not.toBe('delivered');
      expect(sendResult.outcome).toBe('session_missing');

      const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
      expect(finalJob?.status).toBe('stopped');
    },
  );

  it(
    'resume の途中で abort() が確定すると、起こしてしまったセッションを畳み直す' +
      '（チェックポイント2/3。Promise の解決順だけで順序を作る）',
    async () => {
      const managerId = 'mgr-orphan-midcheck';
      const stores = createMemoryStores();
      await stores.jobs.putJob(orphanJob(managerId));

      // **abort() が list() を呼んだことを合図に、runner.resume() の解決を
      // 遅らせる。** 当初はここでチェックポイント1（resume を呼ぶ前）を
      // 必ず素通りさせるつもりで組んだが、**Issue #1716 の直しで
      // `abort()` が印（`record.stopConfirmedAt`）を `#confirmStoppedAndReleaseLease`
      // より前（`#runnerOf` の直後）に立てるようになった**ので、いまは
      // チェックポイント1がこの回も先に捕まえることがある——`stopConfirmedAt`
      // は `runner.stop()` / `runner.list()` を待たずに立つため、送信側が
      // チェックポイント1に達する前に既に立っている可能性が高い。
      // **どちらのチェックポイントが捕まえても、下の本題（畳み直し・
      // 台帳・send() の答え）は変わらない**ので、`resumeCalls` の本数で
      // 分岐しつつ両方を確かめる。
      const abortListCalled = deferred<void>();
      const { runner, stopCalls, resumeCalls, sessions } = trackingRunner({
        resumeGate: (async () => {
          await abortListCalled.promise;
          await Promise.resolve();
          await Promise.resolve();
        })(),
      });
      const originalList = runner.list.bind(runner);
      runner.list = async (opts) => {
        const result = await originalList(opts);
        abortListCalled.resolve();
        return result;
      };

      const pool = createManagerPool({
        stores,
        post: () => {},
        runners: createRunnerRegistry([runner]),
        now: () => Date.parse(START),
      });
      await pool.restore();

      const [sendResult, abortResult] = await Promise.all([
        pool.send(managerId, 'hello'),
        pool.abort(managerId),
      ]);

      expect(abortResult.outcome).toBe('stopped');
      expect(abortResult.sessionGone).toBe(true);

      // runner 側に立ったセッション（そもそも立っていれば）は畳み直されて
      // 残らない。
      expect(sessions.has(managerId)).toBe(false);
      if (resumeCalls.length === 0) {
        // チェックポイント1が先に捕まえた——resume そのものが出ていない
        // ので、畳み直しも要らず stop は abort() 自身の1回だけ。
        expect(stopCalls).toHaveLength(1);
      } else {
        // チェックポイント2 または 3 が捕まえた——resume は出たが畳み直された。
        expect(resumeCalls).toHaveLength(1);
        // abort() 自身の stop 呼び出し ＋ 畳み直しの stop 呼び出しで2回。
        expect(stopCalls).toHaveLength(2);
      }

      expect(sendResult.outcome).not.toBe('delivered');
      expect(sendResult.outcome).toBe('session_missing');

      const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
      expect(finalJob?.status).toBe('stopped');
    },
  );

  it('abort() が not_stopped を返した後は、印（stopConfirmedAt）が下ろされ、send() は従来どおり進む', async () => {
    const managerId = 'mgr-orphan-not-stopped';
    const stores = createMemoryStores();
    await stores.jobs.putJob(orphanJob(managerId));

    // **`stop()` を呼んでも実際には止まらない（runner 側で走り続けている）
    // ことを模す。** `list()` は常にこの委譲を含めて返す——`sessionGone` が
    // 常に false になるので、abort() は `outcome: 'not_stopped'` を返す。
    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePath: '/work/project',
      workspacePathKnown: true,
      async connect() {},
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(): Promise<{ cwd?: string }> {
        return {};
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop() {
        // 何もしない（止まらない、を模す）。
      },
      async list(): Promise<RunnerManagerState[]> {
        return [
          {
            managerId,
            status: 'running',
            cwd: '/work/project',
            request: '調べ物',
            waiting: [],
          },
        ];
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
      async close() {},
    };

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([runner]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    // **`Promise.all` で同時に投げない。** Issue #1716 の直しで `abort()` は
    // `#confirmStoppedAndReleaseLease` を await する**前**に印
    // （`record.stopConfirmedAt`）を立てるようになった——`send()` を本当に
    // 同時に投げると、abort() が `not_stopped` と確定して印を下ろす前に
    // send() 側のチェックポイントが印を見てしまい、`session_missing` を
    // 返すことがある（それ自体は「止めている最中かもしれない相手には
    // 慎重に振る舞う」という正しい安全側の挙動であって、この歯が測りたい
    // こと——「確かめた後は印を下ろす」——とは別の変数を持ち込む）。
    // ここで測りたいのは**印が下ろされた後**の状態なので、`abort()` を
    // 先に最後まで終わらせてから `send()` を投げる。
    const abortResult = await pool.abort(managerId);
    expect(abortResult.outcome).toBe('not_stopped');
    expect(abortResult.sessionGone).toBe(false);

    // **印が下ろされているので、send() は従来どおり resume して届く。**
    const sendResult = await pool.send(managerId, 'hello');
    expect(sendResult.outcome).toBe('delivered');

    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    // abort() は not_stopped では台帳を1文字も書かない——最終的に残るのは
    // send() が書いた running である。
    expect(finalJob?.status).toBe('running');
  });

  /**
   * **`send()` 以外の呼び手にも同じ保護が効くことを確かめる。**
   *
   * `send()` はチェックポイント2（`#resume` 内、`runner.resume()` の直後）に
   * 加えて、`send()` 自身が持つチェックポイント3（実際に台帳へ書く直前）でも
   * 二重に守られている——上のテスト群が実際に測っているのは主にこの
   * チェックポイント3である（チェックポイント2だけを外す変異では、
   * チェックポイント3が必ず肩代わりするため、`send()` 経由の歯だけでは
   * チェックポイント2の要否を独立には測れない）。
   *
   * `#reattach()`（`#resumeOnce` の別の呼び手）は、`'resumed'` を受けたあと
   * `record.job.status === 'lost'` かどうかしか見ずに `running` を書く——
   * `'stopped'` は見ない。つまり `#reattach` の経路には
   * チェックポイント3に相当するものが無く、**チェックポイント2だけが
   * 唯一の守りである。** ここではその経路を、`send()` を経由せずに
   * `pool.reattachRunner()` 経由で直接確かめる。
   */
  it('#reattach() が resume の途中で abort() が確定しても running を書き戻さない（チェックポイント2）', async () => {
    const managerId = 'mgr-reattach-race';
    const stores = createMemoryStores();
    const job: Job = {
      id: managerId,
      createdAt: START,
      updatedAt: START,
      status: 'running',
      summary: '走っていた仕事',
      request: '走っていた仕事の依頼',
      cwd: '/work/project',
      sessionId: 'sess-1',
      runnerId: 'runner-primary',
    };
    await stores.jobs.putJob(job);

    const sessions = new Set<string>();
    const stopCalls: string[] = [];
    const resumeCalls: RunnerResumeCommand[] = [];
    // **`abort()` の呼び出しそのものを合図にする。** ティック数を数えて
    // 「たぶん終わっているはず」を仮定する形（当初これで組んだが、
    // 実測で足りなかった——`#reattach` は `send()` より短い経路で
    // `runner.resume()` に達するらしく、数ティックの余裕では
    // `abort()` の同期区間（`record.stopConfirmedAt` を立てるところまで）に
    // 追いつけなかった）ではなく、`pool.abort(...)` が返す Promise
    // そのものを待つ——`abort()` が実際に「終わった」ことを、推測ではなく
    // Promise の解決で確かめる。
    // **`let` ではなく箱に入れる。** `resume()` の閉包は宣言より後で代入される
    // 値を読む必要がある（`pool.abort(...)` を呼ぶまで Promise 自体が無い）が、
    // 束縛そのものは1度も再代入しない——中身（プロパティ）だけを後で埋める。
    const abortSettled: { promise?: Promise<unknown> } = {};

    const runner: RunnerClient = {
      runnerId: 'runner-primary',
      runnerIdKnown: true,
      workspacePath: '/work/project',
      workspacePathKnown: true,
      async connect() {},
      async start(): Promise<{ cwd?: string }> {
        return {};
      },
      async resume(command): Promise<{ cwd?: string }> {
        resumeCalls.push(command);
        // abort() が完全に終わる（`record.stopConfirmedAt` を立て、台帳へ
        // 永続化し、`#retire()` まで済ませる）まで、このセッションが
        // 「立った」ことにしない。
        await abortSettled.promise;
        sessions.add(command.managerId);
        return {};
      },
      async send() {
        return true;
      },
      async answer(): Promise<RunnerAnswerOutcome> {
        return { delivered: false };
      },
      async stop(id) {
        stopCalls.push(id);
        sessions.delete(id);
      },
      async list(): Promise<RunnerManagerState[]> {
        return [...sessions].map((id) => ({
          managerId: id,
          status: 'running' as const,
          cwd: '/work/project',
          request: '調べ物',
          waiting: [],
        }));
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
      async close() {},
    };

    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: registry,
      now: () => Date.parse(START),
    });

    // **`#records` へ像を作る（`restore()` を経由しない）。** `#reattach` は
    // 自分で `this.#stores.jobs.listJobs()` を読むので、`restore()` を挟まなくても
    // 直接 `reattachRunner()` を呼べる。貸し出しが無いジョブなので、関門
    // （`#claimForResume`）は即座に通る。
    const reattachPromise = pool.reattachRunner('runner-primary');
    const abortPromise = pool.abort(managerId);
    abortSettled.promise = abortPromise;
    const [, abortResult] = await Promise.all([reattachPromise, abortPromise]);

    expect(abortResult.outcome).toBe('stopped');
    expect(abortResult.sessionGone).toBe(true);

    // 起こしてしまったセッション（そもそも立っていれば）は畳み直されて残らない。
    expect(sessions.has(managerId)).toBe(false);
    // **`abort()` は Issue #1716 の直しで、印（`record.stopConfirmedAt`）を
    // `#confirmStoppedAndReleaseLease` より前（`#runnerOf` の直後）に立てる
    // ようになった。** そのぶんチェックポイント1がこの回も先に捕まえる
    // ことがある——`resumeCalls` の本数で分岐しつつ両方を確かめる。
    if (resumeCalls.length === 0) {
      expect(stopCalls).toHaveLength(1);
    } else {
      expect(resumeCalls).toHaveLength(1);
      // abort() 自身の stop ＋ 畳み直しの stop で2回。
      expect(stopCalls).toHaveLength(2);
    }

    // **本題。** `#reattach` は `send()` のようなチェックポイント3を持たない
    // ——チェックポイント1／2だけが、ここで `running` の書き戻しを防いでいる。
    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('stopped');
  });
});
