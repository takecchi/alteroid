import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

/**
 * 器の入れ替えを名簿が見分けられること（roadmap M5 PR4 の判定材料）。
 *
 * **`onLost` では拾えない事象である。** 器が入れ替わっても `/health` は応え続ける
 * ので、生死の判定からは何も起きていないように見える — これまでは**黙って入れ替わって
 * いた**（roadmap 受け入れ基準6 の「一度開いた宛先が黙って入れ替わった場合は今も
 * 引き取りが走らない」）。
 *
 * ここで固定するのは2つで、**2つ目のほうが重い**。
 *
 * 1. 入れ替わったことを知らせる
 * 2. **`runnerId` を採らない** — 採れば台帳の鎖（`manager_id → runner_id`）が音もなく
 *    繋ぎ変わる。`ping` が本文を読まない形にしてあった元の理由がこれで、読むように
 *    した以上、採らないことをテストで押さえておかないと意味が反転する
 *
 * **時計は手で進める**（`runner-heartbeat.test.ts` と同じ理由）。
 */

/** `identity()` を持つ偽 runner。**名乗る中身を外から差し替えられる。** */
class IdentifyingRunner implements RunnerClient {
  readonly runnerId: string;
  /**
   * **既定は `true`（既存テストの前提を変えない）。** `false` に差し替えると
   * 「`/health` から一度も `runnerId` を受け取れていない」状態を再現できる
   * （#330 の歯のために足した）。
   */
  runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  /** `/health` を叩かれた回数。 */
  probes = 0;
  /** いま名乗るプロセスの識別子。差し替えると「器が入れ替わった」になる。 */
  instanceId: string | undefined;
  /** 名乗る `runnerId`。**採られないことを見る**ために差し替えられるようにしてある。 */
  claimedRunnerId: string;
  /**
   * 名乗る版。既定は無し（従来どおり `revision` を返さない runner を再現する）。
   * `connected` は `identity()` を一度も呼んだことを保証しない、という歯
   * （下の「一度も probe されていない」describe）のためだけに足した。
   */
  revision: { status: 'known'; commit: string; short: string; source: 'build' } | undefined;
  /**
   * 名乗る未送出件数（#358 案b の第2段）。既定は無し——`resources()` と同じく
   * 「取れていない」を表す（0を既定にしない）。
   */
  pendingEvents: number | undefined;
  /** 名乗る最古の未送出時刻。`pendingEvents` と同じ観測から出る想定。 */
  oldestPendingAt: string | undefined;

  constructor(runnerId: string, instanceId: string | undefined) {
    this.runnerId = runnerId;
    this.claimedRunnerId = runnerId;
    this.instanceId = instanceId;
  }

  async identity(): Promise<
    | {
        runnerId?: string;
        instanceId?: string;
        revision?: IdentifyingRunner['revision'];
        pendingEvents?: number;
        oldestPendingAt?: string;
      }
    | undefined
  > {
    this.probes += 1;
    return {
      runnerId: this.claimedRunnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
      ...(this.revision === undefined ? {} : { revision: this.revision }),
      ...(this.pendingEvents === undefined ? {} : { pendingEvents: this.pendingEvents }),
      ...(this.oldestPendingAt === undefined ? {} : { oldestPendingAt: this.oldestPendingAt }),
    };
  }

  // 以下は名簿が触らない口。
  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
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

/** `identity()` を持たない古い runner（`ping()` しか無い）。 */
class PingOnlyRunner extends IdentifyingRunner {
  // `identity` を消すために上書きする（`undefined` を代入できる形にしていない）。
  override identity = undefined as unknown as IdentifyingRunner['identity'];

