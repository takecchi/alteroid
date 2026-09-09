import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * 起動失敗が、その器の点数を上げないこと（#712）。
 *
 * **#719 と同じ形で言い切る。** あちらの doc が書いたとおり、grep は「探した範囲に
 * 無かった」までしか言えないので、**振る舞いの側で言い切る** —— ここでは
 * 「同じ艦隊で、落ちたことを名簿へ知らせたか否かだけを変えると勝者が変わる」
 * という形にしてある。
 *
 * **#719 の歯（`pids` の欄を抜くと勝者が変わる）ではこの輪は塞げない。** 依頼者の
 * 実測（Issue #712 のコメント）が示したのは、**`pids` に差が無い艦隊では
 * `pidsRoom` が比較から消える**ことで、そのとき順位は `cores / (managers + 1)`
 * だけで決まる ＝ #719 以前と同じ式に戻る。だから輪は `pids` とは独立に回る。
 *
 * **輪の後半（落ちると `managers` が減る）は、ここでは測っていない。**
 * `apps/runner/src/health-managers-on-failure.test.ts` が `/health` の応答で
 * 固定している。ここが測るのは前半（`managers` が減ると点数が上がる）と、
 * その打ち消しだけである。
 *
 * **`chooseByResources` は状態を持たない純関数なので、勝者は3回続けて確かめる。**
 * 1回だけ正しくても意味が無い —— 決定的に同じ答えを返すことがこの輪の性質である。
 */
