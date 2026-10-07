/**
 * チャットの入力欄に書きかけの本文を、会話ごとに `sessionStorage` へ残す。
 *
 * **残すのは本文だけである**（ほかに、入力欄へ戻した文の印と、発言ごとの編集の書きかけを別の鍵で残す。
 * 下の `ChatDraftMark`・`StoredEditDraft`。承認カードの書きかけもログアウトで一緒に消す）。添付（`File` は保存できない）・承認カードの回答・編集の続きの状態は
 * 残さない。再読み込み・タブの破棄（スマホで別のアプリへ移ると起きやすい）からの復帰で、書きかけの
 * 本文を失わないためのもの。
 *
 * - 鍵は会話 id ごと（新しい会話＝id 無しは `new`）。1つの鍵に1つの本文
 * - **`sessionStorage`**（タブを閉じれば消える）。端末に平文で残す期間を短くするため。別タブには引き継がない
 * - 空にしたら鍵ごと消す。送信で空になれば消え、失敗して戻した文は書き直される
 * - ログアウト（資格情報を捨てるとき）に全部消す（`clearChatDrafts`。`storeCredential(…, null)` が呼ぶ）
 * - 保存先が使えない（無い・容量超過・禁止）ときは黙って何もしない。書きかけを残せないだけで、
 *   入力欄は今までどおり動く
 */

import type { MessageAttachment } from './types.js';

const PREFIX = 'alteroid.chatDraft:';
/** 入力欄へ戻した文の印（`unconfirmed`・`supersedes`・`clientMessageId`。#3708）。本文の鍵とは別の鍵で持つ。 */
const MARK_PREFIX = 'alteroid.chatDraftMark:';
/** 発言ごとの編集の書きかけ（#3707）。鍵は発言（`Line.key`）の id。 */
const EDIT_PREFIX = 'alteroid.editDraft:';
/**
 * 承認カードの書きかけ（#3706）。中身を読み書きするのは `approval-drafts.ts` で、ここは
 * ログアウトで消すために鍵だけを知る。
 */
export const APPROVAL_DRAFTS_KEY = 'alteroid.approvalDrafts';
/** 答えが通った承認に残した下書きの控え（`approval-leftovers.ts`）。同じ平文なので、一緒に消す。 */
const APPROVAL_LEFTOVERS_KEY = 'alteroid.approvalLeftovers';

/**
 * 全部消した回数（ログアウトのたびに増える）。間引きで書き出しを待っている側が、待っているあいだに
 * ログアウトされたかを見るための印——待ちが明けた後に書くと、消したはずの本文が書き戻る。
 */
let clearEpoch = 0;

export function chatDraftEpoch(): number {
  return clearEpoch;
}

function keyFor(conversationId: string | undefined): string {
  return `${PREFIX}${conversationId ?? 'new'}`;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 保存先へ触るだけで投げる環境（アクセスの禁止）。
    return null;
  }
}

/** 会話の書きかけの本文。無ければ `''`。 */
export function loadChatDraft(conversationId: string | undefined): string {
  try {
    return storage()?.getItem(keyFor(conversationId)) ?? '';
  } catch {
    return '';
  }
}

/** 書きかけの本文を残す。空（空白だけを含む）なら鍵ごと消す。 */
export function saveChatDraft(conversationId: string | undefined, text: string): void {
  const target = storage();
  if (target === null) return;
  try {
    if (text === '') target.removeItem(keyFor(conversationId));
    else target.setItem(keyFor(conversationId), text);
  } catch {
    // 容量超過など。残せないだけ。
  }
}

/** 入力欄へ戻した文の印。本文と一緒に残し、再読み込みの後も「送れたか確かめられなかった」案内と再送を出す（#3708）。 */
export interface ChatDraftMark {
  clientMessageId?: string;
  unconfirmed?: true;
  supersedes?: string;
  /**
   * 元の送信に添えていた添付の件数と名前（#3708）。ファイルの実体は残せないので、再読み込みの後に
   * 「戻せなかった」と言うための控え。無い（古い形）なら添付なしとして読む。
   */
  attachmentCount?: number;
  attachmentNames?: string[];
}

