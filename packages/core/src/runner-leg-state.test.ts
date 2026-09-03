import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerLegState,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

/**
 * `RunnerLegState`（runner→デーモンの `/events` の脚。デーモン自身の側の端）
 * まわりの歯。
 *
 * 3本立て:
 * 1. 網羅性——状態が増えたらコンパイルエラーで止まること
 * 2. `RunnerRegistry#entries()` が `client.legState` をそのまま写すこと・
 *    「観測していない」（`legState` を持たない実装）が `'never-connected'`
 *    へ倒れないこと
 * 3. `ManagerPool.runnerBacklog()` が `entries()` の「いまの」`legState` /
 *    `instanceSince` を使って `legState` / `instanceSwapped` を付け足すこと
 *
 * `HttpRunner` 自身が実際に状態を遷移させることは `apps/daemon/src/
 * runner-client.test.ts` 側の歯が持つ（ここは `RunnerClient` の口としての
 * 契約だけを見る）。
 */

// ---------------------------------------------------------------------------
// 1. 網羅性
// ---------------------------------------------------------------------------

/**
 * **網羅は `Record<NonNullable<...>, true>` で持つ**（AGENTS.md「歯」節）。
 * `RunnerLegState['status']` に新しい値が増えたら、この物自体がコンパイル
 * できなくなる——キーが1つ欠けた `Record` はエラーになる。
 *
 * 1文字壊して赤くなることは手元で確認済み（PR 本文に生出力を貼ってある）:
 * `RunnerLegState` の union へ `{ status: 'mutant-extra-state' }` を足すと
 * `tsc` が `packages/core/src/tools.ts` の `assertNeverRunnerLegStatus(leg)`
 * 呼び出しで `TS2345` を出す（`describeRunnerLegState` の `switch` が
 * 網羅していないことを検出する）。
 */
const ALL_RUNNER_LEG_STATUSES: Record<RunnerLegState['status'], true> = {
  connected: true,
  down: true,
  'never-connected': true,
};

