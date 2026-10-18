/**
 * 添付の使用量の「連携の鍵ごとの内訳」を、表示へ出す形（並び順と上限）に整える。
 * CLI・クローンの道具（file_list）・Web の使用量の表示が同じものを使う: 並びや上限が表示ごとに違うと、同じ数が入口ごとに別の顔で見える。
 * 文言とサイズの書き方は呼ぶ側が持つ（各表示が既に使っている整形に合わせるため）。
 *
 * import を1つも持たない: Web のバンドルへ入るので、core 本体（Node の組み込みと SDK）を引き込まないため。
 */

/** 表示に出す鍵の本数の上限。超えた分は「ほか N 本」と数だけ出す。 */
export const INTEGRATION_KEY_USAGE_DISPLAY_LIMIT = 20;

export interface IntegrationKeyUsageRow {
  readonly id: string;
  readonly count: number;
  readonly totalBytes: number;
}

export interface IntegrationKeyUsageView {
  readonly rows: readonly IntegrationKeyUsageRow[];
  /** 上限で出さなかった鍵の本数。 */
  readonly omitted: number;
}

/**
 * totalBytes の降順、同じなら鍵 id の昇順（出力を安定させる）。
 * `byIntegrationKey` を名乗らない旧いデーモンの応答（undefined）は空として読む。
 */
export function integrationKeyUsageView(
  byIntegrationKey: Readonly<Record<string, { count: number; totalBytes: number }>> | undefined,
): IntegrationKeyUsageView {
  const all = Object.entries(byIntegrationKey ?? {})
    .map(([id, bucket]) => ({ id, count: bucket.count, totalBytes: bucket.totalBytes }))
    .sort((a, b) => b.totalBytes - a.totalBytes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    rows: all.slice(0, INTEGRATION_KEY_USAGE_DISPLAY_LIMIT),
    omitted: Math.max(0, all.length - INTEGRATION_KEY_USAGE_DISPLAY_LIMIT),
  };
}
