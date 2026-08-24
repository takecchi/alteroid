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
 * 指名（`select({ runnerId })`）による置き先の選択（roadmap M5、「選ぶ」側）。
 *
 * **これは配置の指名であって、本数の制限ではない。** ここで固定したいのは、
 * 指名された器が使えるときは資源の点数計算（`#place` / `chooseByResources`）を
 * 通さずにその器へ置くこと、使えないときは**他の器へ絶対に落とさない**ことである。
 * 資源による自動配置そのものの固定は `runner-placement.test.ts` が持っているので、
 * ここでは1バイトも触らない（このファイルは新規である）。
 */

/** 偽 runner。**`resources()` と `ping()` の応え方だけを外から決められる。** */
class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  /** `/health` の応え方。生存判定で `lost` を作るために使う。 */
  reply: 'ok' | 'error' = 'ok';
  started: string[] = [];

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    return this.report;
  }

  async ping(): Promise<void> {
    if (this.reply === 'error') throw new Error('fetch failed');
  }

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

describe('指名（select({ runnerId })）', () => {
  it('指名した器が使えるなら、資源の点数計算を通さずそこへ置く', async () => {
    // **点数だけを見れば roomy が勝つ構図にしておく。** それでも tight を名指し
    // したら tight が返ることを確かめれば、点数計算（`#place`）を通っていない
    // 証拠になる。
    const roomy = new FakeRunner('runner-roomy', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    });
    const tight = new FakeRunner('runner-tight', {
      memory: { limitBytes: 32_000_000_000, usedBytes: 30_000_000_000, source: 'cgroup' },
      managers: 4,
    });
    const registry = createRunnerRegistry([roomy, tight]);

    const chosen = await registry.select({ runnerId: 'runner-tight' });

    expect(chosen.runnerId).toBe('runner-tight');
    await registry.stop();
  });

  describe('指名した器が使えないとき', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('失敗する。他の器へは落とさない', async () => {
      const alive = new FakeRunner('runner-alive');
      const dying = new FakeRunner('runner-dying');
      const registry = createRunnerRegistry([alive, dying]);

      // 生存判定で `dying` を `lost` に落とす（30秒＝間隔の3回分、無応答）。
      dying.reply = 'error';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(registry.entries()).toMatchObject([
        { label: 'runner-alive', state: 'connected' },
        { label: 'runner-dying', state: 'lost' },
      ]);

      await expect(registry.select({ runnerId: 'runner-dying' })).rejects.toThrow(/lost/);
      // **他の器へ落ちていないこと。** 選ばれていたら `select` は `runner-alive` を
      // 返していたはずだが、そもそも例外で終わっている——`alive` に何も届いていない
      // ことを、この例外そのものが証明する（`alive.started` を見るまでもない）。

      await registry.stop();
    });
  });

  it('名簿にその名前が無いとき失敗する', async () => {
    const a = new FakeRunner('runner-a');
    const b = new FakeRunner('runner-b');
    const registry = createRunnerRegistry([a, b]);

    await expect(registry.select({ runnerId: 'runner-does-not-exist' })).rejects.toThrow(
      /runner-does-not-exist.*一致しない/s,
    );

    await registry.stop();
  });

  it('まだ一度も開けていない器が残っているときは「無い」と断定しない', async () => {
    // **開き終わっていない1台が居る。** その器が実は指名された名前を持っている
    // 可能性を、断定で消してはいけない。
    const registry = createRunnerRegistry([], { retryBaseMs: 10_000, retryMaxMs: 10_000 });
    // **`await` しない。** `open()` が永久に開かないので、`register()` の内部は
    // `this.#entries.set(...)` の直後（初回 `await` の手前）まで同期的に進んでから
    // 止まる——その時点で名簿には既に載っている（`register` の doc「開き終わるのを
    // 待たずに載る」そのもの）ので、`await` せず次へ進んでよい。
    void registry.register({
      label: 'まだ開いていない器',
      open: () => new Promise(() => undefined), // 永久に開かない（開いている最中）
    });

    await expect(registry.select({ runnerId: 'runner-unknown' })).rejects.toThrow(
      /まだ一度も開けていないので.*分からない/s,
    );

    await registry.stop();
  });

  it('同じ名前を名乗る2台が開けているとき失敗する（名前が一意でない）', async () => {
    // **`Registry#get` の線形一致と同じ穴。** 別々の label で登録された2台が、
    // 同じ `runnerId` を名乗って開けている状況（roadmap M5 PR4 の fencing 待ち）。
    const registry = createRunnerRegistry();
    await registry.register({ label: 'label-a', open: async () => new FakeRunner('dup-name') });
    await registry.register({ label: 'label-b', open: async () => new FakeRunner('dup-name') });

    await expect(registry.select({ runnerId: 'dup-name' })).rejects.toThrow(/一意でない/);

    await registry.stop();
  });
});
