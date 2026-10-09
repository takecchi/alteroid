import { stdout } from './terminal-out.js';

import { attachmentLinesOf } from './attachments.js';
import { createClient, type DaemonClient } from './client.js';
import {
  approvalLine,
  approvalNoticeLines,
  fetchConversationApprovals,
  interleaveApprovals,
  type ConversationApprovalsRead,
} from './conversation-approvals.js';
import { defaultIo as defaultConfirmIo, type ConfirmIo } from './confirm.js';
import { errorReason, formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { redactBody } from './redact.js';
import { withdrawnMessageText } from './withdrawn-message.js';

/**
 * 黙って打ち切らない: 一覧も中身も日誌から組み立てていて遡り切れているとは限らないので、
 * 打ち切りを握り潰すと同じ欠陥の入口を作る。
 */

export interface ConversationSummary {
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  preview: string;
  unreadCount?: number;
}

export interface ConversationMessage {
  id: string;
  at: string;
  role: 'inbound' | 'outbound';
  text: string;
  delivery?: 'withdrawn';
  supersedes?: string;
  supersededBy?: string;
  attachments?: { id: string; name: string; mediaType: string; size: number }[];
}

export interface ConversationsListOptions {
  limit?: string;
  scan?: string;
  cursor?: string;
}

export async function conversationsListCommand(
  options: ConversationsListOptions = {},
  now: number = Date.now(),
): Promise<void> {
  const conn = await connect();
  if (conn === null) return;
  const { client, target } = conn;
  // `query` は常に渡す: hono/client の型は `.default()` 付きでも `query` キー自体を必須にする。
  const response = await client.conversations.$get({
    query: {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.scan === undefined ? {} : { scan: options.scan }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
  });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `会話の一覧を読めませんでした（HTTP ${String(response.status)}。--limit / --scan / --cursor の値を確かめてください）`,
        response,
      ),
    );
  }
  const { conversations, scanned, reachedStart, hiddenByLimit, nextCursor } = await response.json();
  // `renderConversationsList` は改行で終わらずに返す（`mutate-selftest.mjs` が固定している）ので、ここで足す。
  const unreadLine = await fetchUnreadTotalLine(client);
  stdout.write(
    `${unreadLine}\n${renderConversationsList(conversations, scanned, reachedStart, hiddenByLimit, now, nextCursor)}\n`,
  );
}

/**
 * 取れなかったときは数を 0 として出さず（「未読なし」と読める）、取れなかったと1行で言う。
 * 例外は投げない: 取れている一覧まで出なくなる。
 */
export async function fetchUnreadTotalLine(client: DaemonClient): Promise<string> {
  const unavailable = (reason: string): string =>
    `未読のある会話の総数は取れませんでした（${reason}）`;
  try {
    const response = await client.conversations['unread-count'].$get();
    if (response.status === 404) {
      return unavailable('このデーモンは総数の口を持たない。古い版かもしれない');
    }
    if (!response.ok) return unavailable(`HTTP ${String(response.status)}`);
    const body: Partial<Awaited<ReturnType<typeof response.json>>> = await response.json();
    if (typeof body.count !== 'number' || body.readStateUnreadable !== undefined) {
      return unavailable('既読の記録が読めないか、応答の形が想定と違う');
    }
    return body.capped === true
      ? `未読のある会話 ${body.count} 件以上（数え切れていない）`
      : `未読のある会話 ${body.count} 件`;
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `scanned` は常に出す: 省くと、返ってきた件数が「これで全部」に見えてしまう。
 * `reachedStart`（窓が日誌の先頭に届いたか）と `hiddenByLimit`（窓の中で `--limit` に収まらず落とした数）は別の条件。
 */
export function renderConversationsList(
  conversations: ConversationSummary[],
  scanned: number,
  reachedStart: boolean,
  hiddenByLimit: number,
  now: number = Date.now(),
  nextCursor?: string,
): string {
  const lines: string[] = [];
  if (conversations.length === 0) {
    lines.push('会話はまだありません。');
  } else {
    conversations.forEach((conversation, index) => {
      lines.push(
        `  [${index + 1}] ${conversation.conversationId}` +
          `  作成: ${conversation.startedAt}（${formatElapsedAgo(conversation.startedAt, now)}）` +
          `  更新: ${conversation.updatedAt}（${formatElapsedAgo(conversation.updatedAt, now)}）` +
          `  (${conversation.messages}件)` +
          unreadMark(conversation.unreadCount),
      );
      lines.push(`      ${redactBody(conversation.preview)}`);
    });
  }
  lines.push('');
  lines.push(
    `（人間との往復を新しい方から ${scanned} 件見て集計した。これより古い会話・古い発言は窓の外に` +
      '残っているかもしれない（判定できない） — 広げるには --scan、表示件数を増やすには --limit）',
  );
  // `reachedStart` が真のときは出さない: 常に出ているものになって情報でなくなる。
  if (!reachedStart) {
    lines.push(
      `（人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い会話が残っている` +
        'かもしれない）',
    );
  }
  if (hiddenByLimit > 0) {
    lines.push(
      `…ほか ${hiddenByLimit} 件は省略（この窓に ${conversations.length + hiddenByLimit} 件あり、` +
        `新しい順に ${conversations.length} 件だけ出した）。--limit を増やせば出る。`,
    );
  }
  if (nextCursor !== undefined) {
    lines.push(`続きを読むには: alteroid conversations list --cursor ${nextCursor}`);
  }
  lines.push('中身を読むには: alteroid conversations show <id>');
  return lines.join('\n');
}

export function unreadMark(unreadCount: number | undefined): string {
  return unreadCount !== undefined && unreadCount > 0 ? `  未読 ${unreadCount}` : '';
}

export interface ConversationsShowOptions {
  scan?: string;
  includeSuperseded?: boolean;
}

export async function conversationsShowCommand(
  id: string,
  options: ConversationsShowOptions = {},
): Promise<void> {
  const conn = await connect();
  if (conn === null) return;
  const { client, target } = conn;
  const response = await client.conversations[':id'].$get({
    param: { id },
    query: {
      ...(options.scan === undefined ? {} : { scan: options.scan }),
      ...(options.includeSuperseded === true ? { includeSuperseded: 'true' as const } : {}),
    },
  });
  if (response.status === 404) {
    throw new Error(`そんな会話はありません: ${id}`);
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `会話を読めませんでした（HTTP ${String(response.status)}。--scan の値を確かめてください）`,
        response,
      ),
    );
  }
  const { messages, scanned, reachedStart, supersededCount } = await response.json();
  const approvals = await fetchConversationApprovals(client, id);
  stdout.write(
    `${renderConversationDetail(id, messages, scanned, reachedStart, supersededCount, approvals)}\n`,
  );
}

