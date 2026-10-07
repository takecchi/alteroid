import { AGENT_PROVIDER_IDS } from './agent-ports.js';
import { MANAGER_PROVIDER_UNKNOWN_LABEL } from './manager-provider-format.js';

/** {@link collectRunnerModelLines} が読むプールの最小の形（`ManagerPool` の部分集合）。 */
export interface RunnerModelSource {
  runners(): Promise<{
    runners: readonly { label: string; state: string; runnerId?: string }[];
  }>;
  runnerReportedModels?(
    runnerId: string,
    provider: string,
  ): { manager: string; worker: string } | undefined;
}

/** runner の一覧が読めずモデルを確かめられなかったときの1行。 */
export const RUNNER_MODELS_UNVERIFIED =
  'runner のモデルを確かめられなかった（マネージャー層・作業者層のモデルは不明）';

/**
 * 接続中の runner それぞれが `hello` で名乗ったマネージャー層・作業者層のモデルの行。
 * runner の数え方は `collectRunnerProviderGaps` と同じ。名乗りを受けていない runner は
 * 「不明」と書く: 既定の帯で埋めると、動いていないモデルを名乗ることになるため。
 * 名乗りを引く口を持たないプール（テストの偽物）は何も足さない。
 */
export async function collectRunnerModelLines(pool: RunnerModelSource): Promise<string[]> {
  if (pool.runnerReportedModels === undefined) return [];
  try {
    const fleet = await pool.runners();
    const lines: string[] = [];
    for (const runner of fleet.runners) {
      if (runner.runnerId === undefined) continue;
      if (runner.state !== 'connected' && runner.state !== 'vacating') continue;
      const parts: string[] = [];
      for (const provider of AGENT_PROVIDER_IDS) {
        const models = pool.runnerReportedModels(runner.runnerId, provider);
        if (models !== undefined) {
          parts.push(`${provider} → マネージャー ${models.manager} / 作業者 ${models.worker}`);
        }
      }
      lines.push(
        `runner ${runner.label === '' ? runner.runnerId : runner.label}: ${parts.length === 0 ? MANAGER_PROVIDER_UNKNOWN_LABEL : parts.join('; ')}`,
      );
    }
    return lines;
  } catch {
    return [RUNNER_MODELS_UNVERIFIED];
  }
}
