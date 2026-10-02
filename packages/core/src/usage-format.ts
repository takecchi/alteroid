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

/**
 * 台帳でクローンを名指す actor の id。
 *
 * **ブラウザが読めるようにこのファイルに置く**（`usage.ts` から再輸出している。
 * 画面が `mgr-` の接頭辞で委譲かどうかを見分けていたのを、この値との比較へ寄せるため —
 * Issue #2269）。
 *
 * 台帳の actor 列は `managerId` という名前のままである（既存の行・API・CLI・
 * 画面が読んでいる名前を変えるのは別の作業になる）。**名前はマネージャーの
 * ものだが、意味は「誰の分か」の一般名である** — どの層の分かは `layer` が言う。
 *
 * マネージャーの id は `mgr-` に続けて発行される（`manager.ts`）ので、この値
 * （接頭辞を持たない）とは衝突しない。**衝突しないことは偶然ではなく、
 * テストで固定してある。** ただしこれが固定しているのは `mgr-` 名前空間と
 * この値が衝突しないことだけである — `mgr-` 名前空間の内部の一意性は
 * `manager.ts` の `#claimManagerId` の doc が持つ（#238）。
 */
export const CLONE_ACTOR_ID = 'clone';

/**
 * 台帳・日誌の `managerId`（「誰の分か」の一般名）が、**委譲（マネージャー）の id か**。
 *
 * **接頭辞（`mgr-`）で見分けない**（Issue #2269）。接頭辞は発行側の既定
 * （`manager.ts` の `#generateManagerId`）にすぎず、差し替えれば `mgr-` で始まらない id が
 * 委譲に付く。クローンの分は {@link CLONE_ACTOR_ID} に決まっているので、それ以外を
 * 委譲として扱う。画面（日誌のリンク・使用量の「マネージャー別」）はこの1つの関数を共有する。
 *
 * **空文字は委譲にしない。** 基準値の `managerId` は「呼び出し側が後から入れる」契約で、
 * 入れる前は `''` である（`usage.ts` の `baseline?.managerId ?? ''`）。接頭辞で見ていた頃は
 * 空文字を弾けていたので、ここでも弾く（弾かないと `/managers/` への空のリンクが出る）。
 */
export function isDelegationActorId(managerId: string): boolean {
  return managerId !== '' && managerId !== CLONE_ACTOR_ID;
}

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
 * {@link UsageTotals} の欄のうち「読めなかった区切りの数」を持ちうるもの
 * （Issue #2086）。**`USAGE_LAYERS` / `USAGE_SITES` と同じ理由でここに置く**
 * ——ブラウザ（`apps/web`）が読めるのはこのファイルだけなので、`usage.ts` の
 * zod schema はここから作り、画面側はここだけを読めばよい。
 */
export const USAGE_UNREADABLE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'webSearchRequests',
  'costUsd',
] as const;

export type UsageUnreadableField = (typeof USAGE_UNREADABLE_FIELDS)[number];

/**
 * 欄ごとの「読めなかった区切りの数」。**欄が無いのは「その欄を数えていない」で
 * あって 0 ではない**（`usage.ts` の `usageTotalsSchema.unreadable` の doc）。
 */
export type UsageUnreadableCounts = Partial<Record<UsageUnreadableField, number>>;

/** 表示用の日本語ラベル（`describeUnreadableUsage` と、既存の合計行の並びに揃える）。 */
const USAGE_UNREADABLE_FIELD_LABELS: ReadonlyArray<readonly [UsageUnreadableField, string]> = [
  ['inputTokens', '入力'],
  ['outputTokens', '出力'],
  ['cacheReadInputTokens', 'キャッシュ読み'],
  ['cacheCreationInputTokens', 'キャッシュ書き'],
  ['webSearchRequests', 'Web検索'],
  ['costUsd', '費用'],
];

