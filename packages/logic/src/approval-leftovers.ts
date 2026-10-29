import type { ApprovalDrafts, StoredQuestionsDraft } from './approval-drafts.js';
import {
  isEmptyQuestionsDraft,
  loadApprovalDrafts,
  saveApprovalDrafts,
} from './approval-drafts.js';
import {
  APPROVAL_LEFTOVERS_KEY,
  isRecord,
  readStoredRecord,
  writeStored,
} from './session-store.js';

export interface LeftoverQuestion {
  id: string;
  prompt: string;
  multiple?: boolean;
  options: readonly { id: string; label: string }[];
}

export interface ApprovalLeftoverSource {
  /**
   * 残った理由。無いときは自分の送信が通った場合。'conflict' は送ったが 409 で断られた場合、
   * 'gone' は送らないまま一覧から外れた場合で、文言を言い分けるために持つ。
   */
  origin?: 'conflict' | 'gone';
  question: string;
  questions?: readonly LeftoverQuestion[];
}

export interface SentDraft {
  text: string;
  questions?: StoredQuestionsDraft;
}

function sameQuestions(a: StoredQuestionsDraft | undefined, b: StoredQuestionsDraft | undefined) {
  const emptyA = a === undefined || isEmptyQuestionsDraft(a);
  const emptyB = b === undefined || isEmptyQuestionsDraft(b);
  if (emptyA || emptyB) return emptyA && emptyB;
  return JSON.stringify(a) === JSON.stringify(b);
}

// 送った時点と同じ項目だけ消し、応答を待つ間に打ち足した項目は残す: 打ち足しを黙って失わせないため。
export function settleApprovalDraft(
  current: ApprovalDrafts,
  id: string,
  sent: SentDraft,
): ApprovalDrafts {
  const text = current.texts[id];
  const keepText = text !== undefined && text !== '' && text !== sent.text;
  const form = current.questions[id];
  const keepQuestions =
    form !== undefined && !isEmptyQuestionsDraft(form) && !sameQuestions(form, sent.questions);
  const dropText = id in current.texts && !keepText;
  const dropQuestions = id in current.questions && !keepQuestions;
  if (!dropText && !dropQuestions) return current;
  const texts = { ...current.texts };
  const questions = { ...current.questions };
  if (dropText) delete texts[id];
  if (dropQuestions) delete questions[id];
  return { texts, questions };
}

/**
 * 保存してある下書き（sessionStorage）を、答えが通ったものとして畳む。
 * 画面の state を畳むだけでは、応答を待つ間に画面を離れていたとき（画面がアンマウント済み）保存側が送る前の
 * 下書きのまま残り、戻ったときに「送らなかった下書き」として出てしまう。`epoch` は送り始めた時点の
 * `chatDraftEpoch()`（ログアウトを挟んだら書き戻さない）。
 */
export function settleStoredApprovalDraft(id: string, sent: SentDraft, epoch?: number): void {
  const current = loadApprovalDrafts();
  const next = settleApprovalDraft(current, id, sent);
  if (next !== current) saveApprovalDrafts(next, epoch);
}

export function describeApprovalLeftover(
  source: ApprovalLeftoverSource,
  drafts: ApprovalDrafts,
  id: string,
): string {
  const parts: string[] = [];
  const text = drafts.texts[id];
  if (text !== undefined && text !== '') parts.push(text);
  const form = drafts.questions[id];
  if (form !== undefined && !isEmptyQuestionsDraft(form)) {
    const lines: string[] = [];
    const known = source.questions ?? [];
    const ids = [...known.map((q) => q.id), ...Object.keys(form.drafts)].filter(
      (value, index, all) => all.indexOf(value) === index,
    );
    for (const questionId of ids) {
      const draft = form.drafts[questionId];
      if (draft === undefined) continue;
      const question = known.find((q) => q.id === questionId);
      const single = question?.multiple !== true;
      const chosen = single && draft.otherOn ? [] : draft.chosen;
      const labels = chosen.map(
        (optionId) => question?.options.find((o) => o.id === optionId)?.label ?? optionId,
      );
      const other = draft.other.trim();
      if (labels.length === 0 && other === '') continue;
      lines.push(`${question?.prompt ?? questionId}`);
      if (labels.length > 0) lines.push(`  選んだ: ${labels.join(', ')}`);
      if (other !== '') lines.push(`  その他: ${other}`);
    }
    if (form.supplement.trim() !== '') lines.push(`補足: ${form.supplement}`);
    if (lines.length > 0) parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

export type ApprovalLeftoverSources = Record<string, ApprovalLeftoverSource>;

const KEY = APPROVAL_LEFTOVERS_KEY;

function parseQuestion(value: unknown): LeftoverQuestion | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.prompt !== 'string') {
    return null;
  }
  if (!Array.isArray(value.options)) return null;
  const options: { id: string; label: string }[] = [];
  for (const option of value.options) {
    if (!isRecord(option) || typeof option.id !== 'string' || typeof option.label !== 'string') {
      return null;
    }
    options.push({ id: option.id, label: option.label });
  }
  return {
    id: value.id,
    prompt: value.prompt,
    options,
    ...(typeof value.multiple === 'boolean' ? { multiple: value.multiple } : {}),
  };
}

export function loadApprovalLeftoverSources(): ApprovalLeftoverSources {
  const result: ApprovalLeftoverSources = {};
  // 投げない: 壊れていても呼ぶ側は空の控えで動く。
  const parsed = readStoredRecord(KEY);
  if (parsed === undefined) return result;
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value) || typeof value.question !== 'string') continue;
    const questions = Array.isArray(value.questions)
      ? value.questions.map(parseQuestion).filter((q): q is LeftoverQuestion => q !== null)
      : undefined;
    const origin = value.origin === 'conflict' || value.origin === 'gone' ? value.origin : null;
    result[id] = {
      ...(origin === null ? {} : { origin }),
      question: value.question,
      ...(questions === undefined ? {} : { questions }),
    };
  }
  return result;
}

export function saveApprovalLeftoverSources(sources: ApprovalLeftoverSources): void {
  writeStored(KEY, Object.keys(sources).length === 0 ? undefined : JSON.stringify(sources));
}
