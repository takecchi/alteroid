/** {@link managerModelsOf} が読むプールの最小の形（`ManagerPool` の部分集合）。 */
export interface ManagerModelSource {
  runnerReportedModels?(runnerId: string): { manager?: string; worker?: string } | undefined;
}

export interface ManagerModels {
  managerModel?: string;
  workerModel?: string;
}

/**
 * 委譲のマネージャー・作業者のモデル（#3921・#3947）。宛先の runner が `hello` で名乗った値だけを返し、
 * 置き先が無い・名乗りを受けていない・欄を送らない旧い runner・この口を持たないプールは、欄ごと載せない（＝不明）。
 * デーモンの環境変数や既定の帯では埋めない: 動いていないモデルを名乗ることになるため。
 * デーモンの一覧・詳細・地図とクローンの道具が同じ読み方をするよう、ここ1か所に置く。
 */
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

/** 名乗りが無いことを言う語。`claude` や既定の帯に化けさせない。 */
export const MODEL_UNKNOWN_LABEL = '不明（名乗りを受けていない）';

/** `manager_list` / `manager_report` の「モデル:」の右側。取れない側は「不明」と書く。 */
export function describeManagerModels(models: ManagerModels): string {
  return `マネージャー ${models.managerModel ?? '不明'} / 作業者 ${models.workerModel ?? '不明'}`;
}

/** {@link collectRunnerModelLines} が読むプールの最小の形（`ManagerPool` の部分集合）。 */
export interface RunnerModelSource extends ManagerModelSource {
  runners(): Promise<{
    runners: readonly { label: string; state: string; runnerId?: string }[];
  }>;
}

/** runner の一覧が読めずモデルを確かめられなかったときの1行。 */
export const RUNNER_MODELS_UNVERIFIED =
  'runner のモデルを確かめられなかった（マネージャー層・作業者層のモデルは不明）';

/**
 * 接続中の runner それぞれが `hello` で名乗ったマネージャー・作業者のモデルの行。
 * 名乗りを受けていない runner は「不明」と書く: 既定の帯で埋めると、動いていないモデルを名乗ることになるため。
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
