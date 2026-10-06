/**
 * 承認に答えが通ったあとにも残った下書き（issue #3515）。
 *
 * 送るときに下書きを控え、答えが通ったとき「いまの下書きが控えと同じ」なら畳む。応答を待つ間に
 * 打ち足していたら、その分は消さずに残す。ただし承認はもう決着していて、未回答の一覧からは
 * 消えるので、残した下書きの行き場が要る。**どの承認の何を残したか**をここで持ち、画面が
 * 「送らなかった下書きが残っている」として見せる（写す・閉じる）。
 *
 * 承認の本文と設問は、一覧から消えたあとには引けない。残すと決めた時点で控える
 * （`ApprovalLeftoverSource`）。`sessionStorage` へも置く（タブを移っても、再読み込みでも消さない。
 * 置き場の方針は `approval-drafts.ts` と同じで、保存できなくても投げない）。
 */
import type { ApprovalDrafts, StoredQuestionsDraft } from './approval-drafts.js';
import { isEmptyQuestionsDraft } from './approval-drafts.js';

/** 設問の見え方（表示に要る分だけ。`ApprovalQuestion` から構造的に代入できる）。 */
export interface LeftoverQuestion {
  id: string;
  prompt: string;
  multiple?: boolean;
  options: readonly { id: string; label: string }[];
}

/** 決着した承認から控えるもの。 */
export interface ApprovalLeftoverSource {
  question: string;
  questions?: readonly LeftoverQuestion[];
}

/** 送った時点の下書き。 */
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

/**
 * 答えが通った承認 `id` の下書きを畳む。**いまの下書きが送った時点と同じ項目だけ**消し、違う項目
 * （応答を待つ間に打ち足したもの）は残す。項目は自由記述と設問のフォームの2つで、別々に見る。
 * 何も変わらなければ同じ参照を返す。
 */
export function settleApprovalDraft(
  current: ApprovalDrafts,
  id: string,
  sent: SentDraft,
): ApprovalDrafts {
  // 送ったあとに空へ戻した欄は、残すものが無いので畳む（空の項目を保存先に残さない）。
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

/** 残った下書きを、人間が読んで写せる文にする。残るものが無ければ空文字。 */
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

const KEY = 'alteroid.approvalLeftovers';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

/** 保存した控えを読む。無い・壊れている・読めないときは空（投げない）。壊れた1件で他を巻き込まない。 */
export function loadApprovalLeftoverSources(): ApprovalLeftoverSources {
  const result: ApprovalLeftoverSources = {};
  try {
    const raw = storage()?.getItem(KEY);
    if (raw === null || raw === undefined) return result;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return result;
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.question !== 'string') continue;
      const questions = Array.isArray(value.questions)
        ? value.questions.map(parseQuestion).filter((q): q is LeftoverQuestion => q !== null)
        : undefined;
      result[id] = { question: value.question, ...(questions === undefined ? {} : { questions }) };
    }
  } catch {
    // 壊れた JSON・読み出しの例外。空として扱う。
  }
  return result;
}

/** 控えを保存する。空なら項目ごと消す。保存できなくても投げない。 */
export function saveApprovalLeftoverSources(sources: ApprovalLeftoverSources): void {
  try {
    const store = storage();
    if (store === null) return;
    if (Object.keys(sources).length === 0) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(sources));
  } catch {
    // 容量超過・書き込み禁止。state だけで動く。
  }
}
