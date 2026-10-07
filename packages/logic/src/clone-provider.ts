// 欄が無いときは `claude` と推測せず「不明」と書く: 古いデーモンか配線されていない構成だから。
export const CLONE_PROVIDER_UNKNOWN_LABEL = '不明（サーバが値を返していない）';

export function describeCloneProvider(cloneProvider: string | null | undefined): string {
  return cloneProvider === undefined || cloneProvider === null || cloneProvider === ''
    ? CLONE_PROVIDER_UNKNOWN_LABEL
    : cloneProvider;
}
