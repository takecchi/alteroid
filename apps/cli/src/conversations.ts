import { stdout } from 'node:process';

import { attachmentLinesOf } from './attachments.js';
import { createClient, type DaemonClient } from './client.js';
import {
  approvalLine,
  approvalNoticeLines,
  fetchConversationApprovals,
  interleaveApprovals,
  type ConversationApprovalsRead,
} from './conversation-approvals.js';
import { formatElapsedAgo, withErrorReason } from './format.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { redactBody } from './redact.js';

/**
 * `alteroid conversations` — 会話（chat の履歴）の一覧・中身を読む。
 *
 * **`GET /conversations` と `GET /conversations/{id}` は既にあったが、CLI から
 * 到達できなかった。** Web（`apps/web/app/routes/chat.tsx` の一覧・
 * `packages/swr/src/hooks/queries.ts` の `useConversation`）は使っているのに、
 * `apps/cli/src` に `conversations` という文字列が0件だった。`docs/PRD.md`
 * 「インターフェース」は3面（CLI・HTTP API・Web UI）で同じことができると書いており、
 * 片方でしかできないことを作らない（north_star 禁止1）。
 *
 * 形は `alteroid memory`（同じ「一覧して、id で1件読む」の形）に合わせてある。
 *
 * **黙って打ち切らない。** どちらの経路も日誌から組み立てているので、遡り切れて
 * いるとは限らない（`apps/daemon/src/app.ts` の `scanned` / `reachedStart` の
 * 注記）。ここで打ち切りを黙って握り潰すと、直したつもりの入口に同じ欠陥
 * （#108 / #109 が塞いだもの）を作ることになる。
 */

/** 一覧に出す1件（`GET /conversations` の要素）。 */
export interface ConversationSummary {
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  preview: string;
  /** 未読の数（クローン側の発言だけ。無ければ未読なし）。 */
  unreadCount?: number;
}

/** 1つの会話の中の1発言（`GET /conversations/:id` の要素）。 */
export interface ConversationMessage {
  id: string;
  at: string;
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: 'inbound' | 'outbound';
  text: string;
  /**
   * この発言が置き換える、過去の人間の発言の id（編集後の発言が持つ）。
   * チャットの「メッセージを編集する」機能（issue #edit-message）。
   */
  supersedes?: string;
  /**
   * この発言を隠している編集の id（`includeSuperseded=true` のときだけ、
   * 畳まれた側に付く）。
   */
  supersededBy?: string;
  /** 発言に添えた添付のメタデータ（中身は `alteroid attachments get`）。 */
  attachments?: { id: string; name: string; mediaType: string; size: number }[];
}

export interface ConversationsListOptions {
  /** 返す最大件数（デーモンの既定 20、最大 200）。 */
  limit?: string;
  /**
   * 人間との往復をどこまで遡って集計するか（デーモンの既定 2000、最大
   * 10000）。マネージャーとの往復・内部ターンは数えない（issue #418）。
   */
  scan?: string;
}

export async function conversationsListCommand(
  options: ConversationsListOptions = {},
  now: number = Date.now(),
): Promise<void> {
  const conn = await connect();
  if (conn === null) return;
  const { client, target } = conn;
  // **`query` は常に渡す。** 型上は省略できない（デーモン側のクエリ検査が
  // `.default()` 付きでも hono/client の型は `query` キー自体を必須にする）。
  // 中身が空でも URL に意味の無い `?` が付くだけで、サーバ側には無害である。
  const response = await client.conversations.$get({
    query: {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.scan === undefined ? {} : { scan: options.scan }),
    },
  });
  if (!response.ok) {
    // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#2856）。
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(
        `会話の一覧を読めませんでした（HTTP ${String(response.status)}。--limit / --scan の値を確かめてください）`,
        response,
      ),
    );
  }
  const { conversations, scanned, reachedStart, hiddenByLimit } = await response.json();
  // `renderConversationsList` は改行で終わらずに返す（末尾に改行が無いことは
  // `.claude/skills/mutation-testing/mutate-selftest.mjs` が固定している）。
  // 端末の次のプロンプトや後続の書き込みが最終行へ食い込まないよう、ここで足す（#326）。
  // **総数の取得は一覧の後で、失敗しても一覧を奪わない。** 一覧は `--limit` の外の
  // 会話を数えない。Web の左ナビのバッジと同じ数（`GET /conversations/unread-count`）を
  // 見出しに1行足す。
  const unreadLine = await fetchUnreadTotalLine(client);
  stdout.write(
    `${unreadLine}\n${renderConversationsList(conversations, scanned, reachedStart, hiddenByLimit, now)}\n`,
  );
}

