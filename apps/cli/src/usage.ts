import { stderr, stdout } from './terminal-out.js';

import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnreadableUsage,
  describeUnmeteredUsage,
  describeUnreadableUsageRows,
  describeUnrecordedManagers,
  describeUsageDateOrder,
  describeUsageResets,
  describeWebSearchRequests,
  formatUsd,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type UsageLayer,
  type UsageSite,
} from '@alteroid/core';
import type { InferResponseType } from 'hono/client';

import { createClient, type DaemonClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { resolveTarget } from './target.js';

export interface UsageOptions {
  from?: string;
  to?: string;
  manager?: string;
  // 'clone' | 'manager' と書かない: 値が増えたときに CLI だけが古くなるため
  layer?: string;
  site?: string;
  // `narrowUsageAxis` を通さない: 値の集合が閉じていない（プールの中身は器ごとに違う）ため
  token?: string;
  // 整形せず、デーモンの応答をそのまま JSON で標準出力へ出す（診断の材料として機械が読む口）
  json?: boolean;
}

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
    throw new Error(`--layer は ${layer.allowed} のどれかを指定してください`);
  }
  const site = narrowUsageAxis<UsageSite>(usageSiteSchema, options.site);
  if (!site.ok) {
    throw new Error(`--site は ${site.allowed} のどれかを指定してください`);
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    // `--json` の案内を標準出力へ出さない: `| jq` へ渡せなくなるため
    if (options.json === true) stderr.write(`${target.note}\n`);
    else stdout.write(`${target.note}\n`);
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
    // 認証切れ（401/403）を「クエリの形を確かめてください」と案内しない
    throw new Error(
      await describeFailedResponse(
        `利用状況を読めませんでした（HTTP ${String(response.status)}。クエリの形を確かめてください）`,
        response,
        target,
      ),
    );
  }
  const aggregate = await response.json();
  const dateOrderNotice = describeUsageDateOrder(options.from, options.to);
  if (options.json === true) {
    // 応答を欄ごと素通しする（`breakdown` / `today` も落とさない）。`writeRaw` を使う: 端末向けの掃除は JSON の中身を変えるため
    if (dateOrderNotice !== null) stderr.write(`${dateOrderNotice}\n`);
    stdout.writeRaw(`${JSON.stringify(withDiagnosticsFields(aggregate))}\n`);
    return;
  }
  if (dateOrderNotice !== null) {
    stdout.write(`${dateOrderNotice}\n`);
  }
  stdout.write(`${renderUsage(aggregate)}\n`);
}

// 台帳の `date` の時間帯は、API の応答のどこにも載っていない（`today` は日付だけ。`/health` / `/status` にも無い）。
// 推測の TZ を埋めない: 器の既定（Asia/Tokyo）が変わっている構成で、嘘の時間帯を機械が信じるため。API に欄を足さず「取れない」と出す
export const LEDGER_DATE_TIMEZONE_UNAVAILABLE = {
  state: 'unavailable',
  note:
    '台帳の date はサーバのローカル時刻（TZ）で切った日付で、その TZ は API の応答から取れない。' +
    '日誌の at・窓は UTC のため、日付を突き合わせるときは日誌側をサーバの TZ へ直す必要がある',
} as const;

// `resets` を必ず出す: 数え直しの件数は累積の信用に関わり、欄ごと無いと「0 件」と読み分けられないため。
// 応答に無い（古いデーモン）ときは [] ではなく null: 「無かった」と「取れなかった」を分ける
export function withDiagnosticsFields(aggregate: UsageJsonSource): Record<string, unknown> {
  return {
    ...aggregate,
    resets: aggregate.resets ?? null,
    ledgerDateTimeZone: LEDGER_DATE_TIMEZONE_UNAVAILABLE,
  };
}

type UsageJsonSource = { resets?: unknown } & Record<string, unknown>;

export { describeUsageDateOrder };

// 黙って切り捨てない: 「全部でこれだけ」と読める出力が嘘になるため
const AXIS_LIMIT = 20;

// デーモンの応答の型から導く（型付きクライアントの `InferResponseType`）: 手で写さない。欄が増えたら tsc が教える
// `breakdown`（デーモンの集計）と `today` は読まない: 集計は `rows` から `summarizeUsage` で組む（口ごとに数字が食い違わないため）
export type UsageView = Omit<
  InferResponseType<DaemonClient['usage']['$get'], 200>,
  'breakdown' | 'today'
>;

export function renderUsage(view: UsageView): string {
  const {
    rows,
    turnRows,
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
  const unreadableRowsLines = describeUnreadableUsageRows(view.unreadableRows);
  const unmeteredLines = describeUnmeteredUsage(view.unmeteredRows);
  const resetLines = describeUsageResets(view.resets);

  const accountLines = () => [
    '',
    `${ACCOUNT_USAGE_TITLE}:`,
    ...describeAccountUsage(account, { emphasis: false }).map((line) => `  ${line}`),
  ];

  if (since === null) {
    // `$0.00` と出さない: まだ台帳に1件も無いのを「使っていない」に見せないため
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      ...unreadableRowsLines,
      ...unmeteredLines,
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
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    lines.push(...resetLines);
    lines.push('', ...describeUnrecordedManagers(unrecordedManagers));
  } else {
    // 足し直さない: 口ごとに数字が食い違うと信用を失うため
    const summary = summarizeUsage(rows, turnRows);

    lines.push(`合計 ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}` +
        describeWebSearchRequests(summary.total),
    );
    lines.push(...describeUnreadableUsage(summary.total));
    lines.push(...unreadableRowsLines);
    lines.push(...unmeteredLines);
    lines.push(...resetLines);
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

    // 日別は新しい順にする: 古い日で上限を使い切らせないため
    axis(
      '日別:',
      [...summary.byDate].reverse().map((e) => ({ label: e.date, costUsd: e.totals.costUsd })),
    );
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
    // モデル別に混ぜない: クローンとマネージャーはどちらも opus で、モデル名では層を見分けられないため
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
    // `null`（取れていない分）を消さない: この軸だけ合計に足し合わなくなり、読み手から分からないため
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
    // 0 と言わない: 台帳が無かった期間を「使っていない期間」と読ませないため
    lines.push('照会した範囲は台帳の始点より前にかかっている。その分は 0 ではなく「記録が無い」。');
  }
  // 層の始点を台帳の始点と混ぜない: それより前の行の層と場所は既定値であって観測ではないため
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
  // 「まだ記録していない」だけで終わらせない: プールを使っていないので取れない場合もあるため
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

  // 台帳と混ぜて足せる並びにしない: 一方は自分で数えた推定値、もう一方は向こうが言っている値で、一致する保証がないため
  lines.push(...accountLines());

  return lines.join('\n');
}