describe('起動失敗が、その器の点数を上げない（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  /** 3台とも完全に同じ値。**`pidsRoom` を比較から消すため**（依頼者の実測と同じ）。 */
  const PIDS = { current: 200, max: 1000 } as const;

  /** 依頼者が実測したのと同じ艦隊（登録順: primary → 2 → 3）。 */
  async function measuredFleet(runner2Managers: number) {
    return registryOf(
      new FakeRunner('runner-primary', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 3 }),
      new FakeRunner('runner-2', {
        memory: MEMORY,
        cpu: CPU,
        pids: PIDS,
        managers: runner2Managers,
      }),
      new FakeRunner('runner-3', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 3 }),
    );
  }

  /** 3回続けて同じ器が返ることを見る。 */
  async function winsThreeTimes(
    registry: ReturnType<typeof createRunnerRegistry>,
    runnerId: string,
  ): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      expect((await registry.select({})).runnerId).toBe(runnerId);
    }
  }

  it('落ちて空いた器へ吸い込まれない（pids に差が無い艦隊でも輪が切れる）', async () => {
    // **これが #712 の本体である。** 3台の memory / cpu / pids は1バイトも違わず、
    // 動かしているのは `managers` だけ —— runner-2 で2本落ちて 3 から 1 へ減った、
    // という依頼者の実測そのままの入力である。
    const ignored = await measuredFleet(1);
    const counted = await measuredFleet(1);
    counted.noteManagerFailed('runner-2');
    counted.noteManagerFailed('runner-2');

    // **知らせなければ、落ちた器が勝つ。** 依頼者が実測した答え（#712 の輪）。
    await winsThreeTimes(ignored, 'runner-2');
    // **知らせると、落ちる前と同じ答えに戻る。** 落ちた2本を抱えているものとして
    // 数えるので、分母が 1+2+1 = 4 となり、他の2台（3+1 = 4）と同点になる
    // —— 同点なら登録順の先で runner-primary である。
    await winsThreeTimes(counted, 'runner-primary');

    await ignored.stop();
    await counted.stop();
  });

  it('落ちる前の答えへ戻すだけである（罰ではない）', async () => {
    // **足し戻しが「観測の補正」であることを見る。** 1本も落ちていない艦隊
    // （全台 `managers: 3`）の答えと、runner-2 で2本落ちた艦隊で落ちた分を
    // 数えた答えが、**同じ器**であること。**下がりすぎていない。**
    const before = await measuredFleet(3);
    const after = await measuredFleet(1);
    after.noteManagerFailed('runner-2');
    after.noteManagerFailed('runner-2');

    expect((await before.select({})).runnerId).toBe('runner-primary');
    expect((await after.select({})).runnerId).toBe('runner-primary');

    await before.stop();
    await after.stop();
  });

  it('同点のときだけ、直近に落とした器を後ろへ回す（登録順の先に居ても勝たせない）', async () => {
    // **足し戻しだけでは塞がらない形。** 落ちた器が**登録順の先**に居て、足し
    // 戻した後にちょうど同点になると、「同点なら登録順の先」で落ちた器が勝ち
    // 続ける —— 点数は動いていないので、輪の見た目だけが変わって中身は残る。
    //
    // 分母: burned = 0（managers）+ 2（失敗）+ 1 = 3 ／ healthy = 2 + 0 + 1 = 3。
    // **点数は完全に同点で、違うのは「直近に落としたか」だけである。**
    const registry = await registryOf(
      new FakeRunner('runner-burned', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 0 }),
      new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 2 }),
    );
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');

    await winsThreeTimes(registry, 'runner-healthy');

    await registry.stop();
  });

  it('同点の判定を === でやらない（誤差ぶんだけ大きい点数に負けない）', async () => {
    // **点数は浮動小数である。** 掛ける順序が違うだけで `0.02` と
    // `0.020000000000000004` に割れる —— `===` で同点を判定すると、
    // 「同点のときだけ効く」はずの分岐が**掛け算の綾**で効かなくなる。
    //
    // - runner-noise: memoryRoom 0.1 × pidsRoom 0.2 × 8/(2+1+1) = 0.020000000000000004
    // - runner-clean: memoryRoom 0.02 × pidsRoom 1 × 8/(3+0+1) = 0.02
    //
    // **`>` で見れば runner-noise が勝つ。** 誤差を許して同点と見れば、直近に
    // 落としていない runner-clean が勝つ。**登録順でも runner-noise が先である。**
    const registry = await registryOf(
      new FakeRunner('runner-noise', {
        memory: { limitBytes: 1000, usedBytes: 900, source: 'cgroup' },
        cpu: { cores: 8, source: 'cgroup' },
        pids: { current: 800, max: 1000 },
        managers: 2,
      }),
      new FakeRunner('runner-clean', {
        memory: { limitBytes: 1000, usedBytes: 980, source: 'cgroup' },
        cpu: { cores: 8, source: 'cgroup' },
        pids: { current: 0, max: 1000 },
        managers: 3,
      }),
    );
    registry.noteManagerFailed('runner-noise');

    await winsThreeTimes(registry, 'runner-clean');

    await registry.stop();
  });

  it('点数に意味のある差が在れば、失敗数は効かない（同点のときだけの分岐である）', async () => {
    // **一般のペナルティに化けていないことを見る。** 落ちた器のほうが資源で
    // 明確に勝っているなら、そちらへ置く —— 「最近落ちた器を避ける」ではなく
    // 「落ちたことで点数が上がるのを止める」だけである。
    const registry = await registryOf(
      new FakeRunner('runner-burned-but-roomy', {
        memory: MEMORY,
        cpu: { cores: 32, source: 'cgroup' },
        pids: { current: 10, max: 1000 },
        managers: 0,
      }),
      new FakeRunner('runner-clean-but-tight', {
        memory: MEMORY,
        cpu: { cores: 2, source: 'cgroup' },
        pids: { current: 900, max: 1000 },
        managers: 8,
      }),
    );
    registry.noteManagerFailed('runner-burned-but-roomy');
    registry.noteManagerFailed('runner-burned-but-roomy');

    await winsThreeTimes(registry, 'runner-burned-but-roomy');

    await registry.stop();
  });

  it('失敗を1本も数えていない艦隊では、点数が #712 以前と1ミリも変わらない', async () => {
    // **素通りの証明**（#719 の同名の歯と同じ向き）。既存の材料だけで決まる答えが、
    // この直しの前後で変わらないこと。
    const registry = await registryOf(
      new FakeRunner('runner-small', {
        memory: MEMORY,
        cpu: { cores: 4, source: 'cgroup' },
        managers: 2,
      }),
      new FakeRunner('runner-large', {
        memory: MEMORY,
        cpu: { cores: 32, source: 'cgroup' },
        managers: 4,
      }),
    );

    await winsThreeTimes(registry, 'runner-large');

    await registry.stop();
  });

  it('全部が落としていても置き先を返す（0点でも断らない、を失敗の軸へも伸ばす）', async () => {
    // **禁止2 の歯を、この直しが足した軸へも伸ばす。** すぐ上の
    // `it('全部が使い切っていても置き先を返す（0点でも断らない）')` は1文字も
    // 動かしていない —— ここは同じことを「全台が落としている」艦隊で確かめる。
    const full = {
      limitBytes: 32_000_000_000,
      usedBytes: 32_000_000_000,
      source: 'cgroup',
    } as const;
    const registry = await registryOf(
      new FakeRunner('runner-burned-a', {
        memory: full,
        cpu: CPU,
        pids: { current: 1000, max: 1000 },
        managers: 3,
      }),
      new FakeRunner('runner-burned-b', {
        memory: full,
        cpu: CPU,
        pids: { current: 1000, max: 1000 },
        managers: 9,
      }),
    );
    for (let i = 0; i < 20; i += 1) {
      registry.noteManagerFailed('runner-burned-a');
      registry.noteManagerFailed('runner-burned-b');
    }

    // **投げない。返る。** 「どこも落としているので置けない」と言い始めたら、
    // それは配置ではなく定員である。
    const chosen = await registry.select({});
    expect(chosen.runnerId).toBe('runner-burned-a');

    await registry.stop();
  });
});

