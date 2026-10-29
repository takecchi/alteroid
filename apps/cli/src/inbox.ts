import { stdout } from './terminal-out.js';

import {
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeNoReadableInboxEvents,
  type InboxBacklogBreakdown,
} from '@alteroid/core';

import { createClient } from './client.js';
import { withErrorReason, describeFailedResponse } from './format.js';
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
  /** 古いデーモンの応答には無い。 */
  droppedFromDelivery?: number;
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

  // 送る前に取る: 応答の後に取ると、デーモンが試算で選んだ後〜応答が届くまでに来た、人間が見ていない合図まで実行の対象に入る
  const startedAt = new Date().toISOString();
  // 失敗を握り潰さない: stdout へ書いて正常 return すると終了コードが 0 になり、「消えたのか消えなかったのか」を読めないため
  const result = await post(target, body);
  report(result, dryRun, options, startedAt);
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
    // 本文を1度だけ読む: 部分失敗の判定と、従来の文言（withErrorReason）の両方が同じ本文を要るため
    const errorBody: unknown = await response.json().catch(() => null);
    if (response.status === 500) {
      const stopped = readStoppedRemoval(errorBody);
      if (stopped !== null) reportStoppedRemoval(stopped);
    }
    throw new Error(
      await withErrorReason(`受信箱を畳めませんでした（${response.status}）`, {
        json: () => Promise.resolve(errorBody),
      }),
    );
  }

  return (await response.json()) as InboxRemoveManyResult;
}

/** 並べる id の上限: 数百件の id で端末と、ログへ写された出力を埋めないため（全件は日誌の `decision` 行に在る）。 */
const STOPPED_REMOVAL_IDS_SHOWN = 10;

interface StoppedRemoval {
  removedIds: string[];
  droppedFromDelivery: number | undefined;
}

// daemon の `inboxRemoveManyStoppedResponseSchema` の読み側: CLI は daemon の実行時コードを取り込まない（型だけ）ので、必要な 2 欄だけを手で読む。
// 空の `removedIds`・欄の無い本文は null: 何も消えていない 500 は従来の「畳めませんでした」のままにするため。
function readStoppedRemoval(body: unknown): StoppedRemoval | null {
  if (typeof body !== 'object' || body === null || !('removedIds' in body)) return null;
  const { removedIds } = body;
  if (!Array.isArray(removedIds) || removedIds.length === 0) return null;
  if (!removedIds.every((id): id is string => typeof id === 'string')) return null;
  const dropped = 'droppedFromDelivery' in body ? body.droppedFromDelivery : undefined;
  return {
    removedIds,
    droppedFromDelivery: typeof dropped === 'number' ? dropped : undefined,
  };
}

function reportStoppedRemoval(stopped: StoppedRemoval): never {
  const count = stopped.removedIds.length;
  const shown = stopped.removedIds.slice(0, STOPPED_REMOVAL_IDS_SHOWN);
  stdout.write(`⚠ 途中で止まった。ここまでに ${count} 件を消した（取り消せない）。消した id:\n`);
  for (const id of shown) stdout.write(`  ${redactError(id)}\n`);
  if (count > shown.length) stdout.write(`  ほか ${count - shown.length} 件\n`);
  if (stopped.droppedFromDelivery !== undefined) {
    stdout.write(`配達の待ち行列からも外したのは ${stopped.droppedFromDelivery} 件。\n`);
  }
  stdout.write(
    '止まった塊より先は消していない（残りは受信箱に在る）。' +
      '打ち直す前に alteroid inbox で現状を確かめること（打ち直すと対象は選び直しになる）。\n',
  );
  // 出力のあとで非0にする: スクリプトの `&&` が成功と読まないため（runners vacate と同じ作法）
  throw new Error(
    `受信箱の一括削除が途中で止まりました（500）。${count} 件は消えています。alteroid inbox で現状を確かめてから打ち直してください`,
  );
}

function report(
  result: InboxRemoveManyResult,
  dryRun: boolean,
  options: InboxRemoveOptions,
  startedAt: string,
): void {
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
    // 案内の --before を試算の時刻に固定する: デーモンは実行のたびに条件で選び直すので、試算の後に届いた合図まで消える（元に戻せない）
    stdout.write(
      '実行するには --execute を付けてもう一度（--before を試算の時刻までにしてあるので、試算より後に届いた合図は消さない）:\n',
    );
    stdout.write(
      `  ${describeExecuteCommand({ ...options, before: earlierInstant(options.before, startedAt) })}\n`,
    );
    return;
  }

  stdout.write(`消した id（${result.removedIds.length}件）:\n`);
  for (const id of result.removedIds) stdout.write(`  ${id}\n`);

  // 古いデーモンの応答には無い: 0 と推測して書くと、配達待ちから外せていないのに「0 件外した」と読めるため
  if (result.droppedFromDelivery !== undefined) {
    stdout.write(
      `配達の待ち行列からも外したのは ${result.droppedFromDelivery} 件` +
        '（残りは器に在っただけで、まだ配達待ちには載っていなかった分である。' +
        '既に取り出して処理中のものは取り消せない。）\n',
    );
  }
  const raced = result.targeted - result.removedIds.length;
  if (raced > 0) {
    stdout.write(
      `⚠ 対象 ${result.targeted} 件のうち ${raced} 件は消せなかった` +
        '（この呼びの最中に他の経路が先に消した）。\n',
    );
  }
}

/** 渡された境界と試算の時刻のうち早いほう。読めない境界はデーモンが試算で断るので、ここへは来ない。 */
function earlierInstant(explicit: string | undefined, previewedAt: string): string {
  if (explicit === undefined) return previewedAt;
  return Date.parse(explicit) <= Date.parse(previewedAt) ? explicit : previewedAt;
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
    throw new Error(
      await describeFailedResponse(
        `受信箱の内訳を読めませんでした（${response.status}）`,
        response,
        target,
      ),
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