/** 保存した印を読む。無い・壊れている・知らない形のときは `undefined`（投げない）。 */
export function loadChatDraftMark(conversationId: string | undefined): ChatDraftMark | undefined {
  try {
    const raw = storage()?.getItem(`${MARK_PREFIX}${conversationId ?? 'new'}`);
    if (raw === null || raw === undefined) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { clientMessageId, unconfirmed, supersedes, attachmentCount, attachmentNames } =
      value as Record<string, unknown>;
    const mark: ChatDraftMark = {};
    if (typeof clientMessageId === 'string' && clientMessageId !== '') {
      mark.clientMessageId = clientMessageId;
    }
    if (unconfirmed === true) mark.unconfirmed = true;
    if (typeof supersedes === 'string' && supersedes !== '') mark.supersedes = supersedes;
    if (
      typeof attachmentCount === 'number' &&
      Number.isInteger(attachmentCount) &&
      attachmentCount > 0
    ) {
      mark.attachmentCount = attachmentCount;
      if (Array.isArray(attachmentNames)) {
        mark.attachmentNames = attachmentNames
          .filter((name): name is string => typeof name === 'string')
          .slice(0, 5);
      }
    }
    // 戻した文の印として意味があるのは、確かめられなかった送信か編集の続きだけ。
    return mark.unconfirmed === true || mark.supersedes !== undefined ? mark : undefined;
  } catch {
    return undefined;
  }
}

/** 印を残す。`undefined` なら鍵ごと消す。 */
export function saveChatDraftMark(
  conversationId: string | undefined,
  mark: ChatDraftMark | undefined,
): void {
  const target = storage();
  if (target === null) return;
  const key = `${MARK_PREFIX}${conversationId ?? 'new'}`;
  try {
    if (mark === undefined) target.removeItem(key);
    else target.setItem(key, JSON.stringify({ v: 1, ...mark }));
  } catch {
    // 容量超過など。
  }
}

/** 発言の編集の書きかけ（#3707）。本文と、引き継ぐ添付の控え。 */
export interface StoredEditDraft {
  text: string;
  attachments: MessageAttachment[];
  /**
   * 編集で足したファイル（`File`。保存できない）の名前（#3779）。再読み込みで実体は戻せないので、
   * 名前だけ残し、開き直したときに「外れた」と案内する。
   */
  lostNames?: string[];
}

function isAttachmentMeta(value: unknown): value is MessageAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.size === 'number';
}

function parseEditDraft(raw: string): StoredEditDraft | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { text, attachments, lostNames } = value as Record<string, unknown>;
    if (typeof text !== 'string') return undefined;
    const list = Array.isArray(attachments) ? attachments : [];
    if (!list.every(isAttachmentMeta)) return undefined;
    const lost = Array.isArray(lostNames) ? lostNames.filter((n) => typeof n === 'string') : [];
    return { text, attachments: list, ...(lost.length > 0 ? { lostNames: lost } : {}) };
  } catch {
    return undefined;
  }
}

/** 保存してある編集の書きかけを全部読む（発言の id → 書きかけ）。壊れた1件は飛ばす。 */
export function loadEditDrafts(): Map<string, StoredEditDraft> {
  const result = new Map<string, StoredEditDraft>();
  const target = storage();
  if (target === null) return result;
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key === null || !key.startsWith(EDIT_PREFIX)) continue;
      const raw = target.getItem(key);
      const parsed = raw === null ? undefined : parseEditDraft(raw);
      if (parsed !== undefined) result.set(key.slice(EDIT_PREFIX.length), parsed);
    }
  } catch {
    // 読めないぶんは無いものとして扱う。
  }
  return result;
}

/** 編集の書きかけを残す。`undefined` なら鍵ごと消す。 */
export function saveEditDraft(messageKey: string, draft: StoredEditDraft | undefined): void {
  const target = storage();
  if (target === null) return;
  try {
    if (draft === undefined) target.removeItem(`${EDIT_PREFIX}${messageKey}`);
    else target.setItem(`${EDIT_PREFIX}${messageKey}`, JSON.stringify(draft));
  } catch {
    // 容量超過など。
  }
}

/** 全会話の書きかけを消す（ログアウト）。 */
export function clearChatDrafts(): void {
  clearEpoch += 1;
  const target = storage();
  if (target === null) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (
        key !== null &&
        (key.startsWith(PREFIX) ||
          key.startsWith(MARK_PREFIX) ||
          key.startsWith(EDIT_PREFIX) ||
          key === APPROVAL_DRAFTS_KEY ||
          key === APPROVAL_LEFTOVERS_KEY)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) target.removeItem(key);
  } catch {
    // 保存先が使えない。何もしない。
  }
}
