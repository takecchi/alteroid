import { stdout } from 'node:process';

import { describeAuthFailure, resolveTarget, type Target } from './target.js';

/**
 * `alteroid inbox` — 受信箱（`inbox_events`。まだ処理し終えていない合図の器）。
 *
 * issue #972: 同じ失敗の写しが数千件積もると、クローン側は既存の単発 `remove()`
 * の1ターン1件のペースでしか排出できず、排出そのものが文脈窓を食い潰す。唯一の
 * 既存の一括手段は `POST /reset`（記憶ごと全部消す）で、それでは使えない
 * （#972 本文）。`POST /inbox/remove`（PR #1007。人間の入口、絞り込みで一括して
 * 畳む）は HTTP にしか出ておらず、人間の対話面（CLI・Web UI）からは叩けなかった
 * ——ここはその CLI 側を埋める（#972 提案4「人間の入口（CLI / HTTP / Web UI）
 * から叩けること」）。
 *
 * ⛔ **クローン自身の道具ではない。** クローンの道具 `inbox_remove_many`
 * （`packages/core/src/tools.ts`。#1013）とは別の入口で、こちらは人間が直接
 * 打つ。#972 本文が「クローン自身の道具にするかは別途の判断」と保留していた
 * 経緯（#972 コメント参照）はこの CLI コマンドには関係が無い——サーバ側の
 * `POST /inbox/remove` は最初から人間の入口として作られている。
 *
 * **既定は試算（dryRun）。1件も消さない。** `--execute` を付けたときだけ実際に
 * 消す（`resetCommand` の `--yes` と似た形だが、逆向き——`reset` は既定で確認を
 * 挟み `--yes` で飛ばす。ここは既定で何も起こさず `--execute` で初めて起こす。
 * 理由は絞り込みの間違いが「消しすぎ」を作りうるため、まず件数を見せる）。
 *
 * **`types` は必須で、`commitment_close_many` / `POST /inbox/remove` と同じく
 * 「在る7種類を全部並べた呼びは断る」——サーバ側（`app.ts`）が判定するので
 * ここでは複製しない。同じ理由でエラー文言もサーバのものをそのまま出す。**
 *
 * **失敗は例外で上へ通す（＝終了コードが 0 でなくなる）。** 消す操作なので、
 * 「消えたのか消えなかったのか」を終了コードから読めない形にしない（本体の
 * `post(target, body)` を呼ぶ箇所の注釈に理由の全文が在る）。
 *
 * **サーバが 7 種類のうちどれを受けるかは、クローンの道具とは別である。**
 * `inbox_remove_many`（`packages/core/src/tools.ts`）は人間起点の合図
 * （`human_message` / `human_answer`）を構造的に除くが、**それは道具側の
 * 線引きであって、この HTTP の口の線引きではない**（逐語は
 * `grep -Fn -- 'この HTTP の口は' apps/daemon/src/openapi.ts`）。人間の入口
 * である CLI / Web UI は 7 種類とも渡せる。
 */
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
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }

  const types = splitList(options.types);
  if (types.length === 0) {
    stdout.write(
      '--types に最低1種類を指定してください（カンマ区切り。例 --types manager_message）\n',
    );
    return;
  }

  const sources = options.sources === undefined ? undefined : splitList(options.sources);
  if (sources !== undefined && sources.length === 0) {
    stdout.write('--sources を渡すなら最低1件は指定してください\n');
    return;
  }

  let limit: number | undefined;
  if (options.limit !== undefined) {
    limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      stdout.write(`--limit には1以上の整数を渡してください（渡された値: ${options.limit}）\n`);
      return;
    }
  }

  // 既定は試算（`dryRun !== false` をサーバ側が試算と読む——`--execute` を
  // 付けたときだけ `false` を送る）。
  const dryRun = options.execute !== true;

  const body: Record<string, unknown> = { types, reason: options.reason, dryRun };
  if (sources !== undefined) body.sources = sources;
  if (options.before !== undefined) body.before = options.before;
  if (limit !== undefined) body.limit = limit;

  // **失敗を握り潰さない——例外はそのまま上（`index.ts` の
  // `program.parseAsync(...).catch(...)`）へ通す。** そこで stderr へ出て
  // `process.exit(1)` になる。ここで `catch` して stdout へ書いて正常 return
  // すると、400（絞り込みの間違い）でも 401/403（認証・許可）でも 5xx でも、
  // そもそも繋がらなかったときでさえ**終了コードが 0** になり、スクリプトや
  // cron から失敗を検知できない。**消す操作なので、「消えたのか消えなかった
  // のか」が終了コードから読めない形にしない。**
  // 既存の変更系（`reset.ts` / `access.ts` / `token.ts`）は全部この形である
  // （逐語は `grep -Fn -- 'if (described !== null) throw new Error(described);' apps/cli/src/reset.ts`）。
  // 読み取り専用の `dropped.ts` だけは HTTP の失敗を stdout へ書いて return
  // するが、あちらも「繋がらない」は同じく上へ通す（逐語は
  // `grep -Fn -- '繋がらない（ネットワークそのものの失敗）はここで握り潰さない。' apps/cli/src/dropped.ts`）。
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
      // **サーバの断り文言をそのまま出す**（`/archive remove` の 409 と同じ
      // 約束——「絞り込みが無いのと同じ呼び」「before が読めない」「limit が
      // 上限超え」の3種を CLI 側で言い換えると、サーバ側の文言が変わったとき
      // ここだけ古いままになる）。
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        errorBody.error ?? '受信箱の絞り込みが不正です（400）。1件も消していません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(`受信箱を畳めませんでした（${response.status}）`);
  }

  return (await response.json()) as InboxRemoveManyResult;
}

function report(result: InboxRemoveManyResult, dryRun: boolean, options: InboxRemoveOptions): void {
  stdout.write(
    `${dryRun ? '[試算] ' : ''}未読 ${result.totalPending} 件中 ${result.matched} 件が絞り込みに一致` +
      `（対象 ${result.targeted} 件、上限で持ち越し ${result.remaining} 件）\n`,
  );

  if (dryRun) {
    stdout.write('1件も消していません（試算）。実行するには --execute を付けてもう一度:\n');
    stdout.write(`  ${describeExecuteCommand(options)}\n`);
    return;
  }

  stdout.write(`消した id（${result.removedIds.length}件）:\n`);
  for (const id of result.removedIds) stdout.write(`  ${id}\n`);
}

/** 試算の結果に添える、そのまま打てる次の一手（`--execute` 付き）。 */
function describeExecuteCommand(options: InboxRemoveOptions): string {
  const parts = [
    'alteroid inbox remove',
    `--types ${options.types}`,
    ...(options.sources === undefined ? [] : [`--sources ${options.sources}`]),
    ...(options.before === undefined ? [] : [`--before ${options.before}`]),
    `--reason "${options.reason}"`,
    ...(options.limit === undefined ? [] : [`--limit ${options.limit}`]),
    '--execute',
  ];
  return parts.join(' ');
}
