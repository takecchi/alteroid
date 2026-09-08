import { describe, expect, it } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

/**
 * 資源による配置（roadmap M5 / PR3）。
 *
 * ここで固定したいのは**配置の材料が実行環境の資源である**ことと、それが
 * **定員にならない**ことである。`select` は常に置き先を返す — 資源を見るのは
 * 「どこに置くか」を決めるためだけで、「置けるか」を決めるためではない
 * （north_star 禁止2 / roadmap M5 の地雷）。
 *
 * **cgroup とホストの値の違いは `runner-resources.test.ts` が押さえている。**
 * ここは受け取った報告の使い方だけを見る。
 */

/** 偽 runner。**`resources()` の応え方だけを外から決められる。** */
class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  /** `undefined` = 資源を報告しない runner（古い器）。 */
  report: RunnerPlacementResources | undefined;
  /** `true` = 資源を聞けない（落ちた口・時間切れ）。 */
  fails = false;
  /** 聞かれた回数。**1台のときは聞きに行かない**ことを見るために数える。 */
  asked = 0;
  started: string[] = [];

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.asked += 1;
    if (this.fails) throw new Error('資源を聞けない');
    return this.report;
  }

  async ping(): Promise<void> {}
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.started.push(command.managerId);
  }
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

async function registryOf(
  ...runners: FakeRunner[]
): Promise<ReturnType<typeof createRunnerRegistry>> {
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  return registry;
}

describe('資源による配置', () => {
  it('メモリに余裕がある方へ置く（登録の順番では決めない）', async () => {
    // 1台目が先に登録されている。**先頭を返す実装ならここで1台目が返る。**
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const registry = await registryOf(tight, roomy);

    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-roomy');

    await registry.stop();
  });

  it('メモリが同じなら、新しい1本の取り分が大きい方へ置く（CPU と稼働本数）', async () => {
    const memory = {
      limitBytes: 32_000_000_000,
      usedBytes: 8_000_000_000,
      source: 'cgroup',
    } as const;
    // 4コアを2本で分けている器（新しい1本の取り分は 4/3）。
    const small = new FakeRunner('runner-small', {
      memory,
      cpu: { cores: 4, source: 'cgroup' },
      managers: 2,
    });
    // 32コアを4本で分けている器（同じく 32/5）。**コア数だけでも本数だけでも決まらない。**
    const large = new FakeRunner('runner-large', {
      memory,
      cpu: { cores: 32, source: 'cgroup' },
      managers: 4,
    });
    const registry = await registryOf(small, large);

    expect((await registry.select({})).runnerId).toBe('runner-large');

    await registry.stop();
  });

  it('資源を報告しない古い器を締め出さない（報告するのは M4 からある稼働本数だけ）', async () => {
    // 報告できる1台が満杯に近い。**報告しない器を除外する実装だと、ここで満杯の器へ
    // 置き続ける** — 古い器が締め出されるのはデグレードである（M5 受け入れ基準5）。
    const reporting = new FakeRunner('runner-reporting', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 31_500_000_000, source: 'cgroup' },
      cpu: { cores: 32, source: 'cgroup' },
      managers: 4,
    });
    const legacy = new FakeRunner('runner-legacy', { managers: 0 });
    const registry = await registryOf(reporting, legacy);

    expect((await registry.select({})).runnerId).toBe('runner-legacy');

    await registry.stop();
  });

  it('誰も資源を報告しないなら、抱えている本数の少ない方へ置く', async () => {
    // 1台構成から増やしたばかりで、どちらも古い器という状態。**それでも登録順よりは
    // ましな材料がある**（`/health` の稼働本数は M4 からある）。
    const busy = new FakeRunner('runner-busy', { managers: 5 });
    const idle = new FakeRunner('runner-idle', { managers: 1 });
    const registry = await registryOf(busy, idle);

    expect((await registry.select({})).runnerId).toBe('runner-idle');

    await registry.stop();
  });

  it('資源を1つも名乗らない器（口の無い実装）でも置き先になる', async () => {
    const silent = new FakeRunner('runner-silent');
    const registry = await registryOf(silent);

    expect((await registry.select({})).runnerId).toBe('runner-silent');

    await registry.stop();
  });

  it('全部が使い切っていても置き先を返す（0点でも断らない）', async () => {
    // **ここが定員との分かれ目である。** 「余裕が無いので置けない」と言い始めたら、
    // それは同時に走れる本数の上限であって配置の判断ではない（禁止2）。
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const first = new FakeRunner('runner-full-a', { memory: full, managers: 3 });
    const second = new FakeRunner('runner-full-b', { memory: full, managers: 9 });
    const registry = await registryOf(first, second);

    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-full-a');

    await registry.stop();
  });

  it('資源を聞けない1台が混ざっても、聞けた報告で配置する', async () => {
    // 聞けなかった1台は「報告しない器」として平均で埋まるだけで、**残りの報告は
    // そのまま活きる。** 1台の失敗で配置が登録順へ戻ると、資源を見ている意味が消える。
    const broken = new FakeRunner('runner-broken', { managers: 0 });
    broken.fails = true;
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const registry = await registryOf(broken, tight, roomy);

    expect((await registry.select({})).runnerId).toBe('runner-roomy');
    expect(broken.asked).toBe(1);

    await registry.stop();
  });

  it('どれからも資源を聞けなくても置き先を返す（聞けないことを理由に断らない）', async () => {
    const first = new FakeRunner('runner-mute-a');
    const second = new FakeRunner('runner-mute-b');
    first.fails = true;
    second.fails = true;
    const registry = await registryOf(first, second);

    // **ここで投げたら定員と同じ形になる。** 資源が読めないことは配置の材料が無いと
    // いうだけで、置けない理由ではない（禁止2）。
    expect((await registry.select({})).runnerId).toBe('runner-mute-a');

    await registry.stop();
  });

  it('1台しか無いなら資源を聞きに行かない（委譲に往復を足さない）', async () => {
    const only = new FakeRunner('runner-only', { managers: 0 });
    const registry = await registryOf(only);

    expect((await registry.select({})).runnerId).toBe('runner-only');
    expect(only.asked).toBe(0);

    await registry.stop();
  });
});

