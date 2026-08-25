import { stdout } from 'node:process';

import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnrecordedManagers,
  formatUsd,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type AccountUsageState,
  type UnrecordedManager,
  type UsageAggregate,
  type UsageLayer,
  type UsageSite,
} from '@alteroid/core';

import { createClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid usage` — alteroid が使った分（トークンと費用）を見る。
 *
 * 経路は `GET /usage` の1本だけ（`apps/daemon/src/app.ts`「経路は1本だけにする」）。
 * CLI・Web・クローンの道具（`usage_read`）が同じ数字を見る。
 *
 * **算術は core（`summarizeUsage` / `formatUsd`）に任せ、ここでは足し直したり
 * 丸め直したりしない。** 口ごとに数字が食い違うと、数字を出す機能そのものが
 * 信用を失う。
 */

export interface UsageOptions {
  from?: string;
  to?: string;
  manager?: string;
  /**
   * 誰が（層）・どこで（場所）。**受け口は素の文字列**（コマンドラインから来る）。
   *
   * 値の集合は書き写さず、core の `usageLayerSchema` / `usageSiteSchema` に通して
   * 絞る（{@link narrowUsageAxis}）。**ここに 'clone' | 'manager' と書くと、値が
   * 増えたときに CLI だけが古くなる。**
   */
  layer?: string;
  site?: string;
  /**
   * どの認証トークンで（`alteroid token list` の `id=`）。
   *
   * **`narrowUsageAxis` を通さない。** 値の集合が閉じていない（プールの中身は
   * 器ごとに違う）ので、許された値の一覧を CLI が持てない。**通す先で存在しない
   * id を弾かないこと** — 弾くと「そのトークンでは1件も使っていない」と
   * 「そんなトークンは無い」が同じ空の結果に潰れる。空なら空と出す。
   */
  token?: string;
}

/**
 * `--layer` / `--site` の値を、core の schema で許された値へ絞る。
 *
 * **値の集合を CLI に書き写さない。** 持ち主は core の schema1つだけで、ここは
 * それを通すだけである（値が増えれば自動で追いつく）。許された値の一覧も
 * `schema.options` から作るので、増えたときに文言だけ古くなることがない。
 */
export function narrowUsageAxis<T extends string>(
  schema: { options: readonly T[]; safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: string | undefined,
): { ok: true; value: T | undefined } | { ok: false; allowed: string } {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, allowed: schema.options.join(' / ') };
  return { ok: true, value: parsed.data };
}

export async function usageCommand(options: UsageOptions): Promise<void> {
  const layer = narrowUsageAxis<UsageLayer>(usageLayerSchema, options.layer);
  if (!layer.ok) {
    stdout.write(`--layer は ${layer.allowed} のどれかを指定してください\n`);
    return;
  }
  const site = narrowUsageAxis<UsageSite>(usageSiteSchema, options.site);
  if (!site.ok) {
    stdout.write(`--site は ${site.allowed} のどれかを指定してください\n`);
    return;
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.usage.$get({
    query: {
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      ...(options.manager === undefined ? {} : { managerId: options.manager }),
      ...(layer.value === undefined ? {} : { layer: layer.value }),
      ...(site.value === undefined ? {} : { site: site.value }),
      ...(options.token === undefined ? {} : { tokenId: options.token }),
    },
  });
  if (!response.ok) {
    stdout.write('利用状況を読めませんでした（クエリの形を確かめてください）\n');
    return;
  }
  const aggregate = await response.json();
  stdout.write(`${renderUsage(aggregate)}\n`);
}

/**
 * 台帳の集計を、人間が読める形へ。CLI 本体（`alteroid usage`）と chat の
 * `/usage` の両方がこれを使う — 表示を1箇所に揃えるためである。
 *
 * 軸ごとに出す件数へ上限を置く。**打ち切ったら必ずそう書く**（黙って切り捨てると、
 * 「全部でこれだけ」と読める出力が嘘になる）。
 */
const AXIS_LIMIT = 20;

/**
 * `GET /usage` の応答そのまま。
 *
 * **`account` を `?:`（省略可能）にしない。** 省略できる形にすると、渡し忘れた口が
 * 黙って「アカウント全体の残り」を落とす — まさにそれが起きていた欠陥である。
 * キーを必須にしておけば、口を増やしたときに渡し忘れがコンパイルで止まる。
 *
 * 値のほうは `undefined` を許す。**「この項目を返さないデーモンに繋がっている」は
 * 実際に起こりうる状態**で（CLI は `ALTEROID_URL` で別のデーモンへ繋げる）、
 * それは `unknown`（まだ取りに行っていない）とは別の事実である。どう言うかは
 * `describeAccountUsage` が1箇所で持つ。
 */
export interface UsageView extends UsageAggregate {
  account: AccountUsageState | undefined;
  /**
   * 消費の記録が1件も無い委譲（Issue #98）。
   *
   * **キーは必須にしておく**（`account` と同じ理由）。渡し忘れた口が黙って
   * 「取りこぼしは無い」を出せてしまうと、`[]` と「まだ計算していない」が
   * 同じ形に潰れる。
   */
  unrecordedManagers: readonly UnrecordedManager[];
}

export function renderUsage(view: UsageView): string {
  const {
    rows,
    since,
    layersSince,
    tokensSince,
    beforeLedger,
    beforeLayers,
    beforeTokens,
    notice,
    account,
    unrecordedManagers,
  } = view;

  /**
   * アカウント全体の残り。**台帳がまだ空の経路にも同じものを付ける** — 台帳が
   * 空であることと、アカウントの枠が分からないことは別の事実である。
   */
  const accountLines = () => [
    '',
    `${ACCOUNT_USAGE_TITLE}:`,
    // 端末は Markdown を解釈しないので強調は落とす（文そのものは4つの口で同じ）。
    ...describeAccountUsage(account, { emphasis: false }).map((line) => `  ${line}`),
  ];

  if (since === null) {
    // **`$0.00` と出さない。** まだ台帳に1件も無いのを「使っていない」に見せない。
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      '',
      ...describeUnrecordedManagers(unrecordedManagers),
      '',
      notice,
      ...accountLines(),
    ].join('\n');
  }

  const lines: string[] = [];

  if (rows.length === 0) {
    lines.push('その範囲には記録が無い。');
  } else {
    // **算術はここで足し直さない。** `summarizeUsage` の結果をそのまま出す。
    const summary = summarizeUsage(rows);

    lines.push(`合計 ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}`,
    );
    // **合計値の隣に必ず出す（Issue #98）。** 台帳に1行も無い委譲は上の合計に
    // 入っていないので、合計を読んだ直後にそれが分かる位置へ置く。
    lines.push(...describeUnrecordedManagers(unrecordedManagers));

    const axis = (title: string, entries: Array<{ label: string; costUsd: number }>) => {
      lines.push('', title);
      for (const entry of entries.slice(0, AXIS_LIMIT)) {
        lines.push(`  ${entry.label}: ${formatUsd(entry.costUsd)}`);
      }
      if (entries.length > AXIS_LIMIT) {
        lines.push(`  …（残り ${entries.length - AXIS_LIMIT} 件は出していない）`);
      }
    };

    // 日別は新しい順（古い日で上限を使い切らせない）。
    axis(
      '日別:',
      [...summary.byDate].reverse().map((e) => ({ label: e.date, costUsd: e.totals.costUsd })),
    );
    // マネージャー別・モデル別は高い順（どの委譲・どの層が高かったかを先に見せる）。
    axis(
      'マネージャー別:',
      [...summary.byManager]
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
        .map((e) => ({ label: e.managerId, costUsd: e.totals.costUsd })),
    );
    axis(
      'モデル別:',
      [...summary.byModel]
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
        .map((e) => ({ label: e.model, costUsd: e.totals.costUsd })),
    );
    // **誰が**・**どこで**。モデル別と別に出す — `ALTEROID_CLONE_MODEL` を置けば
    // クローンとマネージャーは同じモデル帯に並ぶので、モデル名では層を見分けられない。
    axis(
      '層別（誰が）:',
      [...summary.byLayer]
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
        .map((e) => ({ label: e.layer, costUsd: e.totals.costUsd })),
    );
    axis(
      '場所別（どこで）:',
      [...summary.bySite]
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
        .map((e) => ({ label: e.site, costUsd: e.totals.costUsd })),
    );
    // **どの認証トークンで。** `null` は「取れていない分」であって、消さない
    // （消すとこの軸だけ合計に足し合わなくなり、それが読み手から分からない）。
    axis(
      '認証トークン別:',
      [...summary.byToken]
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd)
        .map((e) => ({
          label: e.tokenId ?? '（トークンの帰属が無い分）',
          costUsd: e.totals.costUsd,
        })),
    );
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // **0 と言わない。** 台帳が無かった期間を「使っていない期間」と読ませない。
    lines.push('照会した範囲は台帳の始点より前にかかっている。その分は 0 ではなく「記録が無い」。');
  }
  // **層の始点を台帳の始点と混ぜない。** 層の軸のほうが後から入ったので、それより
  // 前の行の層と場所は既定値であって観測ではない。ここを黙ると「クローンは使って
  // いなかった」「蒸留は起きていなかった」と読める。
  lines.push(
    layersSince === null
      ? '層と場所の軸はまだ1件も記録していない。'
      : `層と場所の軸の始点: ${layersSince}`,
  );
  if (beforeLayers) {
    lines.push(
      '照会した範囲は層と場所の軸の始点より前にかかっている。' +
        'その分の層と場所は既定値であって観測ではない。',
    );
  }
  // **トークンの軸の始点は、上の2つと意味が1つ違う。** ここが null なのは「まだ
  // 1件も記録していない」だけでなく、**プールを使っていないので取れない**ことが
  // ある。だから「まだ記録していない」で終わらせず、それが正常でありうると書く。
  lines.push(
    tokensSince === null
      ? '認証トークンの軸はまだ1件も記録していない（プールを使っていない構成なら、これが正常）。'
      : `認証トークンの軸の始点: ${tokensSince}`,
  );
  if (beforeTokens) {
    lines.push(
      '照会した範囲は認証トークンの軸の始点より前にかかっている。' +
        'その分にトークンの帰属は無い（0 でも既定値でもなく、取れていない）。',
    );
  }
  lines.push(notice);

  /*
   * **アカウント全体の残りを、台帳と並べて必ず出す。**
   *
   * `GET /usage` はこれを最初から返していたのに、人間が読む2面（CLI・Web）は
   * どちらも捨てていた。読んでいたのはクローンの `usage_read` だけで、
   * 「クローンには見えているものが人間には見えない」状態だった（north_star 禁止1
   * の形）。枠で待たされた発言を直したところ（#92）で、その枠の残りが人間から
   * 見えないのは筋が通らない。
   *
   * **台帳の下に、区切って置く。** 混ぜて足せる並びにしないこと（一方は自分で
   * 数えた推定値、もう一方は向こうが言っている値で、一致する保証がない）。
   */
  lines.push(...accountLines());

  return lines.join('\n');
}
