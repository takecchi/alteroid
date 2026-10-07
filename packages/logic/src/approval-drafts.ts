import { APPROVAL_DRAFTS_KEY, chatDraftEpoch } from './chat-drafts.js';

// `@alteroid/ui` の `ApprovalQuestionsDraft` と同じ形を写す: logic は ui を import できないため。
export interface StoredQuestionDraft {
  chosen: string[];
  other: string;
  otherOn: boolean;
}

export interface StoredQuestionsDraft {
  drafts: Readonly<Record<string, StoredQuestionDraft>>;
  supplement: string;
}

export interface ApprovalDrafts {
  texts: Record<string, string>;
  questions: Record<string, StoredQuestionsDraft>;
}

const KEY = APPROVAL_DRAFTS_KEY;

export function emptyApprovalDrafts(): ApprovalDrafts {
  return { texts: {}, questions: {} };
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // アクセスしただけで投げる環境（クッキー無効など）がある。
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQuestionDraft(value: unknown): StoredQuestionDraft | null {
  if (!isRecord(value)) return null;
  const { chosen, other, otherOn } = value;
  if (!Array.isArray(chosen) || !chosen.every((c) => typeof c === 'string')) return null;
  if (typeof other !== 'string' || typeof otherOn !== 'boolean') return null;
  return { chosen: chosen as string[], other, otherOn };
}

function parseQuestionsDraft(value: unknown): StoredQuestionsDraft | null {
  if (!isRecord(value) || typeof value.supplement !== 'string' || !isRecord(value.drafts)) {
    return null;
  }
  const drafts: Record<string, StoredQuestionDraft> = {};
  for (const [questionId, raw] of Object.entries(value.drafts)) {
    const parsed = parseQuestionDraft(raw);
    if (parsed === null) return null;
    drafts[questionId] = parsed;
  }
  return { drafts, supplement: value.supplement };
}

export function isEmptyQuestionsDraft(draft: StoredQuestionsDraft): boolean {
  return draft.supplement === '' && Object.keys(draft.drafts).length === 0;
}

export function loadApprovalDrafts(): ApprovalDrafts {
  const result = emptyApprovalDrafts();
  try {
    const raw = storage()?.getItem(KEY);
    if (raw === null || raw === undefined) return result;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return result;
    if (isRecord(parsed.texts)) {
      for (const [id, text] of Object.entries(parsed.texts)) {
        if (typeof text === 'string' && text !== '') result.texts[id] = text;
      }
    }
    if (isRecord(parsed.questions)) {
      for (const [id, value] of Object.entries(parsed.questions)) {
        const draft = parseQuestionsDraft(value);
        if (draft !== null && !isEmptyQuestionsDraft(draft)) result.questions[id] = draft;
      }
    }
  } catch {
    // 投げない: 壊れていても呼ぶ側は空の下書きで動く。
  }
  return result;
}

// `epoch` がログアウトを挟んで古ければ何もしない: 消したはずの書きかけが書き戻らないようにするため。
export function saveApprovalDrafts(drafts: ApprovalDrafts, epoch?: number): void {
  if (epoch !== undefined && epoch !== chatDraftEpoch()) return;
  try {
    const store = storage();
    if (store === null) return;
    if (Object.keys(drafts.texts).length === 0 && Object.keys(drafts.questions).length === 0) {
      store.removeItem(KEY);
    } else {
      store.setItem(KEY, JSON.stringify(drafts));
    }
  } catch {
    // 投げない: 保存できなくても呼ぶ側は state だけで動く。
  }
}
