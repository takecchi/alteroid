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