/**
 * 2つの「読めなかった数」を欄ごとに足す。**片方（または両方）が `undefined` でも
 * 0 として扱う**——欄が無いのは「まだ数えていない」であって 0 ではないという
 * 区別は、`UsageTotals.unreadable` という欄そのものの有無が持つ（`usage.ts` の
 * doc）。ここで足し合わせた**結果**が全欄 0 なら `undefined` を返す——「読めな
 * かった区切りが無い」を、値を作らずに表す。
 *
 * **fs（`storage-fs` の `addTotals`）と Web を含む口（`sumUsageRows`）の両方が
 * ここを直接呼ぶ。** 別々に書くと、どちらかが「欄が無ければ 0」を書き忘れて
 * `NaN` を積む事故になる。
 */
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
 * SDK の型コメントが「An estimate, not a billing statement」と明記している。 [sdk-verbatim SDKResultSuccess.total_cost_usd]
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
 * 認証トークンの軸だけ別に畳む。**`groupBy` を使えないのは `null` を保つためである。**
 *
 * あちらは `V extends string` で鍵を作る（`Map` の鍵にも並べ替えにも文字列を要る）
 * ので、`tokenId` が無い行を通せない。**通すために空文字へ倒すと、それが1つの
 * トークン id として並ぶ** — 取れていない分が「名前の無いトークンで使った分」に
 * 化ける。だから鍵の型を `string | null` のまま持つ小さな畳み込みをここに置く。
 *
 * **並びは id の昇順で、`null` は最後。** 取れていない分を先頭に置くと、いちばん
 * 目に入る位置が「分からない」で埋まる（他の軸と読み口が揃わなくなる）。
 */
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

/**
 * turnRow を軸ごとに畳んで、回数だけの合計を取る（`Map` の値は必ず正——
 * {@link usageTurnRowSchema} の `turns` が `positive()` で、0 の行を作らない
 * ことを前提にできる。だから「その鍵が Map に無い」と「0回だった」を区別
 * できる形のまま呼び出し側へ渡せる）。
 */
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

/**
 * トークンの軸だけ `groupTurnsBy` を使えない理由は `groupByToken` と同じ —
 * `tokenId` が無い turnRow を `string | null` の鍵のまま持つためである。
 */
function groupTurnsByToken(rows: readonly UsageTurnRow[]): Map<string | null, number> {
  return groupTurnsBy(rows, (row) => row.tokenId ?? null);
}

/**
 * 費用側の要素（`groupBy` / `groupByToken` の1要素）に、対応する回数を足す。
 *
 * **鍵が turns 側に無ければ `turns` を付けない**（`0` を足さない——AGENTS.md
 * 地雷表「取れない軸に 0 の行を作る」と同じ理由）。turnRow の鍵は必ず費用行の
 * 鍵に射影されるので（{@link summarizeUsage} の doc）、ここで見つからないのは
 * 「その組み合わせでは1件も数えられる形で起きていない」ときだけである。
 */
function withTurns<T extends { totals: UsageTotals }, K>(
  entry: T,
  key: K,
  turnsByKey: Map<K, number>,
): T & { turns?: number } {
  const turns = turnsByKey.get(key);
  return turns === undefined ? entry : { ...entry, turns };
}