/**
 * 「無い」と「判定できない」を混ぜない: `messages` が空でも `reachedStart` が偽なら「この窓では見えなかった」である。
 * `supersededCount` は `--include-superseded` によらず常に出す（0件なら出さない）: 出ないと畳まれた版の存在に気づけない。
 */
export function renderConversationDetail(
  id: string,
  messages: ConversationMessage[],
  scanned: number,
  reachedStart: boolean,
  supersededCount: number,
  approvals?: ConversationApprovalsRead,
): string {
  const lines: string[] = [`── 会話 ${id} ──`];
  const timeline = interleaveApprovals(messages, approvals?.approvals ?? []);
  if (timeline.length === 0) {
    lines.push(
      reachedStart
        ? '（発言はありません）'
        : '（この窓には発言が見つからなかった。窓の外に残っているかもしれない — 判定できない。' +
            '--scan を増やして確かめてください）',
    );
  } else {
    for (const item of timeline) {
      if (item.kind === 'approval') {
        lines.push(`  ${approvalLine(item.approval)}`);
        continue;
      }
      const message = item.message;
      const speaker = message.role === 'inbound' ? '人間' : 'クローン';
      const edit =
        message.supersededBy !== undefined
          ? `  [畳まれた版 — ${message.supersededBy} に置き換えられた]`
          : message.supersedes !== undefined
            ? `  [編集後の発言 — ${message.supersedes} を置き換えた]`
            : '';
      const body =
        message.delivery === 'withdrawn'
          ? withdrawnMessageText(redactBody(message.text))
          : redactBody(message.text);
      lines.push(`  [${message.at}] ${speaker} (id: ${message.id}): ${body}${edit}`);
      for (const line of attachmentLinesOf(message.attachments)) {
        lines.push(`      ${redactBody(line)}`);
      }
    }
  }
  lines.push('');
  for (const notice of approvalNoticeLines(approvals ?? { approvals: [], unreadable: [] })) {
    lines.push(notice);
  }
  lines.push(
    reachedStart
      ? `（人間との往復を ${scanned} 件遡り、この会話の先頭まで届いた）`
      : `（人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い発言が残っている` +
          'かもしれない — 広げるには --scan）',
  );
  if (supersededCount > 0) {
    lines.push(
      `（この会話にはチャットの編集で畳まれた版が ${supersededCount} 件ある。中身を読むには ` +
        '--include-superseded を付けてください）',
    );
  }
  return lines.join('\n');
}