/**
 * 「未読のある会話 N 件」の1行（Web の左ナビのバッジ `shell.tsx` と同じ数・同じ意味）。
 *
 * **取れなかったときは黙らず、取れなかったと1行で言う**（数を 0 として出さない——「未読なし」と
 * 読める）。ここで例外を投げると、取れている一覧まで出なくなる（一過性の失敗で一覧を奪わない）ので
 * 投げない。古いデーモンは 404 を返す（口が無い）ので、それも一覧を壊さず1行で言う。
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
    // Web と同じく、形の違う応答・既読の記録が読めない旨の応答は「読めていない」側へ倒す。
    if (typeof body.count !== 'number' || body.readStateUnreadable !== undefined) {
      return unavailable('既読の記録が読めないか、応答の形が想定と違う');
    }
    // `capped` のときの `count` は下限（Web は「N+」）。
    return body.capped === true
      ? `未読のある会話 ${body.count} 件以上（数え切れていない）`
      : `未読のある会話 ${body.count} 件`;
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 一覧を、人間が読める形へ。
 *
 * **`scanned` は常に出す。** デーモンは「窓の外はある」と言っているだけで
 * 「窓の外は無い」とは言っていない。ここを省くと、返ってきた件数が
 * 「これで全部」に見えてしまう。
 *
 * **`reachedStart` / `hiddenByLimit` も出す（#418 の裏返し）。** どちらも
 * サーバ（`GET /conversations`）とクローンの道具（`conversation_read`）は
 * 既に言っているのに、CLI だけが黙っていると端末では気づけなくなる
 * （「片方でしかできないこと」を作らないのが PRD「インターフェース」の
 * 要件）。`reachedStart` は窓（`scan`）が日誌の先頭に届いたか、
 * `hiddenByLimit` はその窓の**中で** `--limit` に収まらず落とした会話の数
 * （窓の外は数えていない）。2つは別の条件なので、両方出ることも片方だけの
 * こともある。
 */
