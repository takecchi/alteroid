import type { AccountUsageState } from './usage-snapshot.js';
import type { UsageBreakdown, UsageRow, UsageTotals } from './usage.js';

/**
 * 層（**誰が**）と場所（**どこで**）の取りうる値。**この2本が唯一の一覧である。**
 *
 * 意味と「なぜこの値しか無いか」は `usage.ts` の `usageLayerSchema` /
 * `usageSiteSchema` に書いてある。**値の並びだけをここへ置いてあるのは、
 * ブラウザ（`apps/web`）が読めるのがこのファイルだけだからである** — 画面が
 * 絞り込みの選択肢を持つために zod と core 全体を読ませるわけにはいかず、かと
 * いって画面側に書き写すと、値が増えたときにそこだけ古くなる。
 *
 * `usage.ts` の schema はこの2本から作る（`z.enum(USAGE_LAYERS)`）。**だから
 * ここへ足せば schema も画面も同時に追いつく。**
 */
export const USAGE_LAYERS = ['clone', 'manager'] as const;
export const USAGE_SITES = ['session', 'distill'] as const;

/**
 * 台帳の数字を読める形にするための算術と整形。
 *
 * **実行時の依存を1つも持たない**（型は `usage.ts` から `import type` で取るので
 * ビルド時に消える）。これは意図的な分離である — `@alteroid/core/usage` として
 * subpath で出しており、**ブラウザ（apps/web）はここだけを読む。**
 *
 * `index.ts` 経由で読ませると、Node の組み込み（`node:fs` / `node:child_process`）と
 * Claude Agent SDK を含む core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ
 * 入る。「金額を4桁で整形して足す」ためにそれを毎回読ませるのは、画面を開く人への
 * 実害である。
 *
 * **それでも算術は1つに保つ。** 口ごとに足し直すと「CLI では $3 なのに画面では
 * $2.9」という形で信用を失う。だから web 専用に書き写すのではなく、**同じ実装を
 * 軽い口から出す**。
 */

/**
 * 数字を見せるときに必ず添える但し書き。**どの口でも落とさないこと。**
 *
 * SDK の型コメントが `An estimate, not a billing statement` と明記している。
 * 台帳に積んだ値を確定として見せると、それは黙って嘘をつくことになる。
 */
export const USAGE_ESTIMATE_NOTICE =
  'SDK が返す推定値であり、Anthropic の請求明細ではない（一致しないことがある）。';

export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUsd: 0,
};

/** 行の合計（モデル横断・日横断）。表示側の算術をここへ寄せる。 */
export function sumUsageRows(rows: readonly UsageRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.totals.inputTokens,
      outputTokens: sum.outputTokens + row.totals.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + row.totals.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + row.totals.cacheCreationInputTokens,
      webSearchRequests: sum.webSearchRequests + row.totals.webSearchRequests,
      costUsd: sum.costUsd + row.totals.costUsd,
    }),
    { ...ZERO_USAGE },
  );
}

// **`V` を `string` へ既定させつつ呼び出し側の戻り値型で推論させる。** `byLayer` /
// `bySite` は `usageLayerSchema` / `usageSiteSchema` の union 型を保つ必要があり、
// 常に `string` へ広げると `usageBreakdownSchema` の型と合わなくなる（層/場所の軸を
// 足したときにここで実際に build が壊れた）。`byDate` / `byManager` / `byModel` は
// 元々 `string` 相当なので既定のままで壊れない。
function groupBy<K extends string, V extends string = string>(
  rows: readonly UsageRow[],
  key: (row: UsageRow) => V,
  label: K,
): Array<{ [P in K]: V } & { totals: UsageTotals }> {
  const buckets = new Map<V, UsageRow[]>();
  for (const row of rows) {
    const id = key(row);
    const found = buckets.get(id);
    if (found) found.push(row);
    else buckets.set(id, [row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, group]) => ({ [label]: id, totals: sumUsageRows(group) })) as Array<
    { [P in K]: V } & { totals: UsageTotals }
  >;
}

/**
 * 行を5軸（日 / actor / モデル / 層 / 場所）へ畳む。
 *
 * **層と場所を「無い値は 0」で補わないこと。** `groupBy` は行に現れた値だけを
 * 返す。1件も記録が無い層・場所は一覧に出ない ＝ 「0 使った」ではなく「記録が
 * 無い」として読める形である（`usage.ts` の `usageLayerSchema` / `usageSiteSchema`）。
 */
export function summarizeUsage(rows: readonly UsageRow[]): UsageBreakdown {
  return {
    total: sumUsageRows(rows),
    byDate: groupBy(rows, (row) => row.date, 'date'),
    byManager: groupBy(rows, (row) => row.managerId, 'managerId'),
    byModel: groupBy(rows, (row) => row.model, 'model'),
    byLayer: groupBy(rows, (row) => row.layer, 'layer'),
    bySite: groupBy(rows, (row) => row.site, 'site'),
  };
}

/**
 * 金額の表示（USD）。**$1 未満は 4 桁**まで出す。
 *
 * 委譲1本の費用はふつう $1 を大きく下回るので、2 桁に丸めると `$0.00` になって
 * 「使っていない」と読める。**取れている数字を丸めて消さない。**
 */
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/**
 * ローカル時刻の `YYYY-MM-DD`。
 *
 * **UTC で切らない。** 日報（`ALTEROID_DAILY_REPORT_AT`）がローカル時刻で動くので、
 * ここを UTC にすると「今日いくら使ったか」と日報の「今日」がずれる。
 */
