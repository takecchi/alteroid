import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
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

  constructor(runnerId: string, instanceId: string | undefined) {
    this.runnerId = runnerId;
    this.claimedRunnerId = runnerId;
    this.instanceId = instanceId;
  }

  async identity(): Promise<
    { runnerId?: string; instanceId?: string; revision?: IdentifyingRunner['revision'] } | undefined
  > {
    this.probes += 1;
    return {
      runnerId: this.claimedRunnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
      ...(this.revision === undefined ? {} : { revision: this.revision }),
    };
  }

  // 以下は名簿が触らない口。
  async connect(): Promise<void> {}
  async start(): Promise<void> {}
  async resume(): Promise<void> {}
  async send(): Promise<void> {}
  async answer(): Promise<boolean> {
    return false;
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

    // 1回目は覚えるだけ。**ここで知らせると、起きた直後に必ず1回出る。**
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.probes).toBe(1);
    expect(swaps).toEqual([]);

    // 同じプロセスが応え続けている間は何も起きない。
    await vi.advanceTimersByTimeAsync(10_000);
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

    expect(runner.probes).toBe(3);
    expect(swaps).toEqual([]);

    await registry.stop();
  });

  /**
   * **`state: 'connected'` は `identity()` を一度も呼んだことを保証しない。**
   *
   * `#open()`（`runner-protocol.ts`）は `entry.source.open()` が解決した時点で
   * `state = 'connected'` を即座に立てるが、`identity()` は heartbeat
   * （`HEARTBEAT_INTERVAL_MS` ごとの `#beat()`）でしか呼ばれない。つまり
   * **登録が終わってから最初の heartbeat が回るまでの間（最大で約10秒）**、
   * runner は `connected` なのに `revision` は初期値の `unheard` のままである
   * ——たとえその runner の `identity()` が呼ばれれば `known` を返す実装でも、
   * 呼ばれていない以上は `unheard` としか言えない。
   *
   * これは稀なレースではなく、**新しく繋がった runner 全員が必ず一度通る窓**
   * である。`state` だけを見て「繋がっているのに版が無いのはおかしい」と
   * 読まないこと——`revision` は `state` とは別の、独立した観測である。
   */
  it('connected の直後・最初の heartbeat が回るまでは revision は unheard のまま（identity() はまだ呼ばれていない）', async () => {
    const runner = new IdentifyingRunner('runner-fresh', 'boot-1');
    // 「呼べば known を返す」runner を使う——それでも呼んでいない間は unheard
    // であることが本体である。
    runner.revision = {
      status: 'known',
      commit: 'c'.repeat(40),
      short: 'c'.repeat(12),
      source: 'build',
    };
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner-fresh:4518', open: async () => runner });

    // **heartbeat を一切進めていない。** register() が解決した直後の状態を見る。
    expect(runner.probes).toBe(0);
    expect(registry.entries()).toMatchObject([
      { label: 'http://runner-fresh:4518', state: 'connected', revision: { status: 'unheard' } },
    ]);

    await registry.stop();
  });
});