/**
 * プロセス数（pids）を点数に混ぜた分（#712）。
 *
 * **ここで固定したいのは「pids を*読んでいる*」ことである。** grep は「探した
 * 範囲に無かった」までしか言えないので、**振る舞いの側で言い切る** —— 同じ艦隊
 * から `pids` の欄だけを抜くと勝者が変わる、という形にしてある（この向きなら
 * 実装を1行も読まずに読まれていることが決まる）。
 *
 * **そして「断らない」は1文字も動かしていない。** すぐ上の
 * `it('全部が使い切っていても置き先を返す（0点でも断らない）')` はそのまま緑で、
 * ここでも pids まで枯れた艦隊で同じことを確かめる（north_star 禁止2）。
 */
describe('配置の材料としての pids（#712）', () => {
  const MEMORY = {
    limitBytes: 32_000_000_000,
    usedBytes: 8_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;

  it('他の材料が同じなら、プロセス数の余りが多い方へ置く（登録の順番では決めない）', async () => {
    // **満杯の側を先に登録する。** 先頭を返す実装でも、pids を読まない実装でも、
    // ここは満杯の器（登録順の先・同点）が返る。
    const full = new FakeRunner('runner-full', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 999, max: 1000 },
      managers: 2,
    });
    const room = new FakeRunner('runner-room', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 3, max: 1000 },
      managers: 2,
    });
    const registry = await registryOf(full, room);

    expect((await registry.select({})).runnerId).toBe('runner-room');

    await registry.stop();
  });

  it('pids の欄を抜くと勝者が変わる（点数が pids を読んでいる、の変異による証明）', async () => {
    // 同じ艦隊を2通り作る。**違いは `pids` の欄が在るか無いかだけ**で、メモリ・
    // CPU・稼働本数は1バイトも変えていない。
    const withPids = await registryOf(
      new FakeRunner('runner-full', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 999, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-room', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 5, max: 1000 },
        managers: 1,
      }),
    );
    const withoutPids = await registryOf(
      new FakeRunner('runner-full', { memory: MEMORY, cpu: CPU, managers: 0 }),
      new FakeRunner('runner-room', { memory: MEMORY, cpu: CPU, managers: 1 }),
    );

    // pids を抜くと、稼働本数の少ない `runner-full` が勝つ（#712 以前の答え）。
    expect((await withoutPids.select({})).runnerId).toBe('runner-full');
    // pids を戻すと、枯れていない `runner-room` が勝つ。**欄の有無だけで答えが
    // 動く** ⟹ この値は読まれている。
    expect((await withPids.select({})).runnerId).toBe('runner-room');
    expect((await withPids.select({})).runnerId).not.toBe((await withoutPids.select({})).runnerId);

    await withPids.stop();
    await withoutPids.stop();
  });

  it('落ちて空いた満杯の器へ吸い込まれない（#712 の輪を切る）', async () => {
    // **これが #712 の本体である。** 満杯の器へ置かれたマネージャーは起動直後に
    // 落ち、落ちると `/health` の `managers` が減り、減った分だけ点数の分母が
    // 縮んで**その器がまた選ばれる**。pids を読めば、`managers` が最少でも勝てない。
    const burned = new FakeRunner('runner-burned', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 998, max: 1000 },
      // 落ちた分だけ減っている（依頼者の実測では3本続けてここへ置かれた）。
      managers: 1,
    });
    const healthy = new FakeRunner('runner-healthy', {
      memory: MEMORY,
      cpu: CPU,
      pids: { current: 115, max: 1000 },
      managers: 3,
    });
    const registry = await registryOf(burned, healthy);

    // **3回続けて聞く。** `chooseByResources` は状態を持たない純関数なので、
    // 1回だけ正しくても意味が無い —— 決定的に同じ答えを返すことがこの輪の性質である。
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe('runner-healthy');
    }

    await registry.stop();
  });

  it('pids を名乗らない器は、名乗った器の平均として競う（不当に不利にも有利にもならない）', async () => {
    // 名乗る2台（0.02 と 0.98）は**どちらの艦隊にも同じ値で居る**ので、名乗らない
    // 器を埋める平均は両方とも 0.5 で固定である。**動かすのは相手側の稼働本数だけ。**
    const saturated = () =>
      new FakeRunner('runner-saturated', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 980, max: 1000 },
        managers: 0,
      });
    const silent = () => new FakeRunner('runner-silent', { memory: MEMORY, cpu: CPU, managers: 0 });

    // 1. **最良として扱っていない** —— 余裕のある器が居れば、そちらが勝つ。
    const roomyWins = await registryOf(
      saturated(),
      new FakeRunner('runner-roomy', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 20, max: 1000 },
        managers: 0,
      }),
      silent(),
    );
    expect((await roomyWins.select({})).runnerId).toBe('runner-roomy');

    // 2. **締め出してもいない** —— 余裕のある器が本数で沈んだら、名乗らない器は
    //    満杯の器より上に来る（`managers: 0` の満杯の器に負けない）。
    const silentWins = await registryOf(
      saturated(),
      new FakeRunner('runner-roomy', {
        memory: MEMORY,
        cpu: CPU,
        pids: { current: 20, max: 1000 },
        managers: 20,
      }),
      silent(),
    );
    expect((await silentWins.select({})).runnerId).toBe('runner-silent');

    await roomyWins.stop();
    await silentWins.stop();
  });

  it('pids を1台も名乗らない艦隊では、点数が #712 以前と1ミリも変わらない', async () => {
    // **素通りの証明。** 全台が名乗らない艦隊と、全台が同じ値を名乗る艦隊で、
    // 既存の3材料だけで決まる答え（`runner-large`）が変わらないことを見る。
    const fleet = (pids?: { current: number; max: number }) =>
      registryOf(
        new FakeRunner('runner-small', {
          memory: MEMORY,
          cpu: { cores: 4, source: 'cgroup' },
          managers: 2,
          ...(pids === undefined ? {} : { pids }),
        }),
        new FakeRunner('runner-large', {
          memory: MEMORY,
          cpu: { cores: 32, source: 'cgroup' },
          managers: 4,
          ...(pids === undefined ? {} : { pids }),
        }),
      );

    const none = await fleet();
    const uniform = await fleet({ current: 500, max: 1000 });

    expect((await none.select({})).runnerId).toBe('runner-large');
    expect((await uniform.select({})).runnerId).toBe('runner-large');

    await none.stop();
    await uniform.stop();
  });

  it('pids まで全部使い切っていても置き先を返す（0点でも断らない）', async () => {
    // **禁止2 の歯を pids の軸へも伸ばす。** 「プロセスが無いので置けない」と
    // 言い始めたら、それは配置ではなく定員である。
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const first = new FakeRunner('runner-dead-a', {
      memory: full,
      cpu: CPU,
      pids: { current: 1000, max: 1000 },
      managers: 3,
    });
    const second = new FakeRunner('runner-dead-b', {
      memory: full,
      cpu: CPU,
      pids: { current: 1000, max: 1000 },
      managers: 9,
    });
    const registry = await registryOf(first, second);

    expect((await registry.select({})).runnerId).toBe('runner-dead-a');

    await registry.stop();
  });
});
