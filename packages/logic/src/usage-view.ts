import { describeAccountUsage } from '@alteroid/core/usage';

import { formatDateTime } from './format.js';
import type { AccountUsageState, UsageLayer, UsageSite } from './types.js';

export const USAGE_LAYER_LABELS: Record<UsageLayer, string> = {
  clone: 'クローン',
  manager: 'マネージャー（作業者の分を含む）',
};

export const USAGE_SITE_LABELS: Record<UsageSite, string> = {
  session: '会話そのもの',
  distill: '記憶への書き出し（要約の直前）',
  peer: 'もう一方の AI への相談',
};

export function usageLayerLabel(layer: string): string {
  return (USAGE_LAYER_LABELS as Record<string, string>)[layer] ?? layer;
}

export function usageSiteLabel(site: string): string {
  return (USAGE_SITE_LABELS as Record<string, string>)[site] ?? site;
}

const WINDOW_KIND_LABELS: Record<string, string> = {
  five_hour: '5時間の枠',
  seven_day: '7日間の枠',
  seven_day_opus: '7日間の枠（Opus）',
  seven_day_sonnet: '7日間の枠（Sonnet）',
  seven_day_overage_included: '7日間の枠（超過分を含む）',
  overage: '超過分',
};

export interface AccountUsageView {
  headline?: string;
  tone: 'info' | 'warn' | 'ok';
  action?: string;
  lines: string[];
  details: string[];
}

export function describeAccountUsageView(state: AccountUsageState | undefined): AccountUsageView {
  const core = describeAccountUsage(state, { emphasis: false });
  if (state === undefined) {
    return {
      tone: 'warn',
      headline: 'アカウント全体の残りを取得できませんでした。',
      action: '接続先のサーバが古い可能性があります。更新してから開き直してください。',
      lines: [],
      details: core,
    };
  }
  if (state.state === 'unknown') {
    return {
      tone: 'info',
      headline: 'アカウント全体の残りは、まだ取得していません。',
      action: '起動した直後です。少し待ってから開き直してください。',
      lines: [],
      details: core,
    };
  }
  if (state.state === 'failed') {
    return {
      tone: 'warn',
      headline: 'アカウント全体の残りを取得できませんでした。',
      action: '時間をおいて開き直してください。続くときは Claude へのログインを確かめてください。',
      lines: [],
      details: [`${state.reason}（${formatDateTime(state.at)}）`, ...core.slice(1)],
    };
  }
  if (state.state === 'unavailable') {
    const details = [
      `${state.reason}（${formatDateTime(state.at)}）`,
      ...core.slice(1).filter((line) => !line.startsWith('観測時刻')),
    ];
    if (state.cause === 'not_logged_in') {
      return {
        tone: 'info',
        headline: 'Claude にログインしていないため、アカウント全体の残りは表示できません。',
        action: 'Claude にログインすると、残りが見えます。',
        lines: [],
        details,
      };
    }
    if (state.cause === 'non_first_party') {
      return {
        tone: 'info',
        headline: 'いまの認証方法では、Claude の残りを表示できません。',
        action: 'Claude のアカウントでログインすると、残りが見えます。',
        lines: [],
        details,
      };
    }
    return {
      tone: 'warn',
      headline: 'アカウント全体の残りを表示できない状態です。',
      action: 'Claude に入り直すと見えることがあります。',
      lines: [],
      details,
    };
  }
  const isDeveloperLine = (line: string) =>
    line.startsWith('認証の出所（') || line.startsWith('鍵の届き具合（');
  const lines = core
    .filter((line) => !line.startsWith('観測時刻:') && !isDeveloperLine(line))
    .map((line) =>
      line.replace(/^( {2})([a-z_]+):/, (whole, indent: string, kind: string) => {
        const label = WINDOW_KIND_LABELS[kind];
        return label === undefined ? whole : `${indent}${label}:`;
      }),
    );
  lines.push(`取得した時刻: ${formatDateTime(state.usage.at)}`);
  return { tone: 'ok', lines, details: core.filter(isDeveloperLine) };
}
