import type { MessageAttachment } from './types.js';

// `sessionStorage` に置く: 端末に平文で残す期間を短くするため（別タブへは引き継がない）。
const PREFIX = 'alteroid.chatDraft:';
const MARK_PREFIX = 'alteroid.chatDraftMark:';
const EDIT_PREFIX = 'alteroid.editDraft:';
export const APPROVAL_DRAFTS_KEY = 'alteroid.approvalDrafts';
const APPROVAL_LEFTOVERS_KEY = 'alteroid.approvalLeftovers';

// ログアウトのたびに増やす: 間引きで書き出しを待っている側が、待つ間にログアウトされたと気づかないと、消したはずの本文が書き戻る。
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
    // 保存先へ触るだけで投げる環境がある。
    return null;
  }
}

export function loadChatDraft(conversationId: string | undefined): string {
  try {
    return storage()?.getItem(keyFor(conversationId)) ?? '';
  } catch {
    return '';
  }
}

export function saveChatDraft(conversationId: string | undefined, text: string): void {
  const target = storage();
  if (target === null) return;
  try {
    if (text === '') target.removeItem(keyFor(conversationId));
    else target.setItem(keyFor(conversationId), text);
  } catch {
    // 投げない: 残せなくても入力欄は動く。
  }
}

export interface ChatDraftMark {
  clientMessageId?: string;
  unconfirmed?: true;
  supersedes?: string;
  attachmentCount?: number;
  attachmentNames?: string[];
}

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
    return mark.unconfirmed === true || mark.supersedes !== undefined ? mark : undefined;
  } catch {
    return undefined;
  }
}

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
    // 投げない: 残せなくても入力欄は動く。
  }
}

/**
 * 入力欄に添えかけたファイルの件数と名前（#4019）。ファイルの実体は `sessionStorage` に置けないので、
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
  try {
    const raw = storage()?.getItem(`${PENDING_ATTACHMENTS_PREFIX}${conversationId ?? 'new'}`);
    if (raw === null || raw === undefined) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const { count, names } = value as Record<string, unknown>;
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return undefined;
    return {
      count,
      names: Array.isArray(names)
        ? names
            .filter((name): name is string => typeof name === 'string')
            .slice(0, PENDING_ATTACHMENT_NAMES_SHOWN)
        : [],
    };
  } catch {
    return undefined;
  }
}

export function savePendingAttachmentsNote(
  conversationId: string | undefined,
  note: PendingAttachmentsNote | undefined,
): void {
  const target = storage();
  if (target === null) return;
  const key = `${PENDING_ATTACHMENTS_PREFIX}${conversationId ?? 'new'}`;
  try {
    if (note === undefined || note.count <= 0) target.removeItem(key);
    else {
      target.setItem(
        key,
        JSON.stringify({
          v: 1,
          count: note.count,
          names: note.names.slice(0, PENDING_ATTACHMENT_NAMES_SHOWN),
        }),
      );
    }
  } catch {
    // 投げない: 残せなくても入力欄は動く。
  }
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
    // 投げない: 読めないぶんは無いものとして扱う。
  }
  return result;
}

export function saveEditDraft(messageKey: string, draft: StoredEditDraft | undefined): void {
  const target = storage();
  if (target === null) return;
  try {
    if (draft === undefined) target.removeItem(`${EDIT_PREFIX}${messageKey}`);
    else target.setItem(`${EDIT_PREFIX}${messageKey}`, JSON.stringify(draft));
  } catch {
    // 投げない: 残せなくても入力欄は動く。
  }
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