/**
 * 失敗の記憶がいつ消えるか（#712）。
 *
 * **消え方は2つあり、別々の理由で要る。**
 *
 * 1. **時間**（`PLACEMENT_FAILURE_MEMORY_MS` = 5分）—— 一時的な不調が過ぎた器を
 *    避け続けないため。永久に覚えると実質の締め出しになる（north_star 禁止2）
 * 2. **器の入れ替え** —— `runnerId` は器を作り直しても同じ値なので、消さないと
 *    **もう居ないプロセスの記録で、いま応えているプロセスの健康を判定する**
 *
 * **時計は注入する。** `vi.useFakeTimers()` でも進められるが、あれは名乗りを
 * 聞きに行く `setInterval` と `withDeadline` の `setTimeout` まで同時に止める
 * —— 測りたいのは窓1つなのに、無関係な2つの時計が巻き込まれる。
 */
describe('失敗の記憶が消える条件（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;
  /**
   * `runner-protocol.ts` の `PLACEMENT_FAILURE_MEMORY_MS` と同じ値を、**歯の側でも
   * 手で書く。** 実装から import すると、値を動かす変更が両側で同時に動いて
   * 緑のまま通る（＝この数字は測られていないのと同じになる）。
   */
  const MEMORY_MS = 5 * 60_000;

  /** 時計を握った名簿。**登録順は burned → healthy。** */
  async function fleetWithClock(now: () => number) {
    const registry = createRunnerRegistry([], { now });
    for (const runner of [
      new FakeRunner('runner-burned', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 0 }),
      new FakeRunner('runner-healthy', { memory: MEMORY, cpu: CPU, pids: PIDS, managers: 2 }),
    ]) {
      await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
    }
    return registry;
  }

  it('窓の内側では覚えていて、窓の外では忘れる（境目は「ちょうど」で忘れる側）', async () => {
    let clock = 1_000_000;
    const registry = await fleetWithClock(() => clock);

    // burned は分母 0 + 1 = 1 で圧勝する側。**落ちた2本を数えると 0+2+1 = 3 で
    // healthy（2+0+1 = 3）と同点になり、同点なら落としていない側が勝つ。**
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    // **窓の内側（1ミリ秒手前）ではまだ覚えている。**
    clock += MEMORY_MS - 1;
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    // **ちょうど窓の長さだけ経ったら、もう数えない。** 境目をどちらへ倒すかは
    // ここで決めてある（実装は `at > since` で、`>=` ではない）。
    clock += 1;
    expect((await registry.select({})).runnerId).toBe('runner-burned');

    await registry.stop();
  });

  it('落ち続けるあいだは窓が更新される（連続して落ちる形は取りこぼさない）', async () => {
    let clock = 1_000_000;
    const registry = await fleetWithClock(() => clock);

    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    // 窓の直前まで進めてから、もう2本落ちる。**古い2本は落ちるが、新しい2本が
    // 残るので数は保たれる。**
    clock += MEMORY_MS - 1;
    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    clock += 2;

    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    await registry.stop();
  });
});

/** `identity()` を持つ偽 runner（器の入れ替えを起こすため）。 */
class SwappableRunner extends FakeRunner {
  instanceId: string;

  constructor(runnerId: string, instanceId: string, report: RunnerPlacementResources) {
    super(runnerId, report);
    this.instanceId = instanceId;
  }

  async identity(): Promise<{ runnerId?: string; instanceId?: string }> {
    return { runnerId: this.runnerId, instanceId: this.instanceId };
  }
}

describe('器が入れ替わったら失敗の記憶を捨てる（#712）', () => {
  const MEMORY = {
    limitBytes: 8_000_000_000,
    usedBytes: 4_000_000_000,
    source: 'cgroup',
  } as const;
  const CPU = { cores: 8, source: 'cgroup' } as const;
  const PIDS = { current: 200, max: 1000 } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('入れ替わりを検知したら、その runnerId の失敗は数え直しになる', async () => {
    const burned = new SwappableRunner('runner-burned', 'boot-1', {
      memory: MEMORY,
      cpu: CPU,
      pids: PIDS,
      managers: 0,
    });
    const healthy = new SwappableRunner('runner-healthy', 'boot-1', {
      memory: MEMORY,
      cpu: CPU,
      pids: PIDS,
      managers: 2,
    });
    const registry = createRunnerRegistry();
    for (const runner of [burned, healthy]) {
      await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
    }

    registry.noteManagerFailed('runner-burned');
    registry.noteManagerFailed('runner-burned');
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    // **同じ相手のままなら忘れない。** 名乗りを何度聞いても記憶は残る
    // （忘れる契機は「入れ替わった」であって「時間が経った」ではない
    // —— 時間の側はすぐ上の describe が持つ）。
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await registry.select({})).runnerId).toBe('runner-healthy');

    // **別のプロセスが応え始めた。** ここで前の器の記録を捨てる。
    burned.instanceId = 'boot-2';
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await registry.select({})).runnerId).toBe('runner-burned');

    await registry.stop();
  });
});
