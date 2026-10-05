/**
 * クローン層の provider の表示（#486 S9）。
 *
 * クローン層の provider はデーモン全体で1つで、デーモンが起動時に解決して必ず持つ
 * （既定は `claude`。それは仕様であって推測ではない）。だから実デーモンの応答では
 * 欄が常に在る。**欄が無いときは古いデーモンか配線されていない構成なので、`claude` と
 * 読まずに「不明」と書く**（`describeManagerProvider` と同じ作法）。
 */
export const CLONE_PROVIDER_UNKNOWN_LABEL = '不明（サーバが値を返していない）';

export function describeCloneProvider(cloneProvider: string | null | undefined): string {
  return cloneProvider === undefined || cloneProvider === null || cloneProvider === ''
    ? CLONE_PROVIDER_UNKNOWN_LABEL
    : cloneProvider;
}
