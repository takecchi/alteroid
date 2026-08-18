import { describe, expect, it } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
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
 */

/** 偽 runner。**`resources()` の応え方だけを外から決められる。** */
class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly workspacePath = '/work/project';
  /** `undefined` = 資源を報告しない runner（古い器）。 */
  report: RunnerPlacementResources | undefined;
  started: string[] = [];

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    return this.report;
  }

  async ping(): Promise<void> {}
  async connect(): Promise<void> {}
  async start(command: { managerId: string }): Promise<void> {
    this.started.push(command.managerId);
  }
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

async function registryOf(...runners: FakeRunner[]): Promise<ReturnType<typeof createRunnerRegistry>> {
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
});