/**
 * 行を6軸（日 / actor / モデル / 層 / 場所 / 認証トークン）へ畳む。
 *
 * **層と場所を「無い値は 0」で補わないこと。** `groupBy` は行に現れた値だけを
 * 返す。1件も記録が無い層・場所は一覧に出ない ＝ 「0 使った」ではなく「記録が
 * 無い」として読める形である（`usage.ts` の `usageLayerSchema` / `usageSiteSchema`）。
 *
 * **トークンの軸だけは `null` の要素が出る**（`groupByToken`）。他の5軸は行が必ず
 * 値を持つが、この軸は**構成によってそもそも取れない**ので、「取れていない分」を
 * 落とすと合計に足し合わなくなる。落とさずに `null` として出す。
 *
 * ## `turnRows`（第2引数）は必須である
 *
 * 既定値を持たせない——呼ぶ側が毎回「回数をどう畳むか」を言う形にする
 * （`PgUsageStore.record` の `accumulation` と同じ作法。AGENTS.md）。
 *
 * **不変条件: 数えられた turnRow の鍵（日・actor・層・場所・トークン）は必ず
 * 費用行（`rows`）の鍵に射影される。** 回数は「台帳の行が動いた回
 * （`fold.delta` が空でない回）」でだけ数えるので、回数が在って対応する費用行が
 * 無い組み合わせは作られない。呼び出し側（`UsageStore.aggregate`）は `rows` と
 * `turnRows` を同じ述語（`from` / `to` / `managerId` / `layer` / `site` /
 * `tokenId`）で絞るので、照会後もこの関係は保たれる。
 *
 * **ルートの `turns` は turnRows の総和。0 なら欄を出さない**（他の軸と同じ理由）。
 * **`byModel` には `turns` を付けない** — turnRow が `model` を鍵に持たないので、
 * モデル軸へ回数を帰属させる先が無い（`usageTurnRowSchema` の doc）。
 */
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

/**
 * Web 検索の回数（`webSearchRequests`。Issue #1950）を、合計の内訳行に添える断片。
 *
 * **0 のときは空文字を返す。1文字も増やさない**（AGENTS.md 地雷表「取れない軸に
 * 0 の行を作る」）。0 より大きい合計にだけ「Web検索 N回」を添える。
 *
 * **合計行にだけ添え、軸ごとの内訳（日別・マネージャー別・モデル別…）には
 * 添えない。** 3面（CLI・Web・`usage_read`）とも、軸ごとの内訳はもともと
 * `costUsd` だけを出し、トークンの内訳（入力・出力・キャッシュ）も合計行にしか
 * 出していない——既存のこの出し方に揃える。ここだけ軸ごとに足すと、
 * トークン欄には無い区別を Web 検索欄にだけ作ることになる。
 *
 * **費用（`costUsd`）には既にこの回数分の費用が入っている。** 別に加算される
 * ものだと誤読されないよう、同じ断片の中に「費用は合計に含む」を入れて
 * 一体で出す——分けて注記すると、断り書きが実際の数字から離れた場所に置かれ、
 * 読み手に届かないことがある（AGENTS.md「報告の形」の、断り書きを添えるだけ
 * では効かないという注意と同じ理由）。
 *
 * **3面が同じ文言をここから直接呼ぶ。** 個別に書くと、いつか片方だけ言い回しが
 * ずれる（`describeAccountUsage` と同じ設計）。
 */
export function describeWebSearchRequests(totals: UsageTotals): string {
  if (totals.webSearchRequests === 0) return '';
  return ` / Web検索 ${totals.webSearchRequests.toLocaleString('en-US')}回（費用は合計に含む）`;
}

/**
 * SDK から値が取れなかった区切りが在ることを、値を作らず理由として1行にする
 * （Issue #2086）。「0」と「取れなかった」を同じ顔で見せない
 * （AGENTS.md 地雷表「取れない軸に0の行を作る」の「代わりに」の列）。
 *
 * **取れなかった区切りが1つも無ければ空配列。** 既存の出力を1文字も変えない
 * ——`totals.unreadable` が無い（欄そのものを数えていない）ときも、数えた
 * 結果が全欄 0 のときも、同じくここで空配列になる。
 *
 * **3面（CLI・Web・`usage_read`）が同じ文言をここから直接呼ぶ**
 * （`describeWebSearchRequests` と同じ設計）。
 */
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

