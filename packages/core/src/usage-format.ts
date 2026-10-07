import type { JobStatus } from './schema.js';
import type {
  AccountApiKeySource,
  AccountUsageState,
  TokenSourcePresence,
} from './usage-snapshot.js';
import type {
  UsageBreakdown,
  UsageRow,
  UsageTotals,
  UsageTurnRow,
  UsageUnmeteredRow,
} from './usage.js';

// このファイルは実行時の依存を持たない: index 経由で読ませると core 全体（gzip 約 300KB）がダッシュボードの初期チャンクへ入るため。算術は書き写さず軽い口から出す: 口ごとに足し直すと金額がずれるため
export const CLONE_ACTOR_ID = 'clone';

// 接頭辞（`mgr-`）で見分けない: 接頭辞は発行側の既定にすぎず、差し替えれば `mgr-` で始まらない id が委譲に付くため
// 空文字は委譲にしない: 弾かないと `/managers/` への空のリンクが出るため
export function isDelegationActorId(managerId: string): boolean {
  return managerId !== '' && managerId !== CLONE_ACTOR_ID;
}

// 値の並びをここへ置く: ブラウザが読めるのがこのファイルだけで、画面側に書き写すと値が増えたときそこだけ古くなるため
export const USAGE_LAYERS = ['clone', 'manager'] as const;
export const USAGE_SITES = ['session', 'distill', 'peer'] as const;

export const USAGE_UNREADABLE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUsd',
] as const;

export type UsageUnreadableField = (typeof USAGE_UNREADABLE_FIELDS)[number];

export type UsageUnreadableCounts = Partial<Record<UsageUnreadableField, number>>;

const USAGE_UNREADABLE_FIELD_LABELS: ReadonlyArray<readonly [UsageUnreadableField, string]> = [
  ['inputTokens', '入力'],
  ['outputTokens', '出力'],
  ['cacheReadInputTokens', 'キャッシュ読み'],
  ['cacheCreationInputTokens', 'キャッシュ書き'],
  ['webSearchRequests', 'Web検索'],
  ['costUsd', '費用'],
];