/** 進めるのは、いま読み出した最新の発言まで: 読み出した後に届いた発言は未読のまま残る。 */
export async function conversationsReadCommand(id: string): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;
  const detail = await client.conversations[':id'].$get({ param: { id }, query: {} });
  if (detail.status === 404) throw new Error(`そんな会話はありません: ${id}`);
  if (!detail.ok) {
    const described = describeAuthFailure(detail.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`会話を読めませんでした（HTTP ${String(detail.status)}）`, detail),
    );
  }
  const body = await detail.json();
  const { messages } = body;
  const latest = messages[messages.length - 1];
  if (latest === undefined) {
    // 未読が無いと確かめられるときだけ成功で終える。残る・数えられないときは、既読にできていないので成功に見せない。
    const unread: unknown = body.unreadCount;
    if (unread === 0 && !('readStateUnreadable' in body)) {
      stdout.write(`未読の発言はありません: ${id}\n`);
      return;
    }
    throw new Error(
      '既読にする発言が見つかりませんでした（古すぎて見える範囲の外にあるのかもしれません。' +
        `alteroid conversations show ${id} --scan で範囲を広げて確かめてください）`,
    );
  }
  const response = await client.conversations[':id'].read.$post({
    param: { id },
    json: { through: latest.id },
  });
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`既読にできませんでした（HTTP ${String(response.status)}）`, response),
    );
  }
  const { unreadCount } = await response.json();
  stdout.write(
    unreadCount === 0
      ? `既読にしました: ${id}\n`
      : `既読にしました: ${id}（まだ未読が ${unreadCount} 件あります）\n`,
  );
}

const DELETE_WARNING = 'この会話の発言は、どの画面・クローンからも読めなくなる。元に戻せない。';

/**
 * 端末でないのに `--yes` が無いときは、消さずに非0で終える: パイプの中身を答えと取り違えて消さないため。
 */
export async function conversationsDeleteCommand(
  id: string,
  options: { yes?: boolean } = {},
  io: ConfirmIo = defaultConfirmIo(),
): Promise<void> {
  const conn = await connect('write');
  if (conn === null) return;
  const { client, target } = conn;

  if (options.yes !== true) {
    if (!io.isTTY) {
      throw new Error(
        `${DELETE_WARNING}\n端末ではなく対話で確認できないので、消しません（何も変更していません）。--yes を付けてください。`,
      );
    }
    const answer = await io.ask(`${DELETE_WARNING}消す? [y/N] `);
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
      io.write('取り消しました。何も変更していません。\n');
      return;
    }
  }

  const response = await client.conversations[':id'].$delete({ param: { id } });
  if (response.status === 404) {
    const reason = await errorReason(response);
    throw new Error(reason ?? `そんな会話はありません: ${id}`);
  }
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `会話を削除できませんでした（HTTP ${String(response.status)}）`,
        response,
      ),
    );
  }
  const result = await response.json();
  const lines = [
    `会話を削除しました: ${result.conversationId}`,
    `  読めなくした発言: ${String(result.hiddenCount)} 件`,
    `  消した添付: ${String(result.attachmentsRemoved)} 件`,
    `  消した台帳の約束: ${String(result.commitmentsRemoved)} 件`,
    `  受信箱から外した未処理の発言: ${String(result.queuedDropped)} 件`,
    `  この会話に結び付いた承認（外していない）: ${String(result.approvalsLinked)} 件`,
  ];
  if (result.incomplete.length > 0) {
    lines.push(
      '警告: 会話は読めなくなっていますが、次の後始末が終わっていません:',
      ...result.incomplete.map((item) => `  - ${item}`),
    );
  }
  if (result.remainsIn.length > 0) {
    lines.push(
      '消せずに、この会話の中身が残りうる場所:',
      ...result.remainsIn.map((item) => `  - ${item}`),
    );
  }
  stdout.write(`${lines.join('\n')}\n`);
}

/**
 * SSE は発言の id を運ばないので、返答が日誌に載った後に取り直して最後の発言を `through` にする。
 * 失敗しても投げない: 返答はもう表示してあり、既読にできなかったことで会話を奪わない。
 */
export async function markConversationReadAfterReply(
  target: Target,
  conversationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const options = signal === undefined ? undefined : { init: { signal } };
  try {
    const client = createClient(target.baseUrl, target.headers);
    const detail = await client.conversations[':id'].$get(
      {
        param: { id: conversationId },
        query: {},
      },
      options,
    );
    if (!detail.ok) {
      throw new Error(
        await withErrorReason(`会話を読めませんでした（HTTP ${String(detail.status)}）`, detail),
      );
    }
    const { messages } = await detail.json();
    const latest = messages.filter((m) => m.supersededBy === undefined).at(-1);
    if (latest === undefined) return;
    const response = await client.conversations[':id'].read.$post(
      {
        param: { id: conversationId },
        json: { through: latest.id },
      },
      options,
    );
    if (!response.ok) {
      throw new Error(
        await withErrorReason(
          `既読にできませんでした（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
  } catch (error) {
    if (signal?.aborted === true) return;
    const reason = error instanceof Error ? error.message : String(error);
    stdout.write(`  （この会話を既読にできませんでした: ${redactBody(reason)}）\n`);
  }
}

/** 読む口では繋げない理由を例外にしない: 人間向けの案内が例外の見た目になる。 */
async function connect(
  access: 'read' | 'write' = 'read',
): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    if (access === 'write') throw new Error(target.note);
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}