/**
 * 集計で読めずに外した台帳の行（Issue #2427）。**本文（値）は持たない**——どの表の、
 * どの日の行か（日が取れたときだけ）と、どの欄が読めなかったかの名前だけ。
 *
 * **`UsageTotals.unreadable`（上の `describeUnreadableUsage`）とは別物である。** あちらは
 * 「読めた行の中で、SDK から値が取れなかった欄の数」で、値は行に 0 で入っている。
 * こちらは「行そのものが読めず、合計に足していない」——足されていない値がある、という
 * 断りであって、欄の数ではない。1つに畳むと、片方の意味（0 を書いた行 / 行が無い）が
 * 消える。
 *
 * `table` は pg の表名で言う（fs の `rows` / `turns` も同じ意味の行）。
 */
export interface UnreadableUsageRow {
  table: 'usage_daily' | 'usage_turns';
  /** 行の日（`YYYY-MM-DD`）。読めた（暦に実在する）ときだけ。 */
  date?: string;
  /** 読めなかった欄の名前（値は含まない）。 */
  fields: string[];
}

/** 日付を並べる上限（文が長くならないように。超えた分は「ほか N 日」と数で言う）。 */
const UNREADABLE_USAGE_ROWS_DATE_LIMIT = 5;

/**
 * 集計で読めずに外した行が在ることを、合計に入っていないと言う1文にする（Issue #2427）。
 *
 * **0件・欄なしのときは空配列**——「読めない行は 0 行」という行を作らない
 * （AGENTS.md 地雷表「取れない軸に0の行を作る」）。欄が無い（古いデーモンの応答）と
 * 0 件は、どちらも何も言わない代わりに、`undefined` を件数として書かない
 * （`undefined !== 0` が真になる #2382 の形を踏まない）。
 *
 * **外した行の値は足さない・推測もしない。** 文は「その分、合計は少ない」と言うだけで、
 * 幾つ少ないかは言えない（読めないので）。
 *
 * **CLI・Web・`usage_read` が同じ文言をここから直接呼ぶ**（`describeUnreadableUsage` と同じ設計）。
 */
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

/**
 * 消費を報告しない provider のターンが在ることを、0 ではなく「取れなかった」として
 * 1文にする（Issue #486 M7）。provider・層ごとにターン数を言う。
 *
 * **0件・欄なしのときは空配列**（Claude だけの器の出力を1文字も変えない。
 * `describeUnreadableUsageRows` と同じ形）。**合計には足していない**と文中で言う。
 *
 * **CLI・Web・`usage_read` が同じ文言をここから直接呼ぶ**（`usage_read` は
 * `describeUnreadableUsage` の隣から1行で呼べる）。
 */
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
 *
 * ## ⚠️ 「ローカル」が本番で何になるか（読み手が日を比べるときに要る）
 *
 * **プロセスの `TZ` である。本番の既定は `Asia/Tokyo`** —— `railway/setup.sh` が
 * `TZ` を `shared_pairs` に入れ、それが app（台帳へ書くデーモン）の変数にも入る
 * （`grep -Fn -- 'TZ "$TZ_VALUE"' railway/setup.sh` と
 * `grep -Fn -- 'app_pairs=("${shared_pairs[@]}"' railway/setup.sh`）。
 * `compose.yaml` も同じ既定である（`grep -Fn -- 'TZ: ${TZ:-Asia/Tokyo}' compose.yaml`）。
 * **⚠️ `TZ` を明示しないで動かすと UTC 日になる**（`railway/README.md` の
 * 「日報が想定と違う時刻に出る」の行が同じ落ち方を記録している）。
 *
 * **⟹ 日別の合計を外の暦と比べるときは、まずどちらの暦かを決めること。**
 * 実害の形: JST 12:00 に「今日」を読むと、JST 日なら12時間ぶん・UTC 日なら3時間ぶん
 * を見ていることになり、**同じ数字が4倍ずれて読める。**
 *
 * **書く側と読む側は同じ関数を通る**（書くのは `clone.ts` と `manager.ts` の
 * `date: usageDate(at)` の2箇所だけ。読む側は畳むだけで日付を作り直さない —
 * `grep -Fn -- 'byDate: groupBy(rows, (row) => row.date,' packages/core/src/usage-format.ts`）
 * ので、**書きと読みで暦が食い違う経路は無い。**
 */
