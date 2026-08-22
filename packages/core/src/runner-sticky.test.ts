import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * `manager_id → runner_id` の貼り付き（sticky routing。M5 受け入れ基準2）。
 *
 * **機構は前から在る**（`Pool#runnerOf` が台帳の `job.runnerId` を
 * `RunnerRegistry#get` で解決し、見つからなければ `null` を返して別の器へは
 * 回さない）。**足りていなかったのはテストである** — 既存の2台以上のテストは
 * 配置（`runner-placement.test.ts`）・指名・heartbeat・一覧の見え方に閉じており、
 * **ルーティングそのものを2台以上で通したものが1本も無かった。** 1台しか
 * 登録していない状態では「宛先を引けている」と「たまたま1台しか居ない」が
 * 区別できない（`manager.test.ts` の「別の runner のジョブには手を出さない」は
 * 1台構成で、*触らない*ことは見ているが *正しい1台へ届く*ことは見ていない）。
 *
 * ここで固定するのは、**3台を同時に登録した状態で** `#runnerOf` を通る4つの経路
 * （`send` / `abort` / `transcript` / `restore`）が、
 *
 * 1. 台帳の `runnerId` が指す器へ届き、
 * 2. **他の器は1度も受けていない**（「届いた」だけでは全台配布でも通ってしまう）、
 * 3. 指す器が居ないなら**別の器へ回さない**、
 *
 * ことである。壊れたときに起きるのは「クローンが A に出した指示が B のマネージャー
 * へ届く」＝別の仕事の文脈に他人の指示が混ざる、である。台帳にも日誌にも
 * 「届けた」としか残らないので、壊れても誰も気づけない形の壊れ方をする。
 *
 * **最後の1本（`runner-dup`）は現状の穴を固定している。** 直っていることを
 * 主張するテストではない — 詳細はそのテストのコメント。
 */

/**
 * 偽 runner。**「誰が何を受けたか」を全部記録する。**
 *
 * `send` / `resume` / `stop` / `transcript` を空実装にすると、宛先が総当たりでも
 * 1台に固定されていても同じ緑になる（＝この保証が消える）。だから受けたものは
 * 引数ごと積み、`receivedCount` で「1度も受けていない」を主張できるようにする。
 * `list()` は数えない — あれは宛先の解決ではなく生死の確認で、Pool は全台に聞く。
 */
class StickyRunner implements RunnerClient {
  readonly runnerId: string;
  readonly workspacePath = '/work/project';
  /** この器が抱えているセッション（`list()` がそのまま返す）。 */
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly sends: { managerId: string; text: string }[] = [];
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  readonly transcripts: string[] = [];
  readonly answers: string[] = [];

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  /**
   * この器が受けた**指示**の総数。
   *
   * 「他の2台は1度も受けていない」を1つの数で言えるようにしてある。経路を1つ
   * 足したときにここへ足し忘れると保証が静かに緩むので、`RunnerClient` の
   * 命令系（`send` / `resume` / `stop` / `transcript` / `answer`）を全部足す。
   */
  get receivedCount(): number {
    return (
      this.sends.length +
      this.resumes.length +
      this.stops.length +
      this.transcripts.length +
      this.answers.length
    );
  }

