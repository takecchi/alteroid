/**
 * 承認待ちの回答の下書き（自由記述と設問の選択）を、承認の id ごとに `sessionStorage` へ置く
 * （issue #3295）。
 *
 * ページの state だけに持つと、「回答済み」タブへ移った時点で画面ごと unmount されて、
 * 書きかけが黙って消える。**使い手の書いたものを黙って失わせない**ための置き場である。
 * 再読み込みでは残り、タブを閉じれば消える（`sessionStorage` に留める理由は `auth.ts` と同じ）。
 *
 * **保存できない環境（`sessionStorage` が無い・例外を投げる・容量超過）でも投げない。**
 * 読めなければ空、書けなければ黙って諦める（呼ぶ側は今までどおり state だけで動く）。
 *
 * 設問の書きかけの型は `@alteroid/ui` のもの（`ApprovalQuestionsDraft`）と同じ形だが、
 * logic は ui を import できないので、形だけをここに写している（構造的に代入できる）。
 */

import { APPROVAL_DRAFTS_KEY, chatDraftEpoch } from './chat-drafts.js';

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
  /** 自由記述の回答。id → 本文（空文字は持たない）。 */
  texts: Record<string, string>;
  /** 設問の選択。id → 書きかけ（何も書いていないものは持たない）。 */
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
    // アクセスしただけで投げる環境（クッキー無効など）。
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

/** 何も書いていない設問の書きかけか。 */
export function isEmptyQuestionsDraft(draft: StoredQuestionsDraft): boolean {
  return draft.supplement === '' && Object.keys(draft.drafts).length === 0;
}

/** 保存した下書きを読む。無い・壊れている・読めないときは空（投げない）。壊れた1件で他を巻き込まない。 */
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
    // 壊れた JSON・読み出しの例外。空として扱う。
  }
  return result;
}

/**
 * 下書きを保存する。空なら項目ごと消す。保存できなくても投げない。
 *
 * `epoch` — この書き込みを決めた時点の `chatDraftEpoch()`。ログアウト（`clearChatDrafts`）を
 * 挟んだなら、消したはずの書きかけが書き戻らないよう、何もしない（#3706）。
 */
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
    // 容量超過・書き込み禁止。state だけで動く。
  }
}
