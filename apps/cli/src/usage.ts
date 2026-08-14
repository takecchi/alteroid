import { stdout } from 'node:process';

import { formatUsd, summarizeUsage, type UsageAggregate } from '@alteroid/core';

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
}

export async function usageCommand(options: UsageOptions): Promise<void> {
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

export function renderUsage(aggregate: UsageAggregate): string {
  const { rows, since, beforeLedger, notice } = aggregate;

  if (since === null) {
    // **`$0.00` と出さない。** まだ台帳に1件も無いのを「使っていない」に見せない。
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      '',
      notice,
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
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // **0 と言わない。** 台帳が無かった期間を「使っていない期間」と読ませない。
    lines.push('照会した範囲は台帳の始点より前にかかっている。その分は 0 ではなく「記録が無い」。');
  }
  lines.push(notice);
  return lines.join('\n');
}