export function usageDate(at: Date): string {
  const y = at.getFullYear();
  const m = `${at.getMonth() + 1}`.padStart(2, '0');
  const d = `${at.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 使用量の日付（`YYYY-MM-DD`）の**形**。`usageDateSchema`（`usage.ts`）の正規表現の正本
 * （Issue #2156）。
 *
 * **zod を持ち込まない形でここに置く。** このファイルはブラウザ向けの軽い口
 * （`@alteroid/core/usage`）から出ている。画面（`apps/web`）は `@alteroid/core`（バレル）を
 * 値として import できないので、正規表現と {@link isRealUsageDate} をここから読めば、
 * 画面が書き写しを持たずに済む（寄せる作業は領域 E が持つ。#2156 の申し送り）。
 */
export const USAGE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 使用量の日付として受け取ってよいか（Issue #2156）。**形（{@link USAGE_DATE_PATTERN}）に
 * 合い、かつ暦の上に実在する日**のときだけ真。`2026-02-30` / `2026-13-01` / `2026-00-00` は偽。
 *
 * ## なぜ実在まで見るか
 *
 * 集計（fs / pg の `aggregate`）は日付を文字列として大小で比べるだけなので、実在しない日を
 * 渡しても例外にならない。黙って「その日までの範囲」として扱われる（`2026-02-30` は
 * `2026-02-28` と `2026-03-01` のあいだの文字列として比べられる）。画面は `type="date"` の
 * 入力欄が実在しない日を空欄に落とすので、素通しすると「入力欄は空なのに絞り込みが効いている」
 * になる（#2133）。⟹ 画面とデーモンの両方で、同じ関数で弾く。
 *
 * **zod も `Date` の時間帯も持ち込まない。** 年・月・日を数として読み、月の日数（閏年を含む
 * グレゴリオ暦）と突き合わせる。`new Date(…)` の解釈（時間帯・年の範囲）に判定を預けない。
 */
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

/**
 * `to` が `from` より前だと、絞り込みは常に空を返す（issue #2155 / #2211）。
 *
 * デーモンの `usageQuery`（`apps/daemon/src/app.ts`）も、クローンの道具
 * `usage_read`（`tools.ts` の `stores.usage.aggregate`）も、`from` / `to` の
 * 前後を検査せず `date >= from AND date <= to` で絞るだけなので、`to < from`
 * のときは例外にならず単に0件になる ——0件を返す側（`renderUsage` /
 * `usage.tsx` の `UsageBody`）はその0件を「その範囲には記録が無い。」としか
 * 出さないので、「期間の指定が逆」と「その期間に本当に記録が無い」が区別
 * できない。
 *
 * **CLI（`alteroid usage` / chat の `/usage`）・Web（`usage.tsx`）・クローンの
 * `usage_read` の3つの入口すべてがこれを呼ぶ（issue #2211）。** どれか1つに
 * しか無いと「その入口でしかできないこと」を作ってしまう（north_star の
 * 禁止と同じ形）。
 *
 * `from` / `to` は、呼び出し側で {@link isRealUsageDate}（または同じ判定の
 * `usageDateSchema`）を既に通した後の値であることを前提にする —
 * `YYYY-MM-DD` の辞書式比較がそのまま日付の前後に一致する。
 *
 * **zod を持ち込まない形でここに置く。** このファイルはブラウザ向けの軽い口
 * （`@alteroid/core/usage`）から出ている（{@link USAGE_DATE_PATTERN} の doc
 * と同じ理由）。
 */
export function describeUsageDateOrder(
  from: string | undefined,
  to: string | undefined,
): string | null {
  if (from === undefined || to === undefined) return null;
  if (to >= from) return null;
  return `to（${to}）が from（${from}）より前なので、この範囲には1日も入らない`;
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
 * `apiKeySource` の1行を作る。**`'ok'` と `unavailable` の両方の枝から呼ぶための
 * 切り出しである**（`unavailable` でもこの欄だけは運ばれるようになった。#681）。
 *
 * **無駄な間接層に見えても戻さないこと**（AGENTS.md「テストを可能にする構造変更」）。
 * この関数を切り出す前は `'ok'` の枝だけがこの行を書いており、`unavailable` の
 * 枝は早期 return してこの行へ一度も到達していなかった——`apiKeySource` が
 * `unavailable` の枝にも運ばれるようになった以上、**2箇所で同じ文言を手で
 * 揃え続けるのは事故のもとである**（片方だけ直して片方が古くなる）。
 *
 * **`'ok'` の枝の出力は1文字も変えていない。** 既存の歯4本（`describeAccountUsage`
 * の `apiKeySource` の歯。すべて `okState(...)` を通る）が、この切り出しの前後で
 * 同じ文言を見ることを保証する。
 */
function describeApiKeySource(apiKeySource: AccountApiKeySource | undefined): string {
  return (
    `認証の出所（apiKeySource。判定には使っていない観測）: ${apiKeySource ?? '（取れなかった）'}` +
    (apiKeySource === 'none'
      ? '（API キーを使っていないという意味。claude.ai の OAuth ログイン等。「ログインしていない」ではない）'
      : '')
  );
}

/**
 * `tokenSourcePresence` の1行を作る（#706 の本題）。**内容は一切出さない**
 * ——外へ渡ってくる時点で `TokenSourcePresence` はもう状態だけの3値
 * （＋版ずれの `undefined`）で、生の `tokenSource` はここへ届かない。
 *
 * **4つの状態を、4つの別の文言にする。** どの2つも同じ文言へ倒さないこと
 * ——「取れなかった」（試して駄目だった）と「この版は送らない」（誰も試して
 * いない）は意味が正反対で、混同すると「対応している daemon へ繋ぎ直せば直る」
 * のか「鍵が届くのを待てばよい」のかを読み違える。
 */
function describeTokenSourcePresence(presence: TokenSourcePresence | undefined): string {
  switch (presence) {
    case undefined:
      // **version skew——この daemon がこの欄をまだ送らない。**「取れなかった」
      // とは別の文言にすること（`accountUsageSchema` の `tokenSourcePresence`
      // の doc）。
      return '鍵の届き具合（tokenSource）: この版はこの情報を出さない（daemon が未対応）';
    case 'not_returned':
      return '鍵の届き具合（tokenSource）: 取得できず（SDK がこの欄を返さなかった）';
    case 'empty':
      return '鍵の届き具合（tokenSource）: 欄はあるが空（SDK が空文字を返した）';
    case 'present':
      return '鍵の届き具合（tokenSource）: 値が届いている（内容はここに出さない）';
  }
}

/**
 * `plan` / `organization` の3状態を、3つの別の文字列にする。#706 で
 * `tokenSourcePresence` の4状態を4つの文言へ割ったのと同じ形である。
 *
 * - `undefined` → 「（取れなかった）」（**欄が無い**）
 * - `''`／空白のみ → 「（欄はあるが空）」（**欄はあるが空**）
 * - それ以外 → その値
 *
 * ⛔ **どの2つも同じ文言へ倒さないこと。** 「向こうがこの欄を返さなかった」と
 * 「返ってきたが空だった」は別の観測で、混同すると**向こうが何を答えたのかが
 * 読む側から消える**（それを畳んでいたのが `usage-snapshot.ts` の `nonEmpty()`
 * である）。⚠️ **`?? '（取れなかった）'` の形では割れない** ——`''` は nullish
 * ではないので既定値が出ず、**空白が出る**。
 *
 * ⚠️ **`undefined` を「この版は出さない」と名乗らないこと。** この2欄には
 * `tokenSourcePresence` のような版ずれ専用の状態が無いので、`undefined` は
 * 「SDK が返さなかった」と「旧い daemon が送らなかった」の両方から来る。
 * どちらだとも断定できないので、断定しない語（「取れなかった」）にしてある。
 */
function describeAccountText(value: string | undefined): string {
  if (value === undefined) return '（取れなかった）';
  return value.trim().length === 0 ? '（欄はあるが空）' : value;
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
    // **「この構成では取れない」と名乗らない**（#681）。倒れ込む道の1本
    // （`cause: 'undetermined'`）は**断定できていない**ので、ここが断定すると
    // `reason` の中の「言い分けられない」と食い違う。**断定は `reason` の側に
    // 任せる** —— 理由ごとの言葉は1箇所（`describeLimitsUnavailable`）が持つ。
    return [
      plain(`枠が返ってこない: ${state.reason}（${state.at}）`),
      // **`unavailable` でもこの欄だけは運ばれる**（#681 の設計判断。`usage` は
      // 積まない）。`plain` は通さない——`'ok'` の枝と同じ文言をそのまま出す。
      describeApiKeySource(state.apiKeySource),
      // 生の応答が持っていた欄の名前（#1458。値は出さない）。`apiKeySource` が
      // 取れなかった原因——SDK が欄ごと返さなかったのか——をここで読む。
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
    `プラン: ${describeAccountText(usage.plan)}` +
      (usage.organization === undefined
        ? ''
        : ` / 組織: ${describeAccountText(usage.organization)}`),
  );

  // **判定には使っていない観測である**（#681 (2)）。`classifyLimitsUnavailable`
  // はこの欄を読まない。`'none'` は「**API キーを使っていない**」という意味で
  // （claude.ai の OAuth ログイン等）、**「ログインしていない」ではない**——
  // それを言うのは `tokenSource` の欄である（`describeLimitsUnavailable` の
  // `not_logged_in` の doc と同じ注意）。取れなかったときは埋めない。
  lines.push(describeApiKeySource(usage.apiKeySource));
  // **こちらも判定には使っていない観測。** 内容は運ばない（#706）。
  lines.push(describeTokenSourcePresence(usage.tokenSourcePresence));

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

// ---------------------------------------------------------------------------
// 台帳に1行も無い委譲（Issue #98）
// ---------------------------------------------------------------------------

/**
 * 「台帳に1行も無いか」を判定するための最小の入力。
 *
 * **`ManagerSummary`（`manager.ts`）をそのまま import しない。** `manager.ts` は
 * `usage.ts` を値として import している（`usageDate` を呼ぶ）ので、ここが値として
 * `manager.ts` を読み返すと循環になる（`usage.ts` → `usage-format.ts` →
 * `manager.ts` → `usage.ts`）。**この形は `ManagerSummary` のうち判定に要る3つの
 * フィールドだけを型として書き写す** — `ManagerSummary` にフィールドが増えても、
 * ここが要求するのはこの3つだけなので壊れない。
 */
export interface UnrecordedManagerCandidate {
  managerId: string;
  /**
   * **絞り込みには使わない。** 判定は「台帳に1行も無いか」の1つだけである
   * （Issue #98 が既に決めている制約）。ここに持つのは、取りこぼした委譲を
   * 一覧に並べるときに `[running]` のような注記を添えるためだけである——
   * 読む側が「走行中の分がまだ入っていない」と分かる材料になる。
   */
  status: JobStatus;
  /** `ManagerSummary.startedAt`（= `Job.createdAt`）。ISO 8601。 */
  startedAt: string;
}

/**
 * 判定した結果。**入力（{@link UnrecordedManagerCandidate}）と形は同じだが役割が
 * 違う** ——呼び出し側が「これから判定する候補」と「判定済みの結果」を型で
 * 取り違えないように分けてある。
 */
export type UnrecordedManager = UnrecordedManagerCandidate;

/**
 * 消費の台帳に1行も無い委譲を数える（Issue #98）。**唯一の判定軸は「台帳に1行も
 * 無いか」——`status`（`running` / `done` / `lost` …）では絞らない。** 途中まで
 * 記録が在る委譲（`result` が来る前に畳まれた分だけ取りこぼした委譲）は、この
 * 判定では「取りこぼし」ではない——取れている分は台帳に載っているし、そこから
 * 先がいくらだったかはこの層は知らないし推定しない。
 *
 * 3引数それぞれに、呼び出し側が守るべき契約がある:
 *
 * 1. `managers` — 全委譲（`ManagerPool.list()` の戻り値そのもの。`from` / `to` の
 *    ような期間で絞ったものを渡さないこと）
 * 2. `recordedManagerIds` — 台帳（`usage_daily`）に1行でも行が在る managerId の
 *    集合。**全期間・絞り込み無しで取ったものであること**（`UsageStore.
 *    recordedManagerIds()` の doc）。`aggregate()` の `rows` から作ると、照会
 *    範囲の外で記録された委譲が「記録が無い」に化ける——`aggregate()` の `rows`
 *    は呼び出し側の `from` / `to` で絞られているので、ここへ渡してはならない
 * 3. `since` — `usageAggregate.since`（台帳が記録を始めた時刻）。これより古い
 *    `createdAt` の委譲は数えない——あれは「記録が無い」ではなく「台帳が
 *    無かった」で、その但し書きは既に `beforeLedger` が持っている
 *
 * `since` が `null`（台帳がまだ1件も記録していない）のときは、比べる相手が
 * 無いので誰も除外しない——その場合 `recordedManagerIds` も必ず空集合になる
 * （1件も record していないのだから、行が在る managerId も存在しない）ので、
 * 渡された `managers` 全員がそのまま対象になる。
 *
 * **`query.from` / `query.to` / `query.managerId` などの照会の絞り込みは見ない。**
 * `since` は照会に関わらず台帳の始点という1つの値なので、この判定も照会の
 * 絞り込みとは独立している——期間を絞っても取りこぼしの数は変わらない
 * （変わったら、それこそが「照会範囲の外の委譲が記録が無いに化けた」という
 * 壊れ方である）。
 */
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
      // **3フィールドへ写す（フィルタしただけで返さない）。** 呼び出し側
      // （`ManagerPool.list()`）が渡してくるのは `ManagerSummary` 丸ごとで、
      // 型（`UnrecordedManagerCandidate`）は3フィールドしか要求していないが、
      // 構造的部分型なので実際の値は残りのフィールドも持ったままである。ここで
      // 写し取らずに返すと、`.parse()` を通さない口（`GET /usage` の応答は
      // `usageResponseSchema` を `.parse()` していない）では `ManagerSummary`
      // 丸ごとが黙って外へ出る——`openapi.ts` の `unrecordedManagerSchema` の doc
      // が「宣言と実物を繋ぐのは `.parse()` だけ」と言っている、まさにその穴。
      .map((manager) => ({
        managerId: manager.managerId,
        status: manager.status,
        startedAt: manager.startedAt,
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  );
}

/**
 * 台帳に1行も無い委譲を、人間・クローンが読む行へ（Issue #98）。
 *
 * **文言をここ1つに持つ理由は {@link describeAccountUsage} と同じ。** この値を
 * 読む口は4つある（`GET /usage` / CLI の `alteroid usage` と chat の `/usage` /
 * Web の `/usage` 画面 / クローンの `usage_read`）。面ごとに書くと、「0件」の
 * 言い方が食い違い、いつか片方だけが黙って何も出さない日が来る。
 *
 * **0件のときも黙らない。** 空配列は「取りこぼしが無い」であって「調べていない」
 * ではない（AGENTS.md の地雷表）——そう読める形で、0件でも必ず1行返す。
 */
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
