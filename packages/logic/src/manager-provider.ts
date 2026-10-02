/**
 * マネージャー層の provider の表示（#486 S9）。
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
