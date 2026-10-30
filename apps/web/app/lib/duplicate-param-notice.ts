/** `searchParams.get` は先頭の値しか返さない。重複を黙って採ると、人が書いた2つ目の指定が無視されたことに気付けない。 */
export function duplicateParamNotice(label: string): string {
  return `${label}の指定が複数あるので、先頭の値を使っています`;
}

/** `labels` は `[欄名, 画面での呼び名]`。同じ欄が2回以上ある欄だけ、注記の文を返す。 */
export function duplicateParamNotices(
  searchParams: URLSearchParams,
  labels: ReadonlyArray<readonly [string, string]>,
): string[] {
  return labels
    .filter(([param]) => searchParams.getAll(param).length > 1)
    .map(([, label]) => duplicateParamNotice(label));
}