  async ping(): Promise<void> {
    this.probes += 1;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('器の入れ替えを見分ける', () => {
  it('同じ宛先に別のプロセスが応え始めたら知らせる', async () => {
    const swaps: { label: string; runnerId?: string; before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    /*
     * **開けた瞬間には叩かない。** いま応えているプロセスは `hello()` が既に読んだ
     * 応答から採るので、往復は増えない（`#open` の doc / `RunnerClient.instanceId`）。
     *
     * **採った1回目では知らせない** — 初めて聞いた分は入れ替えではないので覚える
     * だけである（ここで知らせると、起きた直後に必ず1回出る）。
     */
    expect(runner.probes).toBe(0);
    expect(swaps).toEqual([]);

    // ハートビートは**1周に1回だけ**叩く（生死と名乗りで2往復投げない）。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);
    expect(swaps).toEqual([]);

    // 同じプロセスが応え続けている間は何も起きない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(2);
    expect(swaps).toEqual([]);

    // 器が入れ替わった（新しいコンテナが同じ宛先に応え始めた）。
    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      {
        label: 'http://runner:4518',
        runnerId: 'runner-a',
        before: 'boot-1',
        after: 'boot-2',
      },
    ]);

    await registry.stop();
  });

  /**
   * **知らせは遷移で、名簿は状態である。** `onSwap` を見落とした後・デーモン自身が
   * 再起動した後に「いまどのプロセスが応えているのか」を確かめる口が無いと、
   * 引き取りの判定（`lease.ts`）が正しいかを誰も検算できない。
   */
  it('いま応えているプロセスと、それを初めて見た時刻が名簿の状態として出る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    const opened = registry.entries()[0];
    expect(opened?.instanceId).toBe('boot-1');
    const firstSeen = opened?.instanceSince;
    expect(firstSeen).toEqual(expect.any(String));

    // **同じ相手なら「初めて見た時刻」は動かさない**（動かすと、入れ替わりの猶予が
    // ハートビートごとに先送りされ、引き取れる時刻が永久に来ない）。
    await vi.advanceTimersByTimeAsync(20_000);
    expect(registry.entries()[0]?.instanceSince).toBe(firstSeen);

    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);
    const swapped = registry.entries()[0];
    expect(swapped?.instanceId).toBe('boot-2');
    expect(Date.parse(swapped?.instanceSince ?? '')).toBeGreaterThan(Date.parse(firstSeen ?? ''));

    await registry.stop();
  });

  /**
   * **`onLost` とは違って「1回だけ」ではない。** 落ちたことは状態の遷移だが、
   * 入れ替わりは何度でも起きる出来事である（再デプロイのたびに起きる）。
   */
  it('入れ替わるたびに知らせる', async () => {
    const swaps: { before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-3';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      { before: 'boot-1', after: 'boot-2' },
      { before: 'boot-2', after: 'boot-3' },
    ]);

    await registry.stop();
  });

  /**
   * **これが本題である。** 名乗りの中身を読むようにしたので、`runnerId` まで採る
   * 実装に倒れやすい。採れば台帳の鎖（`manager_id → runner_id`）が音もなく繋ぎ
   * 変わり、走っている委譲の宛先が誰にも見えないまま別の器へ移る。
   */
  it('別の runner_id を名乗られても、宛先の名前は書き換えない', async () => {
    const swaps: { runnerId?: string }[] = [];
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    // 入れ替わった器が、別の名前を名乗り始めた。
    runner.instanceId = 'boot-2';
    runner.claimedRunnerId = 'runner-imposter';
    await vi.advanceTimersByTimeAsync(10_000);

    // 知らせには**書き換えていない名前**が載る（台帳の鎖はこの名前で繋がっている）。
    expect(swaps).toMatchObject([{ runnerId: 'runner-a' }]);
    // 名簿から引ける名前も変わっていない。
    expect((await registry.get('runner-a'))?.runnerId).toBe('runner-a');
    expect(await registry.get('runner-imposter')).toBeNull();

    await registry.stop();
  });

  /**
   * **#330 の罠そのもの。** `runnerId` は常に文字列を持つ（`HttpRunner` の既定値
   * `'runner-primary'`）ので、`entry.client !== null` だけを根拠に出すと、
   * `/health` から一度も `runnerId` を受け取れていない相手についても「受け取った
   * 値」の顔で出てしまう。`runnerIdKnown: false` は、まさにその「聞けていない」
   * 状態を表す。
   */
  it('runnerId を聞けていない runner の入れ替えでは、runnerId を出さない（#330）', async () => {
    const swaps: { label: string; runnerId?: string; before: string; after: string }[] = [];
    const runner = new IdentifyingRunner('runner-primary', 'boot-1');
    runner.runnerIdKnown = false;
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    runner.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(swaps).toMatchObject([
      { label: 'http://runner:4518', before: 'boot-1', after: 'boot-2' },
    ]);
    // **既定値 `'runner-primary'` が「聞けた値」の顔で出ていないことを名指しで見る。**
    expect(swaps[0]).not.toHaveProperty('runnerId');

    await registry.stop();
  });

