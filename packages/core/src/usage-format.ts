import type { JobStatus } from './schema.js';
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
 * 行を6軸（日 / actor / モデル / 層 / 場所 / 認証トークン）へ畳む。
 *
 * **層と場所を「無い値は 0」で補わないこと。** `groupBy` は行に現れた値だけを
 * 返す。1件も記録が無い層・場所は一覧に出ない ＝ 「0 使った」ではなく「記録が
 * 無い」として読める形である（`usage.ts` の `usageLayerSchema` / `usageSiteSchema`）。
 *
 * **トークンの軸だけは `null` の要素が出る**（`groupByToken`）。他の5軸は行が必ず
 * 値を持つが、この軸は**構成によってそもそも取れない**ので、「取れていない分」を
 * 落とすと合計に足し合わなくなる。落とさずに `null` として出す。
 */
export function summarizeUsage(rows: readonly UsageRow[]): UsageBreakdown {
  return {
    total: sumUsageRows(rows),
    byDate: groupBy(rows, (row) => row.date, 'date'),
    byManager: groupBy(rows, (row) => row.managerId, 'managerId'),
    byModel: groupBy(rows, (row) => row.model, 'model'),
    byLayer: groupBy(rows, (row) => row.layer, 'layer'),
    bySite: groupBy(rows, (row) => row.site, 'site'),
    byToken: groupByToken(rows),
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