  /** その器の中でセッションが走っている状態を作る（`restore` の突き合わせ相手）。 */
  hold(managerId: string, status: RunnerManagerState['status'] = 'running'): void {
    this.sessions.set(managerId, {
      managerId,
      status,
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.hold(command.managerId);
  }
  async resume(command: RunnerResumeCommand): Promise<void> {
    this.resumes.push(command);
    this.hold(command.managerId);
  }
  async send(managerId: string, text: string): Promise<void> {
    this.sends.push({ managerId, text });
  }
  async answer(managerId: string): Promise<boolean> {
    this.answers.push(managerId);
    return false;
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    // **止めたセッションは一覧から消す**（実 runner の `onClosed` と同じ）。消さない
    // と `abort` の探り（`list()` に残っているか）が `not_stopped` を返し、宛先が
    // 正しくても「止まった」が観測できない＝テストが別のことを測ってしまう。
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
  async transcript(managerId: string): Promise<string | null> {
    this.transcripts.push(managerId);
    // **どの器から取れたかが本文から分かる形にする。** 固定文字列を返すと、
    // 別の器から取ってきても同じ緑になる。
    return `[生ログ] ${this.runnerId} / ${managerId}\n`;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface Fleet {
  pool: ManagerPool;
  registry: RunnerRegistry;
  stores: Stores;
  inbox: InboxEvent[];
  runners: StickyRunner[];
  close: () => Promise<void>;
}

/**
 * 名簿へ複数台を載せる。**`createRunnerRegistry([a, b, c])` を使わない。**
 *
 * あちらは `adopt` 経路で label に `runnerId` をそのまま使うので、同じ
 * `runnerId` を名乗る2台を渡すと Map（label が鍵）で畳まれて1台になる —
 * 最後のテストが要求している「同じ名前の器が2台居る」状態そのものが作れない。
 * label を自分で決められる `register({ label, open })` を通す。
 */
async function fleetOf(specs: { label: string; runnerId: string }[]): Promise<Fleet> {
  const runners = specs.map((spec) => new StickyRunner(spec.runnerId));
  const registry = createRunnerRegistry();
  for (const [index, spec] of specs.entries()) {
    const runner = runners[index] as StickyRunner;
    await registry.register({ label: spec.label, open: async () => runner });
  }
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return {
    pool,
    registry,
    stores,
    inbox,
    runners,
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

/** 器3台ぶんの名簿（label は宛先の形に寄せてある）。 */
const THREE = [
  { label: 'http://runner-a:8080', runnerId: 'runner-a' },
  { label: 'http://runner-b:8080', runnerId: 'runner-b' },
  { label: 'http://runner-c:8080', runnerId: 'runner-c' },
];

/**
 * 台帳へ直接置くジョブ。
 *
 * **`pool.start({ runnerId })`（指名）で内訳を作らない。** 指名の正しさは別の
 * 保証（`manager.test.ts` の「runner の指名」）なので、そちらの変異でこの歯まで
 * 巻き添えに落ちると、どちらが壊れたか区別できなくなる。ルーティングだけを見る
 * ために台帳（`Job.runnerId`）を直に置く（`manager.test.ts` の「器ごとの本数を
 * 返す」と同じ作法）。
 */
function jobFor(managerId: string, runnerId: string, extra: Partial<Job> = {}): Job {
  const at = '2026-08-01T00:00:00.000Z';
  return {
    id: managerId,
    managerId,
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: `${managerId} の仕事`,
    request: `${managerId} の依頼`,
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId,
    ...extra,
  };
}

/**
 * 3台に1本ずつ、**それぞれの器の中で走っている**状態を作る。
 *
 * `restore()` は runner が生きたセッションを名乗れば繋ぎ直すだけ（resume しない）
 * なので、ここを通した後に観測される `resume` はすべて後続の操作のものである
 * （各テストの先頭でそれを前提として確かめている）。
 */
async function attachedFleet(): Promise<Fleet> {
  const fleet = await fleetOf(THREE);
  for (const runner of fleet.runners) {
    const managerId = `mgr-on-${runner.runnerId}`;
    await fleet.stores.jobs.putJob(jobFor(managerId, runner.runnerId));
    runner.hold(managerId);
  }
  await fleet.pool.restore();
  return fleet;
}

describe('manager_id → runner_id の貼り付き（M5 受け入れ基準2 / 3台同時）', () => {
  it('manager_send は台帳の runnerId が指す器へ届き、他の2台は1度も受けない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];
    // 繋ぎ直しただけで、まだ誰も指示を受けていないこと（この後の観測の起点）。
    expect([a.receivedCount, b.receivedCount, c.receivedCount]).toEqual([0, 0, 0]);

    const result = await fleet.pool.send('mgr-on-runner-b', 'B の続きを進めて');

    expect(result.outcome).toBe('delivered');
    // **本文まで見る。** 宛先だけを数えると、空の `send` でも緑になる。
    expect(b.sends).toEqual([{ managerId: 'mgr-on-runner-b', text: 'B の続きを進めて' }]);
    // **ここが本題。** 全台へ配る実装でも `b.sends` は埋まるので、他の2台が
    // 「1度も受けていない」ことを見ないとこの保証は成立しない。
    expect(a.receivedCount).toBe(0);
    expect(c.receivedCount).toBe(0);

    await fleet.close();
  });

  it('abort も台帳の runnerId が指す器へ届き、他の2台は1度も受けない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const result = await fleet.pool.abort('mgr-on-runner-c', '要らなくなった', 'clone');

    // 宛先が正しいので `stop` が届き、探り（`list()`）でも消えている＝止まったと言える。
    expect(result.outcome).toBe('stopped');
    expect(c.stops).toEqual(['mgr-on-runner-c']);
    // **他の器のマネージャーを止めないことが要点である。** 宛先を間違えた `stop` は
    // 「別の仕事が黙って死ぬ」形で現れ、日誌には正しく止めたようにしか残らない。
    expect(a.receivedCount).toBe(0);
    expect(b.receivedCount).toBe(0);

    await fleet.close();
  });

  it('transcript は台帳の runnerId が指す器から取り、他の2台には聞きに行かない', async () => {
    const fleet = await attachedFleet();
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const body = await fleet.pool.transcript('mgr-on-runner-a');

    // **本文でどの器から来たかを判定する。** 「非 null が返った」だけだと、別の器の
    // 生ログを掴んできても緑になる（クローンが別の仕事のログを読んで判断する形）。
    expect(body).toBe('[生ログ] runner-a / mgr-on-runner-a\n');
    expect(a.transcripts).toEqual(['mgr-on-runner-a']);
    expect(b.transcripts).toEqual([]);
    expect(c.transcripts).toEqual([]);

    await fleet.close();
  });

  it('restore は、それぞれの器のジョブだけを起こし直す（3台に1本ずつ）', async () => {
    // 器の中にセッションは無い（器ごと作り直された後）。台帳の `runnerId` だけが
    // 宛先を知っている状態で、**各器が自分のぶんだけ resume する**ことを見る。
    const fleet = await fleetOf(THREE);
    for (const runner of fleet.runners) {
      await fleet.stores.jobs.putJob(jobFor(`mgr-on-${runner.runnerId}`, runner.runnerId));
    }
    const [a, b, c] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];

    const restored = await fleet.pool.restore();

    expect(restored.map((summary) => summary.managerId).sort()).toEqual([
      'mgr-on-runner-a',
      'mgr-on-runner-b',
      'mgr-on-runner-c',
    ]);
    // **どの器が何本受けたかで見る。** 「3本 resume した」だけなら、1台へ3本
    // まとめて投げる実装でも緑になる（そのとき2台は遊び、1台では同じ workspace を
    // 3本が踏み合う）。
    expect(a.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-a']);
    expect(b.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-b']);
    expect(c.resumes.map((command) => command.managerId)).toEqual(['mgr-on-runner-c']);
    // **session_id まで見る。** 宛先が合っていても別の session を開けば、それは
    // 別の会話の続きである。
    expect(a.resumes[0]?.sessionId).toBe('sess-mgr-on-runner-a');
    // resume 以外の指示は誰にも降りていない。
    expect([a.receivedCount, b.receivedCount, c.receivedCount]).toEqual([1, 1, 1]);

    await fleet.close();
  });

  it('台帳の runnerId が名簿に無い器を指すなら、別の器へは回さない（3台とも受けない）', async () => {
    // 器が畳まれて名簿から消えた状態。**ここで「開いている1台」へ寄せると、
    // workspace の移送をしていないのに別の器で続きが走る**（`#runnerOf` の
    // コメントが言っている、`runnerId` が無い古いジョブだけに許した振る舞いを
    // 全体へ広げてしまう形）。
    const fleet = await fleetOf(THREE);
    await fleet.stores.jobs.putJob(jobFor('mgr-orphan', 'runner-ghost'));

    const result = await fleet.pool.send('mgr-orphan', 'まだ生きていたら続けて');

    expect(result.outcome).toBe('unknown');
    // 何が無いのかが呼び手（クローン）に分かる形で返っている。
    expect(result.detail).toContain('runner-ghost');
    for (const runner of fleet.runners) expect(runner.receivedCount).toBe(0);

    await fleet.close();
  });

  /**
   * **これは「現状こうなる」を固定したもので、正しい振る舞いの宣言ではない。**
   *
   * `RunnerRegistry#get` は名簿を頭から走査して `entry.client?.runnerId` が
   * 一致した**最初の1台**を返す（線形一致）。だから同じ `runnerId` を名乗る器が
   * 2台開いていると、台帳が指しているのは1つの名前なのに、指示は名簿の並び順で
   * 決まった片方へ行く — **クローンが指名した器ではない器で手が動きうる。**
   *
   * 塞ぐのは fencing（M5 PR4 / 貸し出し期限）で、それが入るまで
   * こうなる。`RunnerRegistry#select` の doc（「指名しても片方に固定できない」）と
   * `onSwap` の doc が同じギャップを申し送りしている。
   *
   * **期待値を「どちらの1台か」に固定しないこと。** 内部の走査順に固定すると、
   * fencing が入って正しく1台に決まるようになったときに、直したのに落ちる
   * （嘘の失敗）か、逆に「順番で決まる」ことを仕様として守ってしまう。だから
   * ここで固定するのは**「両方には行かない」**という、直した後も成り立つ形だけに
   * してある。
   */
  it('同じ runnerId を名乗る器が2台あると、指示は片方だけへ行く（現状の穴。fencing 待ち）', async () => {
    const fleet = await fleetOf([
      { label: 'http://runner-dup-1:8080', runnerId: 'runner-dup' },
      { label: 'http://runner-dup-2:8080', runnerId: 'runner-dup' },
      { label: 'http://runner-other:8080', runnerId: 'runner-other' },
    ]);
    const [dup1, dup2, other] = fleet.runners as [StickyRunner, StickyRunner, StickyRunner];
    // 両方が同じ名前で開けている（名簿は label が別なので畳まれない）。**並び順では
    // 数えない** — 順番はこのテストが見たいものではないし、ここで固定すると名簿の
    // 走査順に依存した期待値をもう1つ増やすことになる（下の本題がまさにそれを
    // 避けている）。
    expect(
      fleet.registry.entries().filter((entry) => entry.runnerId === 'runner-dup'),
    ).toHaveLength(2);
    // 器の中にセッションは無いので、`send` は resume 経路を通る（届いた先が記録される）。
    await fleet.stores.jobs.putJob(jobFor('mgr-dup', 'runner-dup', { status: 'done' }));

    const result = await fleet.pool.send('mgr-dup', '続けて');

    expect(result.outcome).toBe('delivered');
    // **1台にしか届いていない**（＝両方で二重に走ってはいない）。どちらかには依存しない。
    const reached = [dup1, dup2].filter((runner) => runner.receivedCount > 0);
    expect(reached).toHaveLength(1);
    expect(dup1.resumes.length + dup2.resumes.length).toBe(1);
    // 名前が違う器には流れない（線形一致でも宛先の名前そのものは効いている）。
    expect(other.receivedCount).toBe(0);

    await fleet.close();
  });
});