  /**
   * **入れ替えの判定は「知らせない」側へ倒す。** `instanceId` を返さない runner を
   * 「入れ替わっていない」と読むと、判定できないことが出力から消える。
   */
  it('identity() を持たない runner では判定しない（生死は今まで通り見る）', async () => {
    const swaps: unknown[] = [];
    const runner = new PingOnlyRunner('runner-old', undefined);
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    // `ping()` へ落ちて、生死は今まで通り見えている。
    expect(runner.probes).toBe(3);
    expect(swaps).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    await registry.stop();
  });

  it('instanceId を名乗らない応答でも判定しない', async () => {
    const swaps: unknown[] = [];
    const runner = new IdentifyingRunner('runner-a', undefined);
    const registry = createRunnerRegistry([], { onSwap: (event) => swaps.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    // ハートビート3周ぶん（開けるときは `hello()` の応答から採るので増えない）。
    expect(runner.probes).toBe(3);
    expect(swaps).toEqual([]);

    await registry.stop();
  });

  /**
   * **`state: 'connected'` は「版が分かっている」を保証しない——版を名乗らない
   * runner に限って。**
   *
   * `#open()`（`runner-protocol.ts`）は `entry.source.open()` が解決した直後、
   * `client.revision`（`hello()` 相当——`runnerId` / `workspacePath` と同じ
   * 応答から拾う値）が在ればそれを採るので、**版を報告できる runner は繋がった
   * 瞬間から `known` / `unknown` に見える**（`identity()` の最初の heartbeat を
   * 待たない）。
   *
   * **`revision` を実装しない runner（`IdentifyingRunner` の既定・実物では
   * `LocalRunner`）だけが `unheard` のまま残る。** `identity()` すら版を
   * 返さない（`this.revision` を設定していない）ので、`state: 'connected'` に
   * なった後、heartbeat が1周してもなお `unheard` が動かないことまでここで
   * 固定する——「繋がった瞬間の窓」ではなく「版を名乗る手段を持たない runner
   * の恒常的な姿」であることを示す。
   */
  it('版を名乗らない runner（LocalRunner 相当）は connected でも unheard のまま——heartbeat が回っても動かない', async () => {
    // `IdentifyingRunner` の既定では `revision` を設定しない——`hello()` に
    // 相当する値も `identity()` が返す値も、どちらも無い runner を表す。
    const runner = new IdentifyingRunner('runner-fresh', 'boot-1');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner-fresh:4518', open: async () => runner });

    // **接続直後。** heartbeat を一切進めていない状態でも unheard。
    expect(runner.probes).toBe(0);
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner-fresh:4518', state: 'connected', revision: { status: 'unheard' } },
    ]);

    // **heartbeat を1周させても変わらない。** `identity()` 自体は呼ばれる
    // （`probes` が増える）が、`this.revision` を設定していないので
    // `identity()` の応答に `revision` が乗らず、`#markSeen` は何も更新しない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner-fresh:4518', revision: { status: 'unheard' } },
    ]);

    await registry.stop();
  });

  /**
   * **窓が塞がっている側の証拠。** 上のテストと対になる——`revision` を実装
   * する runner は、heartbeat を待たずに `known` として見える。
   */
  it('版を名乗る runner は、接続した瞬間（heartbeat 前）から known として見える', async () => {
    const runner = new IdentifyingRunner('runner-fresh', 'boot-1');
    runner.revision = {
      status: 'known',
      commit: 'c'.repeat(40),
      short: 'c'.repeat(12),
      source: 'build',
    };
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner-fresh:4518', open: async () => runner });

    // **heartbeat を一切進めていない。** それでも known——`#open()` が
    // `hello()` 相当の応答から直接採ったからである。
    expect(runner.probes).toBe(0);
    expect(registry.entries()).toMatchObject([
      {
        label: 'http://runner-fresh:4518',
        state: 'connected',
        revision: { status: 'known', commit: 'c'.repeat(40) },
      },
    ]);

    await registry.stop();
  });
});