describe('RunnerLegState の網羅性', () => {
  it('3状態がすべて記録されている（対象が空でないことを先に確かめる）', () => {
    const statuses = Object.keys(ALL_RUNNER_LEG_STATUSES);
    // **ループで測る前に、対象が空でないことを確かめる**（AGENTS.md「歯」節）
    // ——`Record` が空でも `Object.keys` は空配列を返すだけで、下のループは
    // 1回も回らずに緑へ倒れてしまう。
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(['connected', 'down', 'never-connected']).toContain(status);
    }
    expect(statuses).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 2. entries() が legState を写す・「観測していない」を化けさせない
// ---------------------------------------------------------------------------

/** `legState` を外から差し替えられる最小限の偽 runner。 */
class LegStateRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  instanceId: string | undefined;
  pendingEvents: number | undefined;
  oldestPendingAt: string | undefined;
  /**
   * **`undefined` にできる。** `RunnerClient.legState` は省略可能なので、
   * これを `undefined` のまま持つ runner は「脚を持たない実装」を表す
   * （`LocalRunner` やテストの偽物と同じ形）。
   */
  legState: RunnerLegState | undefined;

  constructor(runnerId: string, instanceId: string | undefined) {
    this.runnerId = runnerId;
    this.instanceId = instanceId;
  }

  async identity(): Promise<
    | { runnerId?: string; instanceId?: string; pendingEvents?: number; oldestPendingAt?: string }
    | undefined
  > {
    return {
      runnerId: this.runnerId,
      ...(this.instanceId === undefined ? {} : { instanceId: this.instanceId }),
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

describe('RunnerRegistry#entries() は client.legState をその場で読む', () => {
  it('legState を持つ実装では、そのまま entries() に出る（キャッシュしない・毎回読み直す）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:00.000Z' };
    const registry = createRunnerRegistry([runner]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect(registry.entries()[0]?.legState).toEqual({
      status: 'connected',
      since: '2026-08-27T00:00:00.000Z',
    });

    // **毎回読み直す。** キャッシュしていれば、ここで直接書き換えても
    // 反映されないはずである。
    runner.legState = { status: 'down', lastFailureReason: 'boom' };
    expect(registry.entries()[0]?.legState).toEqual({ status: 'down', lastFailureReason: 'boom' });

    await registry.stop();
  });

  /**
   * **「観測していない」を `'never-connected'` へ倒さない。** `legState` を
   * 持たない実装（`undefined` のまま）は、`entries()` の出力からも
   * `legState` 自体が消える——`'never-connected'` という値を持つのとは
   * 別の事実である。
   */
  it("legState を持たない実装では、entries() に legState 自体が出ない（'never-connected' へ倒さない）", async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    // legState は意図的に未設定のまま。
    const registry = createRunnerRegistry([runner]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    const entry = registry.entries()[0];
    expect(entry).not.toHaveProperty('legState');

    await registry.stop();
  });
});

// ---------------------------------------------------------------------------
// 3. runnerBacklog() が legState / instanceSwapped を付け足す
// ---------------------------------------------------------------------------

describe('ManagerPool.runnerBacklog() が legState といまの instanceSince から instanceSwapped を付け足す', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('legState をそのまま写す（新しい往復はしない——identity() の呼び出し回数は heartbeat の周期どおり）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:00.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 5,
        observedAt: '2026-08-27T00:00:10.000Z',
        legState: { status: 'connected', since: '2026-08-27T00:00:00.000Z' },
        instanceSwapped: false,
      },
    ]);

    await pool.stop();
    await registry.stop();
  });

  it('legState を持たない runner では、legState 欄ごと省く（観測していない）', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    // legState は意図的に未設定。
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot).not.toHaveProperty('legState');

    await pool.stop();
    await registry.stop();
  });

  /**
   * **本題。** 滞留を観測した時点より後で instanceId が入れ替わったら
   * `instanceSwapped: true`。
   *
   * 仕込み方: t=10s の heartbeat で `pendingEvents=5` / `instanceId='boot-1'`
   * を初めて観測する（この回、`pendingEventsObservedAt` と `instanceSince`
   * は同じ heartbeat 呼び出しから同時に書かれるので、同時刻になる——まだ
   * 入れ替わっていないので `instanceSwapped: false` が正しい）。
   *
   * 続く t=20s の heartbeat では **`pendingEvents` を答えない**（新しい器が
   * まだ資源を報告していない状態を模す）まま `instanceId` だけ `'boot-2'`
   * を名乗らせる——`#noteInstance` は `pendingEvents` が無ければ
   * `entry.pendingEvents` / `pendingEventsObservedAt` に触らない
   * （`RegistryEntry.pendingEvents` の doc）ので、`observedAt` は t=10s の
   * まま古い値が残り、`instanceSince` だけが t=20s へ進む。**この食い違いが
   * `instanceSwapped: true` の材料である。**
   */
  it('滞留を観測した後に器が入れ替わったら instanceSwapped: true', async () => {
    const runner = new LegStateRunner('runner-a', 'boot-1');
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:10.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    // t=10s: 初めて観測。まだ入れ替わっていない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.runnerBacklog!()).toEqual([
      {
        runnerId: 'runner-a',
        pendingEvents: 5,
        observedAt: '2026-08-27T00:00:10.000Z',
        legState: { status: 'connected', since: '2026-08-27T00:00:10.000Z' },
        instanceSwapped: false,
      },
    ]);

    // t=20s: 器が入れ替わる。新しい器はまだ pendingEvents を答えない。
    runner.instanceId = 'boot-2';
    runner.pendingEvents = undefined;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:20.000Z' };
    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    // **滞留の値そのものは t=10s のまま古い**（新しい器が答えていないので
    // `#noteInstance` が触っていない）。
    expect(snapshot?.pendingEvents).toBe(5);
    expect(snapshot?.observedAt).toBe('2026-08-27T00:00:10.000Z');
    // **legState は「いま」の値**（`entries()` を読み直すので、新しい器の
    // `'connected'` がそのまま出る——ここだけを見ると「待ってよい」に
    // 誤読しうる。`instanceSwapped` を必ず一緒に読むべき理由がこれである）。
    expect(snapshot?.legState).toEqual({ status: 'connected', since: '2026-08-27T00:00:20.000Z' });
    // **本題:入れ替わりを検出できている。**
    expect(snapshot?.instanceSwapped).toBe(true);

    await pool.stop();
    await registry.stop();
  });

  it('instanceId を一度も聞けていない runner では instanceSwapped を付けない（判定できない）', async () => {
    const runner = new LegStateRunner('runner-a', undefined);
    runner.pendingEvents = 5;
    runner.legState = { status: 'connected', since: '2026-08-27T00:00:10.000Z' };
    const stores = createMemoryStores();
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({ stores, post: () => undefined, runners: registry });

    await vi.advanceTimersByTimeAsync(10_000);

    const snapshot = pool.runnerBacklog!()[0];
    expect(snapshot).not.toHaveProperty('instanceSwapped');

    await pool.stop();
    await registry.stop();
  });
});
