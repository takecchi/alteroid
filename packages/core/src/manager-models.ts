import { ANTHROPIC_ROUTE_NONE_LINE } from './anthropic-route-env.js';

export interface ManagerModelSource {
  runnerReportedModels?(runnerId: string): { manager?: string; worker?: string } | undefined;
}

export interface ManagerModels {
  managerModel?: string;
  workerModel?: string;
}

/** runner が `hello` で名乗った値だけを返す。デーモンの環境変数や既定の帯では埋めない: 動いていないモデルを名乗ることになるため。 */
export function managerModelsOf(
  pool: ManagerModelSource | undefined,
  summary: { runnerId?: string | undefined },
): ManagerModels {
  if (summary.runnerId === undefined) return {};
  const models = pool?.runnerReportedModels?.(summary.runnerId);
  if (models === undefined) return {};
  return {
    ...(models.manager === undefined ? {} : { managerModel: models.manager }),
    ...(models.worker === undefined ? {} : { workerModel: models.worker }),
  };
}

export const MODEL_UNKNOWN_LABEL = '不明（名乗りを受けていない）';

export function describeManagerModels(models: ManagerModels): string {
  return `マネージャー ${models.managerModel ?? '不明'} / 作業者 ${models.workerModel ?? '不明'}`;
}

export interface RunnerModelSource extends ManagerModelSource {
  runners(): Promise<{
    runners: readonly { label: string; state: string; runnerId?: string }[];
  }>;
}

export const RUNNER_MODELS_UNVERIFIED =
  'runner のモデルを確かめられなかった（マネージャー層・作業者層のモデルは不明）';

// 名乗りの無い runner は既定の帯で埋めず「不明」と書く: 動いていないモデルを名乗ることになるため。
export async function collectRunnerModelLines(pool: RunnerModelSource): Promise<string[]> {
  if (pool.runnerReportedModels === undefined) return [];
  try {
    const fleet = await pool.runners();
    const lines: string[] = [];
    for (const runner of fleet.runners) {
      if (runner.runnerId === undefined) continue;
      if (runner.state !== 'connected' && runner.state !== 'vacating') continue;
      const models = managerModelsOf(pool, runner);
      const named =
        models.managerModel === undefined && models.workerModel === undefined
          ? MODEL_UNKNOWN_LABEL
          : describeManagerModels(models);
      lines.push(`runner ${runner.label === '' ? runner.runnerId : runner.label}: ${named}`);
    }
    return lines;
  } catch {
    return [RUNNER_MODELS_UNVERIFIED];
  }
}

export interface RunnerRouteSource {
  runnerReportedAnthropicRoute?(runnerId: string): readonly string[] | undefined;
  runners(): Promise<{
    runners: readonly { label: string; state: string; runnerId?: string }[];
  }>;
}

// 「何も置かれていない」（`[]`）とは別に言う。
export const RUNNER_ROUTE_UNREPORTED_LABEL = '名乗っていない（古い runner）';

export async function collectRunnerRouteLines(pool: RunnerRouteSource): Promise<string[]> {
  if (pool.runnerReportedAnthropicRoute === undefined) return [];
  try {
    const fleet = await pool.runners();
    const lines: string[] = [];
    for (const runner of fleet.runners) {
      if (runner.runnerId === undefined) continue;
      if (runner.state !== 'connected' && runner.state !== 'vacating') continue;
      const head = `runner ${runner.label === '' ? runner.runnerId : runner.label}:`;
      const reported = pool.runnerReportedAnthropicRoute(runner.runnerId);
      if (reported === undefined) {
        lines.push(`${head} ${RUNNER_ROUTE_UNREPORTED_LABEL}`);
      } else if (reported.length === 0) {
        lines.push(`${head} ${ANTHROPIC_ROUTE_NONE_LINE}`);
      } else {
        lines.push(head, ...reported.map((line) => `  ${line}`));
      }
    }
    return lines;
  } catch {
    return [RUNNER_MODELS_UNVERIFIED];
  }
}