export function usageDate(at: Date): string {
  const y = at.getFullYear();
  const m = `${at.getMonth() + 1}`.padStart(2, '0');
  const d = `${at.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// アカウント全体の残り（claude.ai 側の値）
// ---------------------------------------------------------------------------

/**
 * 見出し。**面ごとに言い換えないこと** — 同じものを見ていると分かる必要がある。
 *
 * 「（claude.ai 側の値）」を落とさないのは、これが台帳（自分で数えた推定値）とは
 * 別物だからである。並べて置くので、どちらの数字かが題から読めないと足し合わせて
 * しまう。
 */
export const ACCOUNT_USAGE_TITLE = 'アカウント全体の残り（claude.ai 側の値）';

/** 残り時間を d/h/m で。過ぎていたら 0 に丸める（負の残り時間を見せない）。 */
function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((resetsAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `あと ${days}日${hours}時間`;
  if (hours > 0) return `あと ${hours}時間${minutes % 60}分`;
  return `あと ${minutes}分`;
}

/**
 * アカウント全体の残りを人間・クローンが読む行へ。**見出しは含めない。**
 *
 * **取れなかったことを 0 として出さない。** ここが一番嘘をつきやすい場所で、
 * 「枠 0%」と「枠が取れなかった」を同じ顔で見せると、読む側は残っていない枠を
 * 残っていると読む（あるいは逆）。状態ごとに文言を分けてある。
 *
 * **文言をここ1つに持つ理由。** この値を読む口は4つある（クローンの `usage_read` /
 * CLI の `alteroid usage` と `/usage` / Web の `/usage` 画面）。面ごとに書くと、
 * 「取れなかった」の言い方が面ごとに違い、**片方だけが 0 と描く**日が来る。
 * ここは4つの口が同じ事実を同じ言葉で言うための1箇所である。
 *
 * `emphasis` は Markdown の強調（`**`）を残すかどうか。読む先が Markdown を
 * 解釈しない面（端末・素のテキスト）では落とす。**落とすのは飾りだけで、
 * 文そのものは同じものが出る。**
 */
export function describeAccountUsage(
  state: AccountUsageState | undefined,
  { emphasis = true }: { emphasis?: boolean } = {},
): string[] {
  const plain = (line: string) => (emphasis ? line : line.replaceAll('**', ''));

  /*
   * **応答に入っていなかった場合を、状態の1つとして持つ。**
   *
   * `GET /usage` の spec では必須だが、**画面とデーモンは別々に配れる**
   * （`apps/web` は Vercel、宛先は `VITE_ALTEROID_API_URL` / 設定画面で決まる）。
   * だから「この項目を返さないデーモン」に繋がることは実際に起こりうる。
   *
   * ここで `unknown`（まだ取りに行っていない）へ寄せないこと — それは
   * **こちらが取りに行っていない**という別の事実で、嘘になる。落ちるのも駄目で、
   * 表示1枚のために画面全体が白くなる。
   */
  if (state === undefined) {
    return [
      plain(
        'この応答にアカウント全体の残りが入っていない（返さないデーモンに繋がっている）。' +
          '**0 ではなく、分からない。**',
      ),
    ];
  }

  if (state.state === 'unknown') {
    return [plain('まだ取りに行っていない（起動直後）。**0 ではなく、分からない。**')];
  }
  if (state.state === 'failed') {
    return [plain(`取れなかった: ${state.reason}（${state.at}）。**0 ではなく、分からない。**`)];
  }
  if (state.state === 'unavailable') {
    return [plain(`この構成では取れない: ${state.reason}（${state.at}）`)];
  }

  const { usage } = state;
  /*
   * **残り時間の基準は観測時刻である**（`Date.now()` ではない）。
   *
   * スナップショットは取った瞬間の値で、そこに書かれたリセット時刻との差が
   * 「あと何分」である。いまの時計から引くと、古いスナップショットほど残りが
   * 短く見え、**取り直していないことが「枠が尽きかけている」に化ける。**
   */
  const now = Date.parse(usage.at);
  const lines: string[] = [];

  lines.push(
    `プラン: ${usage.plan ?? '（取れなかった）'}` +
      (usage.organization === undefined ? '' : ` / 組織: ${usage.organization}`),
  );

  if (usage.windows.length === 0) {
    // **`limitsAvailable` が真でも枠が来ないことがある**（実測）。0% と描かない。
    lines.push(plain('枠: 取れなかった（向こうが枠を返さなかった。**0% ではない**）'));
  } else {
    lines.push('枠:');
    for (const window of usage.windows) {
      const used =
        // **付かなかった利用率を 0% と書かない。**
        window.utilization === undefined ? '使用率は取れなかった' : `${window.utilization}% 使用`;
      const reset =
        window.resetsAt === undefined ? '' : ` / ${untilReset(window.resetsAt, now)}でリセット`;
      lines.push(`  ${window.kind}: ${used}${reset}`);
    }
  }

  const extra = usage.extraUsage;
  if (extra === undefined) {
    // これが取れれば「上限に当たる前に気づく」が完成する。取れないなら、そう言う。
    lines.push(plain('支出上限: 取れなかった（**0 ではない**。この情報が無いと残額は分からない）'));
  } else if (!extra.enabled) {
    lines.push('支出上限: 設定されていない');
  } else {
    // **通貨が分からないときは金額として整形しない**（`$` を付けて嘘の単位を名乗らない）。
    const unit = extra.currency;
    const amount = (value: number | undefined) =>
      value === undefined
        ? '取れなかった'
        : unit === undefined
          ? `${value}（単位不明）`
          : `${value} ${unit}`;
    lines.push(
      `支出上限: ${amount(extra.usedCredits)} / ${amount(extra.monthlyLimit)}` +
        (extra.utilization === undefined ? '' : `（${extra.utilization}% 使用）`),
    );
  }
  lines.push(`観測時刻: ${usage.at}`);
  return lines;
}
