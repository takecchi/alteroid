import {
  APPROVAL_LEFTOVERS_KEY,
  draftKey,
  readStoredRecord,
  storage,
  writeStored,
} from './session-store.js';
import type { MessageAttachment } from './types.js';

// `sessionStorage` に置く: 端末に平文で残す期間を短くするため（別タブへは引き継がない）。
const PREFIX = 'alteroid.chatDraft:';
const MARK_PREFIX = 'alteroid.chatDraftMark:';
const EDIT_PREFIX = 'alteroid.editDraft:';
export const APPROVAL_DRAFTS_KEY = 'alteroid.approvalDrafts';

// ログアウトのたびに増やす: 間引きで書き出しを待っている側が、待つ間にログアウトされたと気づかないと、消したはずの本文が書き戻る。
let clearEpoch = 0;

export function chatDraftEpoch(): number {
  return clearEpoch;
}

function keyFor(conversationId: string | undefined): string {
  return draftKey(PREFIX, conversationId);
}

export function loadChatDraft(conversationId: string | undefined): string {
  try {
    return storage()?.getItem(keyFor(conversationId)) ?? '';
  } catch {
    return '';
  }
}

export function saveChatDraft(conversationId: string | undefined, text: string): void {
  writeStored(keyFor(conversationId), text === '' ? undefined : text);
}

export interface ChatDraftMark {
  clientMessageId?: string;
  unconfirmed?: true;
  supersedes?: string;
  /** 戻せなかった（実体を失った）添付の件数と名前。 */
  attachmentCount?: number;
  attachmentNames?: string[];
  /**
   * 編集の続き（`supersedes`）で、すでにサーバにある添付（元の発言から引き継いだ分・上げ終えた分）の控え。
   * `File` が無くても id で戻せる（`StoredEditDraft` と同じ形）。件数と名前の欄は戻せなかった側。
   */
  attachments?: MessageAttachment[];
}

export function loadChatDraftMark(conversationId: string | undefined): ChatDraftMark | undefined {
  const value = readStoredRecord(draftKey(MARK_PREFIX, conversationId));
  if (value === undefined) return undefined;
  const {
    clientMessageId,
    unconfirmed,
    supersedes,
    attachmentCount,
    attachmentNames,
    attachments,
  } = value;
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
  if (
    mark.supersedes !== undefined &&
    Array.isArray(attachments) &&
    attachments.length > 0 &&
    attachments.every(isAttachmentMeta)
  ) {
    mark.attachments = attachments;
  }
  return mark.unconfirmed === true || mark.supersedes !== undefined ? mark : undefined;
}

export function saveChatDraftMark(
  conversationId: string | undefined,
  mark: ChatDraftMark | undefined,
): void {
  writeStored(
    draftKey(MARK_PREFIX, conversationId),
    mark === undefined ? undefined : JSON.stringify({ v: 1, ...mark }),
  );
}

/**
 * 入力欄に添えかけたファイルの件数と名前。ファイルの実体は `sessionStorage` に置けないので、
 * 再読み込みで失ったときに「何件失ったか」を言うためだけに控える。**送信の印（`ChatDraftMark`）とは別の鍵にする**:
 * 印は本文の書きかけが在るときだけ戻す決まりで、添えかけは本文が空でも在る。
 */
export interface PendingAttachmentsNote {
  count: number;
  names: string[];
}

const PENDING_ATTACHMENTS_PREFIX = 'alteroid.chatPendingAttachments:';
const PENDING_ATTACHMENT_NAMES_SHOWN = 5;

export function loadPendingAttachmentsNote(
  conversationId: string | undefined,
): PendingAttachmentsNote | undefined {
  const value = readStoredRecord(draftKey(PENDING_ATTACHMENTS_PREFIX, conversationId));
  if (value === undefined) return undefined;
  const { count, names } = value;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return undefined;
  return {
    count,
    names: Array.isArray(names)
      ? names
          .filter((name): name is string => typeof name === 'string')
          .slice(0, PENDING_ATTACHMENT_NAMES_SHOWN)
      : [],
  };
}

export function savePendingAttachmentsNote(
  conversationId: string | undefined,
  note: PendingAttachmentsNote | undefined,
): void {
  writeStored(
    draftKey(PENDING_ATTACHMENTS_PREFIX, conversationId),
    note === undefined || note.count <= 0
      ? undefined
      : JSON.stringify({
          v: 1,
          count: note.count,
          names: note.names.slice(0, PENDING_ATTACHMENT_NAMES_SHOWN),
        }),
  );
}

export interface StoredEditDraft {
  text: string;
  attachments: MessageAttachment[];
  lostNames?: string[];
}

function isAttachmentMeta(value: unknown): value is MessageAttachment {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.size === 'number';
}

function parseEditDraft(value: Record<string, unknown>): StoredEditDraft | undefined {
  const { text, attachments, lostNames } = value;
  if (typeof text !== 'string') return undefined;
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.every(isAttachmentMeta)) return undefined;
  const lost = Array.isArray(lostNames) ? lostNames.filter((n) => typeof n === 'string') : [];
  return { text, attachments: list, ...(lost.length > 0 ? { lostNames: lost } : {}) };
}

export function loadEditDrafts(): Map<string, StoredEditDraft> {
  const result = new Map<string, StoredEditDraft>();
  const target = storage();
  if (target === null) return result;
  try {
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key === null || !key.startsWith(EDIT_PREFIX)) continue;
      const record = readStoredRecord(key);
      const parsed = record === undefined ? undefined : parseEditDraft(record);
      if (parsed !== undefined) result.set(key.slice(EDIT_PREFIX.length), parsed);
    }
  } catch {
    // 投げない: 読めないぶんは無いものとして扱う。
  }
  return result;
}

export function saveEditDraft(messageKey: string, draft: StoredEditDraft | undefined): void {
  writeStored(
    `${EDIT_PREFIX}${messageKey}`,
    draft === undefined ? undefined : JSON.stringify(draft),
  );
}

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
          key.startsWith(PENDING_ATTACHMENTS_PREFIX) ||
          key.startsWith(EDIT_PREFIX) ||
          key === APPROVAL_DRAFTS_KEY ||
          key === APPROVAL_LEFTOVERS_KEY)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) target.removeItem(key);
  } catch {
    // 投げない: 保存先が使えないなら消すものも無い。
  }
}
