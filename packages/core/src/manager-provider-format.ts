/**
 * マネージャー層の provider の表示（#486 S9）。正本（logic・CLI・クローンの道具が読む）。
 *
 * **欄が無いことは「不明」と書く。`claude` とは読まない。** 置き先の runner がまだ
 * 名乗っていない・欄を送らない旧い runner・置き先が無い委譲では、デーモンは値を
 * 載せない（`managerSummarySchema` の `managerProvider`）。それを `claude` と
 * 描くと、取れなかったことが出力から消える（AGENTS.md 地雷表「取れない軸に 0 の行を
 * 作る」と同じ形）。
 */
export const MANAGER_PROVIDER_UNKNOWN_LABEL = '不明（名乗りを受けていない）';

export function describeManagerProvider(managerProvider: string | null | undefined): string {
  return managerProvider === undefined || managerProvider === null || managerProvider === ''
    ? MANAGER_PROVIDER_UNKNOWN_LABEL
    : managerProvider;
}

/** {@link managerAgentOf} が読むプールの最小の形（`ManagerPool` の部分集合）。 */
export interface ManagerAgentSource {
  runnerReportedManagerProvider?(runnerId: string): string | undefined;
  runnerReportedModels?(
    runnerId: string,
    provider: string,
  ): { manager: string; worker: string } | undefined;
}

export interface ManagerAgent {
  managerProvider?: string;
  managerModel?: string;
  workerModel?: string;
}

/**
 * 委譲のマネージャー層の provider と、マネージャー層・作業者層のモデル（#486 S9・#3947）。
 * 宛先の runner が名乗った値だけを返し、取れないものは欄ごと載せない（＝不明）。
 * 経路判断用の `runnerManagerProvider()`（既定 `claude`）やデーモンの環境変数は使わない:
 * 取れていない値を既定の帯で埋めると、動いていないモデルを名乗ることになるため。
 * デーモンの一覧・詳細とクローンの道具が同じ読み方をするよう、ここ1か所に置く。
 */
export function managerAgentOf(
  pool: ManagerAgentSource | undefined,
  summary: { runnerId?: string | undefined; managerProvider?: string | undefined },
): ManagerAgent {
  // クローンが指名した委譲は、runner の既定ではなく**実際に動いている provider**（#486 S7）。
  const managerProvider =
    summary.managerProvider ??
    (summary.runnerId === undefined
      ? undefined
      : pool?.runnerReportedManagerProvider?.(summary.runnerId));
  if (managerProvider === undefined) return {};
  const models =
    summary.runnerId === undefined
      ? undefined
      : pool?.runnerReportedModels?.(summary.runnerId, managerProvider);
  return {
    managerProvider,
    ...(models === undefined ? {} : { managerModel: models.manager, workerModel: models.worker }),
  };
}

/** `provider: ` の右側。provider が取れても、モデルが取れなければ「不明」と書き足す。 */
export function describeManagerAgent(agent: ManagerAgent): string {
  const provider = describeManagerProvider(agent.managerProvider);
  if (agent.managerProvider === undefined) return provider;
  return agent.managerModel === undefined || agent.workerModel === undefined
    ? `${provider}（モデルは${MANAGER_PROVIDER_UNKNOWN_LABEL}）`
    : `${provider}（マネージャー ${agent.managerModel} / 作業者 ${agent.workerModel}）`;
}