/**
 * runner→デーモンの脚（`Outbox` の滞留）を、heartbeat（`#probe`）からも
 * warm できること（#358 案b の第2段）。
 *
 * `resources()` は `runner_list resources: true` を明示的に呼んだときにしか
 * 叩かれないので、それを一度も呼んでいない runner の滞留キャッシュは cold の
 * ままだった（案b の第1段の弱点）。ここで固定するのは、**同じ2欄
 * （`pendingEvents` / `oldestPendingAt`）を `identity()` の応答からも拾い、
 * 10秒ごとの heartbeat が自然に warm すること**——新しい往復は無い
 * （`identity()` を叩く回数は変わらない。`runner.probes` で数える）。
 */
describe('runner→デーモンの脚の滞留を heartbeat からも warm する（#358 案b の第2段）', () => {
  it('#probe が1周すると、値と観測時刻の両方が名簿に入る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.oldestPendingAt = '2026-08-20T00:00:00.000Z';
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    // **開けた瞬間には warm しない。** `#open()` は `client.instanceId` /
    // `client.revision`（プロパティ）しか読まない——`pendingEvents` は
    // `identity()` の**呼び出し結果**からしか拾えないので、heartbeat を
    // 待つ必要がある（`resources()` と同じく、繋がった瞬間には無い）。
    expect(registry.entries()[0]).not.toHaveProperty('pendingEvents');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);

    const entry = registry.entries()[0];
    expect(entry?.pendingEvents).toBe(5);
    expect(entry?.oldestPendingAt).toBe('2026-08-20T00:00:00.000Z');
    expect(entry?.pendingEventsObservedAt).toEqual(expect.any(String));

    await registry.stop();
  });

  /**
   * `pendingEvents` は0件でも「測れた値」なので、そのまま記録される
   * （`resources()` 側の同じ規律——`managers` と同じ扱い）。**0を「取れて
   * いない」に混同しないこと**——ここが `oldestPendingAt` と違う軸である。
   */
  it('pendingEvents が0のときも、そのまま記録される（0は「取れていない」ではない）', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 0;
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    const entry = registry.entries()[0];
    expect(entry?.pendingEvents).toBe(0);
    expect(entry).not.toHaveProperty('oldestPendingAt');
    expect(entry?.pendingEventsObservedAt).toEqual(expect.any(String));

    await registry.stop();
  });

  /**
   * **`identity()` を持たない runner（`ping()` しか無い旧来の実装）では、
   * 名簿には何も入らない。** 0で埋めると「滞留0」と「取れていない」の区別が
   * 消える（AGENTS.md「取れない軸に0の行を作る」）。生死の判定（`ping()`）は
   * 今まで通り動くことも一緒に確かめる——締め出さない。
   */
  it('identity() を持たない runner では、pendingEvents は一切書かれない（0で埋めない）', async () => {
    const runner = new PingOnlyRunner('runner-old', undefined);
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(30_000);

    // `ping()` へ落ちて、生死は今まで通り見えている（締め出していない）。
    expect(runner.probes).toBe(3);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    const entry = registry.entries()[0];
    expect(entry).not.toHaveProperty('pendingEvents');
    expect(entry).not.toHaveProperty('oldestPendingAt');
    expect(entry).not.toHaveProperty('pendingEventsObservedAt');

    await registry.stop();
  });

  /**
   * **`identity()` はあるが、その回だけ `pendingEvents` を返さない**（応答の
   * 形が壊れた・この機能より前の応答を模す）場合も、前回書いた値を消さない
   * ——書かれるのは「取れたとき」だけで、取れなかった回に既存の値を消すのは
   * 別の判断である（`#noteInstance` は「触らない」で、`undefined` 上書きは
   * しない）。
   */
  it('pendingEvents を返さない回があっても、前回までの値は残る', async () => {
    const runner = new IdentifyingRunner('runner-a', 'boot-1');
    runner.pendingEvents = 3;
    const registry = createRunnerRegistry([], {});
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()[0]?.pendingEvents).toBe(3);

    // 次の周では欄自体を返さなくなった。
    runner.pendingEvents = undefined;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.entries()[0]?.pendingEvents).toBe(3);

    await registry.stop();
  });
});