export function renderConversationsList(
  conversations: ConversationSummary[],
  scanned: number,
  reachedStart: boolean,
  hiddenByLimit: number,
  now: number = Date.now(),
): string {
  const lines: string[] = [];
  if (conversations.length === 0) {
    lines.push('会話はまだありません。');
  } else {
    conversations.forEach((conversation, index) => {
      // **作成（`startedAt`）を足す。** 値は `GET /conversations` が元から
      // 返していて（`ConversationSummary` にも在る）、ここが出していな
      // かっただけである（#214）。
      // **経過（issue #2141 段1）を、作成・更新それぞれの横に添える。** ISO は
      // そのまま残す。
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
  // **`reachedStart` が真のときは出さない。** 窓が先頭に届いているなら、
  // そこに但し書きを出すと「常に出ているもの」になって情報でなくなる
  // （`apps/web/app/routes/chat.tsx` の `ChatPane` と同じ判断）。
  if (!reachedStart) {
    lines.push(
      `（人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い会話が残っている` +
        'かもしれない）',
    );
  }
  // **`hiddenByLimit > 0` のときだけ出す。** 語彙はクローンの道具（`tools.ts`
  // の「…ほか N 件は省略」）に寄せる。
  if (hiddenByLimit > 0) {
    lines.push(
      `…ほか ${hiddenByLimit} 件は省略（この窓に ${conversations.length + hiddenByLimit} 件あり、` +
        `新しい順に ${conversations.length} 件だけ出した）。--limit を増やせば出る。`,
    );
  }
  lines.push('中身を読むには: alteroid conversations show <id>');
  return lines.join('\n');
}

/** 未読があるときだけ付ける小さな印。 */
export function unreadMark(unreadCount: number | undefined): string {
  return unreadCount !== undefined && unreadCount > 0 ? `  未読 ${unreadCount}` : '';
}

export interface ConversationsShowOptions {
  /**
   * 人間との往復をどこまで遡って探すか（デーモンの既定 2000、最大 10000）。
   * マネージャーとの往復・内部ターンは数えない（issue #418）。
   */
  scan?: string;
  /**
   * チャットの編集で既定ビューから畳まれた旧発言・その応答も含めて読むか
   * （issue「チャットの送信済みメッセージを編集する」。制約(A)——`conversation_read`
   * だけでなく、この口からも畳まれた版へ届く必要がある）。既定は含めない
   * （デーモンの既定と同じ）。
   */
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
      // **`true` のときだけ渡す。** デーモンの既定（`false`）と1バイトも
      // 違わない応答を、渡さなかった呼び出し全部に配り続ける。
      ...(options.includeSuperseded === true ? { includeSuperseded: 'true' as const } : {}),
    },
  });
  if (response.status === 404) {
    // **遡り切れている場合だけ 404 が返る**（デーモン側の約束）。判定できない
    // ときは 200 に空の `messages` と `reachedStart: false` が来る。
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
  // その会話のターンから積まれた承認を時刻順の位置に出す（#3261）。**取れなくても会話は出す。**
  const approvals = await fetchConversationApprovals(client, id);
  // `renderConversationDetail` も改行で終わらずに返す（理由は上の
  // `renderConversationsList` の呼び出しと同じ。#326）。
  stdout.write(
    `${renderConversationDetail(id, messages, scanned, reachedStart, supersededCount, approvals)}\n`,
  );
}

/**
 * 1つの会話の中身を、人間が読める形へ（古い順）。
 *
 * **「無い」と「判定できない」を混ぜない。** `messages` が空でも `reachedStart`
 * が偽なら、それは「発言が無かった」ではなく「この窓では見えなかった」である
 * （デーモン側の `conversationDetailResponseSchema` の注記どおり）。
 *
 * **`supersededCount` は `--include-superseded` の値によらず常に出す**
 * （0件なら出さない）。制約(A)——出ないと、この会話に編集で畳まれた版が
 * 在ることに、人間の側の器も気づけなくなる。
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
      // **どれが畳まれた版で、どの編集に置き換えられたかを読める形にする。**
      // `--include-superseded` を付けたときだけ、どちらかが付きうる
      // （デーモン側の約束。両方付くことは無い——`supersedes` は編集後の
      // 発言、`supersededBy` は畳まれた側が持つ）。
      const edit =
        message.supersededBy !== undefined
          ? `  [畳まれた版 — ${message.supersededBy} に置き換えられた]`
          : message.supersedes !== undefined
            ? `  [編集後の発言 — ${message.supersedes} を置き換えた]`
            : '';
      // **id を出す。** 編集（`supersedes`）の対象を指すのに要る。
      lines.push(
        `  [${message.at}] ${speaker} (id: ${message.id}): ${redactBody(message.text)}${edit}`,
      );
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

/**
 * `alteroid conversations read <id>` — 会話を、いちばん新しい発言まで既読にする。
 *
 * 既読の位置は全員で1組で、Web の画面と同じものを進める（入口によって未読が違って見えない）。
 * **進めるのは、いま読み出した最新の発言まで**——読み出した後に届いた発言は未読のまま残る。
 */
export async function conversationsReadCommand(id: string): Promise<void> {
  const conn = await connect();
  if (conn === null) return;
  const { client, target } = conn;
  const detail = await client.conversations[':id'].$get({ param: { id }, query: {} });
  // 失敗は例外で上へ通す（＝終了コードが 0 でなくなる。#2856 の `show` と同じ）。
  if (detail.status === 404) throw new Error(`そんな会話はありません: ${id}`);
  if (!detail.ok) {
    const described = describeAuthFailure(detail.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(
      await withErrorReason(`会話を読めませんでした（HTTP ${String(detail.status)}）`, detail),
    );
  }
  const { messages } = await detail.json();
  const latest = messages[messages.length - 1];
  if (latest === undefined) {
    stdout.write(
      '既読にする発言が見つかりませんでした（古すぎて見える範囲の外にあるのかもしれません。' +
        `alteroid conversations show ${id} --scan で範囲を広げて確かめてください）\n`,
    );
    return;
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

/**
 * `alteroid chat`（REPL）が返答を表示し終えたとき、その会話を既読にする
 * （`docs/architecture.md`「会話の既読」の「送信して返答が画面に表示されたとき」）。
 *
 * Web（`useMarkConversationRead`）と同じ意味にしてある: SSE は発言の id を運ばないので、
 * 返答が日誌に載った後に `GET /conversations/:id` を取り直し、既定ビューの最後の発言
 * （編集で畳まれた `supersededBy` 付きは除く）を `through` に `POST /conversations/:id/read` する。
 * 時刻はサーバが引く。
 *
 * **失敗しても投げない。** 返答はもう表示してあり、既読にできなかったことで会話を奪わない。
 * 黙って捨てず、1行だけ出す（次の返答で、また試す）。
 */
export async function markConversationReadAfterReply(
  target: Target,
  conversationId: string,
): Promise<void> {
  try {
    const client = createClient(target.baseUrl, target.headers);
    const detail = await client.conversations[':id'].$get({
      param: { id: conversationId },
      query: {},
    });
    if (!detail.ok) {
      throw new Error(
        await withErrorReason(`会話を読めませんでした（HTTP ${String(detail.status)}）`, detail),
      );
    }
    const { messages } = await detail.json();
    const latest = messages.filter((m) => m.supersededBy === undefined).at(-1);
    if (latest === undefined) return;
    const response = await client.conversations[':id'].read.$post({
      param: { id: conversationId },
      json: { through: latest.id },
    });
    if (!response.ok) {
      throw new Error(
        await withErrorReason(
          `既読にできませんでした（HTTP ${String(response.status)}）`,
          response,
        ),
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    stdout.write(`  （この会話を既読にできませんでした: ${redactBody(reason)}）\n`);
  }
}

/**
 * 繋ぎ先を決めて型付きクライアントを作る。**繋げない理由はそのまま出す。**
 * `memory.ts` の同名関数と同じ理由（例外にすると人間向けの案内が例外の見た目になる）。
 */
async function connect(): Promise<{ client: DaemonClient; target: Target } | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return null;
  }
  return { client: createClient(target.baseUrl, target.headers), target };
}
