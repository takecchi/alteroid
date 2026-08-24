import { stdout } from 'node:process';

import { createClient, type DaemonClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid conversations` — 会話（chat の履歴）の一覧・中身を読む。
 *
 * **`GET /conversations` と `GET /conversations/{id}` は既にあったが、CLI から
 * 到達できなかった。** Web（`apps/web/app/routes/chat.tsx` の一覧・
 * `apps/web/app/hooks/queries.ts` の `useConversation`）は使っているのに、
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
}

/** 1つの会話の中の1発言（`GET /conversations/:id` の要素）。 */
export interface ConversationMessage {
  id: string;
  at: string;
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: 'inbound' | 'outbound';
  text: string;
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
): Promise<void> {
  const client = await connect();
  if (client === null) return;
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
    stdout.write('会話の一覧を読めませんでした（--limit / --scan の値を確かめてください）\n');
    return;
  }
  const { conversations, scanned } = await response.json();
  // `renderConversationsList` は改行で終わらずに返す（末尾に改行が無いことは
  // `.claude/skills/mutation-testing/mutate-selftest.mjs` が固定している）。
  // 端末の次のプロンプトや後続の書き込みが最終行へ食い込まないよう、ここで足す（#326）。
  stdout.write(`${renderConversationsList(conversations, scanned)}\n`);
}

/**
 * 一覧を、人間が読める形へ。
 *
 * **`scanned` は常に出す。** デーモンは「窓の外はある」と言っているだけで
 * 「窓の外は無い」とは言っていない（一覧の応答に `reachedStart` は無い）。
 * ここを省くと、返ってきた件数が「これで全部」に見えてしまう。
 */
export function renderConversationsList(
  conversations: ConversationSummary[],
  scanned: number,
): string {
  const lines: string[] = [];
  if (conversations.length === 0) {
    lines.push('会話はまだありません。');
  } else {
    conversations.forEach((conversation, index) => {
      // **作成（`startedAt`）を足す。** 値は `GET /conversations` が元から
      // 返していて（`ConversationSummary` にも在る）、ここが出していな
      // かっただけである（#214）。
      lines.push(
        `  [${index + 1}] ${conversation.conversationId}` +
          `  作成: ${conversation.startedAt}  更新: ${conversation.updatedAt}` +
          `  (${conversation.messages}件)`,
      );
      lines.push(`      ${conversation.preview}`);
    });
  }
  lines.push('');
  lines.push(
    `（人間との往復を新しい方から ${scanned} 件見て集計した。これより古い会話・古い発言は窓の外に` +
      '残っているかもしれない（判定できない） — 広げるには --scan、表示件数を増やすには --limit）',
  );
  lines.push('中身を読むには: alteroid conversations show <id>');
  return lines.join('\n');
}

export interface ConversationsShowOptions {
  /**
   * 人間との往復をどこまで遡って探すか（デーモンの既定 2000、最大 10000）。
   * マネージャーとの往復・内部ターンは数えない（issue #418）。
   */
  scan?: string;
}

export async function conversationsShowCommand(
  id: string,
  options: ConversationsShowOptions = {},
): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.conversations[':id'].$get({
    param: { id },
    query: options.scan === undefined ? {} : { scan: options.scan },
  });
  if (response.status === 404) {
    // **遡り切れている場合だけ 404 が返る**（デーモン側の約束）。判定できない
    // ときは 200 に空の `messages` と `reachedStart: false` が来る。
    stdout.write(`そんな会話はありません: ${id}\n`);
    return;
  }
  if (!response.ok) {
    stdout.write('会話を読めませんでした（--scan の値を確かめてください）\n');
    return;
  }
  const { messages, scanned, reachedStart } = await response.json();
  // `renderConversationDetail` も改行で終わらずに返す（理由は上の
  // `renderConversationsList` の呼び出しと同じ。#326）。
  stdout.write(`${renderConversationDetail(id, messages, scanned, reachedStart)}\n`);
}

/**
 * 1つの会話の中身を、人間が読める形へ（古い順）。
 *
 * **「無い」と「判定できない」を混ぜない。** `messages` が空でも `reachedStart`
 * が偽なら、それは「発言が無かった」ではなく「この窓では見えなかった」である
 * （デーモン側の `conversationDetailResponseSchema` の注記どおり）。
 */
export function renderConversationDetail(
  id: string,
  messages: ConversationMessage[],
  scanned: number,
  reachedStart: boolean,
): string {
  const lines: string[] = [`── 会話 ${id} ──`];
  if (messages.length === 0) {
    lines.push(
      reachedStart
        ? '（発言はありません）'
        : '（この窓には発言が見つからなかった。窓の外に残っているかもしれない — 判定できない。' +
            '--scan を増やして確かめてください）',
    );
  } else {
    for (const message of messages) {
      const speaker = message.role === 'inbound' ? '人間' : 'クローン';
      lines.push(`  [${message.at}] ${speaker}: ${message.text}`);
    }
  }
  lines.push('');
  lines.push(
    reachedStart
      ? `（人間との往復を ${scanned} 件遡り、この会話の先頭まで届いた）`
      : `（人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い発言が残っている` +
          'かもしれない — 広げるには --scan）',
  );
  return lines.join('\n');
}

/**
 * 繋ぎ先を決めて型付きクライアントを作る。**繋げない理由はそのまま出す。**
 * `memory.ts` の同名関数と同じ理由（例外にすると人間向けの案内が例外の見た目になる）。
 */
async function connect(): Promise<DaemonClient | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return null;
  }
  return createClient(target.baseUrl, target.headers);
}
