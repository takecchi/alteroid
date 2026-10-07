import { stdout } from './terminal-out.js';

import {
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeNoReadableInboxEvents,
  type InboxBacklogBreakdown,
} from '@alteroid/core';

import { createClient } from './client.js';
import { withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { redactError } from './redact.js';
import { shellQuote } from './shell-quote.js';

export interface InboxRemoveOptions {
  types: string;
  sources?: string;
  before?: string;
  reason: string;
  execute?: boolean;
  limit?: string;
}

interface InboxRemoveManyResult {
  ok: true;
  dryRun: boolean;
  totalPending: number;
  matched: number;
  targeted: number;
  removedIds: string[];
  remaining: number;
}

export async function inboxRemoveCommand(options: InboxRemoveOptions): Promise<void> {
  const target = await resolveTarget();
  // 未ログインで何もせず 0 で返さない: 「消した」と誤読されるため
  if (target.note !== null) throw new Error(target.note);

  const types = splitList(options.types);
  if (types.length === 0) {
    throw new Error(
      '--types に最低1種類を指定してください（カンマ区切り。例 --types manager_message）',
    );
  }

  const sources = options.sources === undefined ? undefined : splitList(options.sources);
  if (sources !== undefined && sources.length === 0) {
    throw new Error('--sources を渡すなら最低1件は指定してください');
  }

  let limit: number | undefined;
  if (options.limit !== undefined) {
    limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit には1以上の整数を渡してください（渡された値: ${options.limit}）`);
    }
  }

  // `--execute` を付けたときだけ `false` を送る: サーバ側は `dryRun !== false` を試算と読むため
  const dryRun = options.execute !== true;

  const body: Record<string, unknown> = { types, reason: options.reason, dryRun };
  if (sources !== undefined) body.sources = sources;
  if (options.before !== undefined) body.before = options.before;
  if (limit !== undefined) body.limit = limit;

  // 失敗を握り潰さない: stdout へ書いて正常 return すると終了コードが 0 になり、「消えたのか消えなかったのか」を読めないため
  const result = await post(target, body);
  report(result, dryRun, options);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function post(target: Target, body: Record<string, unknown>): Promise<InboxRemoveManyResult> {
  const response = await fetch(`${target.baseUrl}/inbox/remove`, {
    method: 'POST',
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (response.status === 400) {
      // サーバの断り文言を言い換えない: サーバ側の文言が変わったときここだけ古いままになるため
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        errorBody.error === undefined
          ? '受信箱の絞り込みが不正です（400）。1件も消していません。'
          : redactError(errorBody.error),
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`受信箱を畳めませんでした（${response.status}）`, response),
    );
  }

  return (await response.json()) as InboxRemoveManyResult;
}

function report(result: InboxRemoveManyResult, dryRun: boolean, options: InboxRemoveOptions): void {
  stdout.write(
    `${dryRun ? '[試算] ' : ''}未読 ${result.totalPending} 件中 ${result.matched} 件が絞り込みに一致` +
      `（対象 ${result.targeted} 件、上限で持ち越し ${result.remaining} 件）\n`,
  );

  if (dryRun) {
    stdout.write('1件も消していません（試算）。\n');
    // 試算でも id を並べる: 取り消せない一括削除の前に、絞り込みが意図どおりかを確かめられないため
    if (result.removedIds.length > 0) {
      stdout.write(`消すことになる id（${result.removedIds.length}件、古い順）:\n`);
      for (const id of result.removedIds) stdout.write(`  ${id}\n`);
    }
    stdout.write('実行するには --execute を付けてもう一度:\n');
    stdout.write(`  ${describeExecuteCommand(options)}\n`);
    return;
  }

  stdout.write(`消した id（${result.removedIds.length}件）:\n`);
  for (const id of result.removedIds) stdout.write(`  ${id}\n`);
}

function describeExecuteCommand(options: InboxRemoveOptions): string {
  const parts = [
    'alteroid inbox remove',
    `--types ${shellQuote(options.types)}`,
    ...(options.sources === undefined ? [] : [`--sources ${shellQuote(options.sources)}`]),
    ...(options.before === undefined ? [] : [`--before ${shellQuote(options.before)}`]),
    `--reason ${shellQuote(options.reason)}`,
    ...(options.limit === undefined ? [] : [`--limit ${shellQuote(options.limit)}`]),
    '--execute',
  ];
  return parts.join(' ');
}

export async function inboxShowCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const client = createClient(target.baseUrl, target.headers);
  const response = await client.inbox.$get();
  if (!response.ok) {
    // 失敗を stdout へ書いて正常終了しない: cron やスクリプトからは成功に見えるため
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`受信箱の内訳を読めませんでした（${response.status}）`, response),
    );
  }
  const breakdown = (await response.json()) as InboxBacklogBreakdown;
  stdout.write(`${renderInboxBacklog(breakdown)}\n`);
}

export function renderInboxBacklog(breakdown: InboxBacklogBreakdown): string {
  if (breakdown.total === 0) {
    return (
      describeNoReadableInboxEvents(breakdown.unreadable ?? []) ??
      'クローンの受信箱に未処理の合図は無い。'
    );
  }
  const alert = describeHumanOriginatedInboxAlert(breakdown);
  const lines = alert === '' ? [] : [alert, ''];
  lines.push(describeInboxBacklogBreakdown(breakdown));
  return lines.join('\n');
}