// fs と Web を含む口の両方がここを直接呼ぶ: 別々に書くと、どちらかが欄が無いときの 0 を書き忘れて `NaN` を積むため
export function addUnreadableCounts(
  a: UsageUnreadableCounts | undefined,
  b: UsageUnreadableCounts | undefined,
): UsageUnreadableCounts | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: UsageUnreadableCounts = {};
  for (const field of USAGE_UNREADABLE_FIELDS) {
    const sum = (a?.[field] ?? 0) + (b?.[field] ?? 0);
    if (sum > 0) merged[field] = sum;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// どの口でも落とさない: 台帳に積んだ値を確定として見せると黙って嘘をつくため
// SDK の型コメントが「An estimate, not a billing statement」と明記している。 [sdk-verbatim SDKResultSuccess.total_cost_usd]
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

export function sumUsageRows(rows: readonly UsageRow[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (sum, row) => {
      const unreadable = addUnreadableCounts(sum.unreadable, row.totals.unreadable);
      return {
        inputTokens: sum.inputTokens + row.totals.inputTokens,
        outputTokens: sum.outputTokens + row.totals.outputTokens,
        cacheReadInputTokens: sum.cacheReadInputTokens + row.totals.cacheReadInputTokens,
        cacheCreationInputTokens:
          sum.cacheCreationInputTokens + row.totals.cacheCreationInputTokens,
        webSearchRequests: sum.webSearchRequests + row.totals.webSearchRequests,
        costUsd: sum.costUsd + row.totals.costUsd,
        ...(unreadable === undefined ? {} : { unreadable }),
      };
    },
    { ...ZERO_USAGE },
  );
}

// `V` を常に `string` へ広げない: byLayer / bySite は union 型を保つ必要があり、広げると `usageBreakdownSchema` の型と合わなくなるため
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

// `groupBy` を使わない: tokenId が無い行を空文字へ倒すと、取れていない分が名前の無いトークンで使った分に化けるため
// `null` を最後に並べる: 取れていない分を先頭に置くと、いちばん目に入る位置が「分からない」で埋まるため
function groupByToken(
  rows: readonly UsageRow[],
): Array<{ tokenId: string | null; totals: UsageTotals }> {
  const buckets = new Map<string | null, UsageRow[]>();
  for (const row of rows) {
    const id = row.tokenId ?? null;
    const found = buckets.get(id);
    if (found) found.push(row);
    else buckets.set(id, [row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([tokenId, group]) => ({ tokenId, totals: sumUsageRows(group) }));
}

function groupTurnsBy<V>(
  rows: readonly UsageTurnRow[],
  key: (row: UsageTurnRow) => V,
): Map<V, number> {
  const totals = new Map<V, number>();
  for (const row of rows) {
    totals.set(key(row), (totals.get(key(row)) ?? 0) + row.turns);
  }
  return totals;
}

function groupTurnsByToken(rows: readonly UsageTurnRow[]): Map<string | null, number> {
  return groupTurnsBy(rows, (row) => row.tokenId ?? null);
}

// 鍵が turns 側に無ければ `turns` を付けない: 0 を足さない
function withTurns<T extends { totals: UsageTotals }, K>(
  entry: T,
  key: K,
  turnsByKey: Map<K, number>,
): T & { turns?: number } {
  const turns = turnsByKey.get(key);
  return turns === undefined ? entry : { ...entry, turns };
}

// 層と場所を「無い値は 0」で補わない: 記録が無いと 0 使ったを区別できる形にするため
// トークンの軸だけ `null` の要素を出す: 構成によって取れない分を落とすと合計に足し合わなくなるため
// `byModel` に `turns` を付けない: turnRow が `model` を鍵に持たず、回数を帰属させる先が無いため
// `turnRows` に既定値を持たせない: 呼ぶ側が毎回回数をどう畳むかを言う形にするため
export function summarizeUsage(
  rows: readonly UsageRow[],
  turnRows: readonly UsageTurnRow[],
): UsageBreakdown {
  const totalTurns = turnRows.reduce((sum, row) => sum + row.turns, 0);
  const turnsByDate = groupTurnsBy(turnRows, (row) => row.date);
  const turnsByManager = groupTurnsBy(turnRows, (row) => row.managerId);
  const turnsByLayer = groupTurnsBy(turnRows, (row) => row.layer);
  const turnsBySite = groupTurnsBy(turnRows, (row) => row.site);
  const turnsByToken = groupTurnsByToken(turnRows);

  return {
    total: sumUsageRows(rows),
    ...(totalTurns > 0 ? { turns: totalTurns } : {}),
    byDate: groupBy(rows, (row) => row.date, 'date').map((entry) =>
      withTurns(entry, entry.date, turnsByDate),
    ),
    byManager: groupBy(rows, (row) => row.managerId, 'managerId').map((entry) =>
      withTurns(entry, entry.managerId, turnsByManager),
    ),
    byModel: groupBy(rows, (row) => row.model, 'model'),
    byLayer: groupBy(rows, (row) => row.layer, 'layer').map((entry) =>
      withTurns(entry, entry.layer, turnsByLayer),
    ),
    bySite: groupBy(rows, (row) => row.site, 'site').map((entry) =>
      withTurns(entry, entry.site, turnsBySite),
    ),
    byToken: groupByToken(rows).map((entry) => withTurns(entry, entry.tokenId, turnsByToken)),
  };
}

// 0 のときは空文字を返す: 取れない軸に 0 の行を作らない
// 「費用は合計に含む」を同じ断片に入れる: 分けて注記すると断り書きが数字から離れた場所に置かれ、読み手に届かないため
export function describeWebSearchRequests(totals: UsageTotals): string {
  if (totals.webSearchRequests === 0) return '';
  return ` / Web検索 ${totals.webSearchRequests.toLocaleString('en-US')}回（費用は合計に含む）`;
}

export function describeUnreadableUsage(totals: UsageTotals): string[] {
  const counts = totals.unreadable;
  if (counts === undefined) return [];
  const parts = USAGE_UNREADABLE_FIELD_LABELS.filter(([field]) => (counts[field] ?? 0) > 0).map(
    ([field, label]) => `${label} ${(counts[field] ?? 0).toLocaleString('en-US')}回`,
  );
  if (parts.length === 0) return [];
  return [
    `⚠ 一部の区切りで SDK から値が取れなかった（0 ではなく取れなかった。取れなかった数: ${parts.join(' / ')}）。`,
  ];
}

// `UsageTotals.unreadable` と1つに畳まない: 0 を書いた行と行が無いという別の意味が消えるため
export interface UnreadableUsageRow {
  table: 'usage_daily' | 'usage_turns';
  date?: string;
  fields: string[];
}

const UNREADABLE_USAGE_ROWS_DATE_LIMIT = 5;

// 外した行の値は足さない・推測もしない: 読めないので幾つ少ないかは言えない
export function describeUnreadableUsageRows(
  rows: readonly UnreadableUsageRow[] | undefined,
): string[] {
  if (rows === undefined || rows.length === 0) return [];
  const daily = rows.filter((row) => row.table === 'usage_daily').length;
  const turns = rows.filter((row) => row.table === 'usage_turns').length;
  const breakdown = [
    ...(daily > 0 ? [`消費量の行 ${daily} 行`] : []),
    ...(turns > 0 ? [`回数の行 ${turns} 行`] : []),
  ].join(' / ');
  const dates = [
    ...new Set(rows.flatMap((row) => (row.date === undefined ? [] : [row.date]))),
  ].sort();
  const shown = dates.slice(0, UNREADABLE_USAGE_ROWS_DATE_LIMIT).join(', ');
  const rest = dates.length - UNREADABLE_USAGE_ROWS_DATE_LIMIT;
  const datePart =
    dates.length === 0 ? '' : `。日付: ${shown}${rest > 0 ? ` ほか ${rest} 日` : ''}`;
  return [
    `⚠ 読めない使用量の行が ${rows.length} 行あり、合計に入っていない` +
      `（読めない行の値は足していない。合計はその分少ない。内訳: ${breakdown}${datePart}）。`,
  ];
}

export function describeUnmeteredUsage(rows: readonly UsageUnmeteredRow[] | undefined): string[] {
  if (rows === undefined || rows.length === 0) return [];
  const byKey = new Map<string, { provider: string; layer: string; turns: number }>();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.layer}`;
    const entry = byKey.get(key) ?? { provider: row.provider, layer: row.layer, turns: 0 };
    entry.turns += row.turns;
    byKey.set(key, entry);
  }
  const parts = [...byKey.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.layer.localeCompare(b.layer))
    .map((e) => `${e.provider}・${e.layer}層 ${e.turns.toLocaleString('en-US')}ターン`);
  return [
    `⚠ 消費を報告しない provider のターンがある（0 ではなく取れなかった。合計に含まれない: ${parts.join(' / ')}）。`,
  ];
}

// $1 未満は 4 桁まで出す: 2 桁に丸めると `$0.00` になり「使っていない」と読めるため
export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

// UTC で切らない: 日報がローカル時刻で動くので、UTC にすると「今日いくら使ったか」と日報の「今日」がずれるため
// 読む側は日付を作り直さない（畳むだけ）: 書きと読みで暦が食い違う経路を作らない（`grep -Fn -- 'byDate: groupBy(rows, (row) => row.date,' packages/core/src/usage-format.ts`）
export function usageDate(at: Date): string {
  const y = at.getFullYear();
  const m = `${at.getMonth() + 1}`.padStart(2, '0');
  const d = `${at.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// zod を持ち込まない: ブラウザ向けの軽い口から出ており、画面が書き写しを持たずに済むため
export const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 実在まで見る: 集計は日付を文字列で大小比較するだけで、実在しない日を渡すと黙って範囲として扱われ、入力欄は空なのに絞り込みが効く形になるため
// `new Date(…)` に判定を預けない: 時間帯・年の範囲の解釈に左右されるため
export function isRealUsageDate(value: string): boolean {
  if (!USAGE_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= daysInMonth;
}

export function describeUsageDateOrder(
  from: string | undefined,
  to: string | undefined,
): string | null {
  if (from === undefined || to === undefined) return null;
  if (to >= from) return null;
  return `to（${to}）が from（${from}）より前なので、この範囲には1日も入らない`;
}

// 「（claude.ai 側の値）」を落とさない: 台帳（自分で数えた推定値）とは別物で、題から読めないと足し合わせてしまうため
export const ACCOUNT_USAGE_TITLE = 'アカウント全体の残り（claude.ai 側の値）';

// 過ぎていたら 0 に丸める: 負の残り時間を見せない
function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((resetsAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `あと ${days}日${hours}時間`;
  if (hours > 0) return `あと ${hours}時間${minutes % 60}分`;
  return `あと ${minutes}分`;
}

// ok と unavailable の両方から呼ぶ: 2箇所で同じ文言を手で揃えると片方が古くなるため
function describeApiKeySource(apiKeySource: AccountApiKeySource | undefined): string {
  return (
    `認証の出所（apiKeySource。判定には使っていない観測）: ${apiKeySource ?? '（取れなかった）'}` +
    (apiKeySource === 'none'
      ? '（API キーを使っていないという意味。claude.ai の OAuth ログイン等。「ログインしていない」ではない）'
      : '')
  );
}

// 4つの状態を別の文言にする: 「取れなかった」（試して駄目）と「この版は送らない」（誰も試していない）は意味が正反対で、混同すると繋ぎ直せば直るのか鍵が届くのを待つのかを読み違えるため
function describeTokenSourcePresence(presence: TokenSourcePresence | undefined): string {
  switch (presence) {
    case undefined:
      return '鍵の届き具合（tokenSource）: この版はこの情報を出さない（daemon が未対応）';
    case 'not_returned':
      return '鍵の届き具合（tokenSource）: 取得できず（SDK がこの欄を返さなかった）';
    case 'empty':
      return '鍵の届き具合（tokenSource）: 欄はあるが空（SDK が空文字を返した）';
    case 'present':
      return '鍵の届き具合（tokenSource）: 値が届いている（内容はここに出さない）';
  }
}

// `?? '（取れなかった）'` にしない: `''` は nullish ではないので既定値が出ず空白が出る。欄が無いと空を別の文言にする
// `undefined` を「この版は出さない」と名乗らない: SDK が返さなかったと旧い daemon が送らなかったの両方から来て断定できないため
function describeAccountText(value: string | undefined): string {
  if (value === undefined) return '（取れなかった）';
  return value.trim().length === 0 ? '（欄はあるが空）' : value;
}

// 取れなかったことを 0 として出さない: 「枠 0%」と「枠が取れなかった」を同じ顔で見せると、読む側が残っていない枠を残っていると読むため
export function describeAccountUsage(
  state: AccountUsageState | undefined,
  { emphasis = true }: { emphasis?: boolean } = {},
): string[] {
  const plain = (line: string) => (emphasis ? line : line.replaceAll('**', ''));

  // `unknown`（まだ取りに行っていない）へ寄せない: 別の事実で嘘になるため。落ちない: 表示1枚のために画面全体が白くなるため
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
    // 「この構成では取れない」と名乗らない: 断定できていない道があり、ここで断定すると `reason` の「言い分けられない」と食い違うため。断定は `reason` の側に任せる
    return [
      plain(`枠が返ってこない: ${state.reason}（${state.at}）`),
      describeApiKeySource(state.apiKeySource),
      plain(
        state.accountKeys === undefined
          ? 'accountInfo の応答: 無かった（欄の名前も取れていない）'
          : `accountInfo の応答が持っていた欄（名前だけ）: ${
              state.accountKeys.length === 0 ? '（1つも無い）' : state.accountKeys.join(', ')
            }`,
      ),
    ];
  }

  const { usage } = state;
  // 残り時間の基準を `Date.now()` にしない: 古いスナップショットほど残りが短く見え、取り直していないことが「枠が尽きかけている」に化けるため
  const now = Date.parse(usage.at);
  const lines: string[] = [];

  lines.push(
    `プラン: ${describeAccountText(usage.plan)}` +
      (usage.organization === undefined
        ? ''
        : ` / 組織: ${describeAccountText(usage.organization)}`),
  );

  lines.push(describeApiKeySource(usage.apiKeySource));
  lines.push(describeTokenSourcePresence(usage.tokenSourcePresence));

  if (usage.windows.length === 0) {
    // 0% と描かない: `limitsAvailable` が真でも枠が来ないことがあるため
    lines.push(plain('枠: 取れなかった（向こうが枠を返さなかった。**0% ではない**）'));
  } else {
    lines.push('枠:');
    for (const window of usage.windows) {
      const used =
        window.utilization === undefined ? '使用率は取れなかった' : `${window.utilization}% 使用`;
      const reset =
        window.resetsAt === undefined ? '' : ` / ${untilReset(window.resetsAt, now)}でリセット`;
      lines.push(`  ${window.kind}: ${used}${reset}`);
    }
  }

  const extra = usage.extraUsage;
  if (extra === undefined) {
    lines.push(plain('支出上限: 取れなかった（**0 ではない**。この情報が無いと残額は分からない）'));
  } else if (!extra.enabled) {
    lines.push('支出上限: 設定されていない');
  } else {
    // 通貨が分からないときは金額として整形しない: `$` を付けて嘘の単位を名乗らないため
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
  if (state.refreshFailure !== undefined) {
    lines.push(
      plain(
        `**⚠️ 上の値は最後に取れたときのもの。${state.refreshFailure.since} から取り直しが失敗している` +
          `（直近 ${state.refreshFailure.at}: ${state.refreshFailure.reason}）。いまの枠は分からない。**`,
      ),
    );
  }
  return lines;
}

// `ManagerSummary` をそのまま import しない: `manager.ts` が `usage.ts` を値として import しており、値として読み返すと循環になるため。判定に要る3つのフィールドだけを書き写す
export interface UnrecordedManagerCandidate {
  managerId: string;
  // `status` で絞り込まない: 判定は「台帳に1行も無いか」の1つだけで、ここは `[running]` のような注記を添えるためだけにある
  status: JobStatus;
  startedAt: string;
}

export type UnrecordedManager = UnrecordedManagerCandidate;

// `recordedManagerIds` は全期間・絞り込み無しで渡す: `aggregate()` の rows から作ると、照会範囲の外で記録された委譲が「記録が無い」に化けるため
export function findUnrecordedManagers(
  managers: readonly UnrecordedManagerCandidate[],
  recordedManagerIds: ReadonlySet<string>,
  since: string | null,
): UnrecordedManager[] {
  const cutoff = since === null ? null : Date.parse(since);
  return (
    managers
      .filter((manager) => !recordedManagerIds.has(manager.managerId))
      .filter((manager) => cutoff === null || Date.parse(manager.startedAt) >= cutoff)
      // 3フィールドへ写す（フィルタしただけで返さない）: `.parse()` を通さない口では `ManagerSummary` 丸ごとが黙って外へ出るため
      .map((manager) => ({
        managerId: manager.managerId,
        status: manager.status,
        startedAt: manager.startedAt,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  );
}

// 0件のときも黙らない: 空配列は「取りこぼしが無い」であって「調べていない」ではないと読める形で、必ず1行返す
export function describeUnrecordedManagers(unrecorded: readonly UnrecordedManager[]): string[] {
  if (unrecorded.length === 0) {
    return [
      '台帳に1行も記録が無い委譲: 0件（台帳が始まってから立った委譲は、' +
        '全部台帳に最低1行ある。照会の期間では絞っていない）。',
    ];
  }
  const lines = [
    `⚠ 台帳に1行も記録が無い委譲: ${unrecorded.length}件。上の合計にはまだ入っていない。`,
  ];
  for (const manager of unrecorded) {
    lines.push(`  ${manager.managerId} [${manager.status}]（起こした時刻: ${manager.startedAt}）`);
  }
  return lines;
}
